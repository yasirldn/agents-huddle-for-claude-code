import { baseName, clip, describeRequest, describeTool } from "./describe.js";

const MAX_STEPS = 30;
const SHOWN_STEPS = 6;
const MOODS = { read: "look", search: "look", web: "look", edit: "type", shell: "type" };

const firstLine = (text) => String(text ?? "").split(/\r?\n/).find((line) => line.trim()) ?? "";

function tail(text, count) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-count)
    .map((line) => (line.length > 160 ? line.slice(0, 159) + "…" : line));
}

// Holds every agent session the widget knows about and turns hook events into
// the state the interface draws. It has no knowledge of windows or pipes.
export class Huddle {
  constructor({ now = Date.now, autoHideMs = 20 * 60_000, staleMs = 12 * 3_600_000 } = {}) {
    this.now = now;
    this.autoHideMs = autoHideMs;
    this.staleMs = staleMs;
    this.sessions = new Map();
    this.requests = new Map();
    this.listeners = new Set();
    this.figureSeq = 0;
    this.requestSeq = 0;
    this.stepSeq = 0;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit() {
    for (const listener of this.listeners) listener();
  }

  upsert(event, at) {
    let session = this.sessions.get(event.session_id);
    if (!session) {
      session = {
        id: event.session_id,
        n: this.figureSeq++,
        cwd: event.cwd ?? "",
        title: "",
        namedBySession: false,
        phase: "idle",
        kind: "idle",
        activity: "Ready",
        startedAt: at,
        promptAt: 0,
        stoppedAt: 0,
        lastEventAt: at,
        stepCount: 0,
        tasks: [],
        taskSeq: 0,
        steps: [],
        finished: [],
        terminal: null,
        subagents: 0,
        lastMessage: "",
        waitingInTab: false,
        hidden: false,
      };
      this.sessions.set(session.id, session);
    }
    session.lastEventAt = at;
    if (event.cwd) session.cwd = event.cwd;
    if (event.session_title) {
      session.title = clip(event.session_title, 80);
      session.namedBySession = true;
    }
    return session;
  }

  requestsFor(sessionId) {
    return [...this.requests.values()].filter((request) => request.sessionId === sessionId).sort((a, b) => a.createdAt - b.createdAt);
  }

  // Applies one hook event. Returns the ids of held requests that the event shows
  // were settled somewhere else, so the caller can release them.
  apply(event) {
    const name = event?.hook_event_name;
    if (!event?.session_id || !name) return [];
    const at = this.now();

    if (name === "SessionEnd") {
      const closed = this.requestsFor(event.session_id).map((request) => request.id);
      this.sessions.delete(event.session_id);
      this.emit();
      return closed;
    }

    const session = this.upsert(event, at);
    const sent = Number(event.huddle_at) || at;
    const closed = [];

    if (name === "SessionStart") {
      if (event.source === "clear") Object.assign(session, { title: "", namedBySession: false, tasks: [], steps: [], terminal: null, stepCount: 0 });
      if (event.source !== "compact") Object.assign(session, { phase: "idle", kind: "idle", activity: "Ready" });
    } else if (name === "UserPromptSubmit") {
      if (!session.title) session.title = clip(firstLine(event.prompt), 80);
      Object.assign(session, { phase: "working", kind: "think", activity: "Thinking", promptAt: at, stoppedAt: 0, stepCount: 0, hidden: false, waitingInTab: false, lastMessage: "" });
      closed.push(...this.requestsFor(session.id).map((request) => request.id));
    } else if (name === "PreToolUse") {
      const { kind, label } = describeTool(event.tool_name, event.tool_input);
      // Background hooks can arrive out of order. A start that was sent before
      // the session stopped must not mark it as working again.
      const late = session.stoppedAt && sent < session.stoppedAt;
      if (!late) Object.assign(session, { phase: "working", kind, activity: label, waitingInTab: false });
      session.stepCount += 1;
      const id = event.tool_use_id ?? `step-${++this.stepSeq}`;
      const outcome = session.finished.find((item) => item.id === id);
      session.steps.push({ id, kind, label, status: outcome ? outcome.status : late ? "done" : "running" });
      if (session.steps.length > MAX_STEPS) session.steps.splice(0, session.steps.length - MAX_STEPS);
      if (kind === "shell" && !outcome) session.terminal = { command: clip(event.tool_input?.command, 240), lines: [] };
    } else if (name === "PostToolUse" || name === "PostToolUseFailure") {
      session.waitingInTab = false;
      const status = name === "PostToolUse" ? "done" : "failed";
      const step = session.steps.find((item) => item.id === event.tool_use_id);
      if (step) step.status = status;
      else if (event.tool_use_id) {
        session.finished.push({ id: event.tool_use_id, status });
        if (session.finished.length > MAX_STEPS) session.finished.shift();
      }
      if (name === "PostToolUse") this.applyTaskTool(session, event);
      if (event.tool_name === "Bash" || event.tool_name === "PowerShell") {
        const response = event.tool_response ?? {};
        const output = typeof response === "string" ? response : [response.stdout, response.stderr].filter(Boolean).join("\n");
        session.terminal = { command: clip(event.tool_input?.command, 240), lines: tail(output, 4) };
      }
      closed.push(...this.settledElsewhere(session.id, event));
    } else if (name === "Notification") {
      const type = event.notification_type;
      if ((type === "permission_prompt" || type === "elicitation_dialog") && this.requestsFor(session.id).length === 0) {
        session.waitingInTab = true;
        session.hidden = false;
      } else if (type === "idle_prompt" && session.phase === "working" && this.requestsFor(session.id).length === 0) {
        // A run stopped by hand sends no stop event, only this after a quiet minute.
        Object.assign(session, { phase: "idle", kind: "idle", activity: "Waiting for your next message", waitingInTab: false });
        for (const step of session.steps) if (step.status === "running") step.status = "done";
      }
    } else if (name === "Stop" || name === "StopFailure") {
      const failed = name === "StopFailure";
      Object.assign(session, {
        phase: "done",
        kind: "done",
        activity: failed ? "Stopped by an error" : "Finished",
        stoppedAt: sent,
        waitingInTab: false,
        lastMessage: failed ? "" : clip(event.last_assistant_message, 200),
      });
      for (const step of session.steps) if (step.status === "running") step.status = failed ? "failed" : "done";
      closed.push(...this.requestsFor(session.id).map((request) => request.id));
    } else if (name === "SubagentStart") {
      session.subagents += 1;
    } else if (name === "SubagentStop") {
      session.subagents = Math.max(0, session.subagents - 1);
    }

    this.emit();
    return closed;
  }

  applyTaskTool(session, event) {
    const input = event.tool_input ?? {};
    const response = event.tool_response ?? {};
    if (event.tool_name === "TodoWrite" && Array.isArray(input.todos)) {
      session.tasks = input.todos.map((todo, index) => ({
        id: String(index + 1),
        label: clip(todo.content, 80),
        activeLabel: clip(todo.activeForm || todo.content, 80),
        status: todo.status ?? "pending",
      }));
    } else if (event.tool_name === "TaskCreate" && input.subject) {
      // A new task after everything was finished starts a fresh plan.
      if (session.tasks.length && session.tasks.every((task) => task.status === "completed")) session.tasks = [];
      session.taskSeq += 1;
      const id = String(response.task?.id ?? response.id ?? session.taskSeq);
      if (!session.tasks.some((task) => task.id === id)) {
        session.tasks.push({ id, label: clip(input.subject, 80), activeLabel: clip(input.activeForm || input.subject, 80), status: "pending" });
      }
    } else if (event.tool_name === "TaskUpdate" && input.taskId != null) {
      const index = session.tasks.findIndex((task) => task.id === String(input.taskId));
      if (index === -1) return;
      if (input.status === "deleted") {
        session.tasks.splice(index, 1);
        return;
      }
      const task = session.tasks[index];
      if (input.status) task.status = input.status;
      if (input.subject) task.label = clip(input.subject, 80);
      if (input.activeForm) task.activeLabel = clip(input.activeForm, 80);
      else if (input.subject) task.activeLabel = task.label;
    }
  }

  // A tool that finished while its permission request was still held here
  // was approved or refused in the tab instead.
  settledElsewhere(sessionId, event) {
    const pending = this.requestsFor(sessionId).filter((request) => request.type === "permission" && request.tool === event.tool_name);
    if (pending.length === 0) return [];
    const key = JSON.stringify(event.tool_input ?? {});
    const exact = pending.filter((request) => request.inputKey === key);
    if (exact.length) return exact.map((request) => request.id);
    return pending.length === 1 ? [pending[0].id] : [];
  }

  addRequest(type, payload) {
    const at = this.now();
    const session = this.upsert(payload, at);
    session.hidden = false;
    session.waitingInTab = false;
    const request = {
      id: `request-${++this.requestSeq}`,
      type,
      sessionId: session.id,
      createdAt: at,
      tool: payload.tool_name ?? "",
      inputKey: JSON.stringify(payload.tool_input ?? {}),
    };
    if (type === "question") {
      request.questions = (payload.tool_input?.questions ?? []).map((item) => ({
        question: String(item.question ?? ""),
        header: String(item.header ?? ""),
        multiSelect: Boolean(item.multiSelect),
        options: (item.options ?? []).map((option) => ({ label: String(option.label ?? ""), description: String(option.description ?? "") })),
      }));
    } else {
      Object.assign(request, describeRequest(payload.tool_name, payload.tool_input, session.cwd));
    }
    this.requests.set(request.id, request);
    this.emit();
    return request.id;
  }

  // The same hook set up in two settings files sends the same request twice.
  // Both copies are answered by one decision, so the second joins the first.
  findRequest(type, payload) {
    const key = JSON.stringify(payload?.tool_input ?? {});
    const match = [...this.requests.values()].find(
      (request) => request.type === type && request.sessionId === payload?.session_id && request.tool === (payload?.tool_name ?? "") && request.inputKey === key,
    );
    return match?.id ?? null;
  }

  removeRequest(id) {
    if (this.requests.delete(id)) this.emit();
  }

  dismiss(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || this.requestsFor(sessionId).length) return;
    session.hidden = true;
    session.waitingInTab = false;
    this.emit();
  }

  // Drops sessions that have been silent for a long time and tucks away the
  // ones that finished a while ago. They come back on their next event.
  sweep() {
    const at = this.now();
    let changed = false;
    for (const session of this.sessions.values()) {
      const quiet = at - session.lastEventAt;
      const held = this.requestsFor(session.id).length > 0;
      if (!held && quiet > this.staleMs) {
        this.sessions.delete(session.id);
        changed = true;
      } else if (!held && !session.hidden && !session.waitingInTab && session.phase !== "working" && quiet > this.autoHideMs) {
        session.hidden = true;
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  progress(session) {
    const total = session.tasks.length;
    if (!total) return null;
    const done = session.tasks.filter((task) => task.status === "completed").length;
    const active = session.tasks.find((task) => task.status === "in_progress");
    const next = session.tasks.find((task) => task.status === "pending");
    return { done, total, label: active ? active.activeLabel : next ? next.label : "All steps done" };
  }

  view(session) {
    const [first] = this.requestsFor(session.id);
    const status = first || session.waitingInTab ? "needs-you" : session.phase;
    const mood = status === "needs-you" ? "ask" : status === "working" ? (MOODS[session.kind] ?? "think") : status === "done" && session.activity !== "Finished" ? "idle" : status;
    let activity = session.activity;
    if (first) activity = first.type === "question" ? "Asked you a question" : "Needs your approval";
    else if (session.waitingInTab) activity = "Waiting for you in the tab";
    return {
      id: session.id,
      n: session.n,
      title: session.title || baseName(session.cwd) || "New session",
      project: baseName(session.cwd),
      cwd: session.cwd,
      status,
      mood,
      activity,
      progress: this.progress(session),
      stepCount: session.stepCount,
      promptAt: session.promptAt,
      lastEventAt: session.lastEventAt,
      tasks: session.tasks.map(({ id, label, status: state }) => ({ id, label, status: state })),
      steps: session.steps.slice(-SHOWN_STEPS),
      terminal: session.terminal,
      lastMessage: session.lastMessage,
      request: first ? this.viewRequest(first) : null,
      waitingSince: first ? first.createdAt : session.waitingInTab ? session.lastEventAt : 0,
    };
  }

  viewRequest(request) {
    const { id, type, title, where, detail, mono, tabOnly, note, questions } = request;
    return type === "question" ? { id, type, questions } : { id, type, title, where, detail, mono, tabOnly, note };
  }

  // Agents that need you come first, oldest request first. The rest keep the
  // order they arrived in, so rows do not move while you read them.
  snapshot() {
    const sessions = [...this.sessions.values()].filter((session) => !session.hidden).map((session) => this.view(session));
    sessions.sort((a, b) => {
      const needA = a.status === "needs-you";
      const needB = b.status === "needs-you";
      if (needA !== needB) return needA ? -1 : 1;
      if (needA && a.waitingSince !== b.waitingSince) return a.waitingSince - b.waitingSince;
      return a.n - b.n;
    });
    return { sessions };
  }

  serialize() {
    return { figureSeq: this.figureSeq, sessions: [...this.sessions.values()] };
  }

  restore(data) {
    if (!data || !Array.isArray(data.sessions)) return;
    const at = this.now();
    for (const session of data.sessions) {
      if (!session?.id || at - (session.lastEventAt ?? 0) > this.staleMs) continue;
      // Work in flight when the widget closed cannot be trusted after a restart.
      const resting = session.phase === "working" ? { phase: "idle", kind: "idle", activity: "Ready" } : {};
      this.sessions.set(session.id, { finished: [], stoppedAt: 0, ...session, ...resting, waitingInTab: false, subagents: 0 });
    }
    this.figureSeq = Math.max(Number(data.figureSeq) || 0, ...[...this.sessions.values()].map((session) => session.n + 1), 0);
    this.emit();
  }
}
