import assert from "node:assert/strict";
import { test } from "node:test";
import { Huddle } from "../src/main/store.js";

function setup() {
  let clock = 1_000_000;
  const huddle = new Huddle({ now: () => clock });
  const tick = (ms = 1000) => (clock += ms);
  const send = (hook_event_name, extra = {}) => huddle.apply({ session_id: "a", cwd: "C:\\work\\weather-station", hook_event_name, ...extra });
  const row = (id = "a") => huddle.snapshot().sessions.find((session) => session.id === id);
  return { huddle, tick, send, row };
}

test("a prompt names the session and marks it as working", () => {
  const { send, row } = setup();
  send("SessionStart", { source: "startup" });
  assert.equal(row().status, "idle");
  assert.equal(row().title, "weather-station");
  send("UserPromptSubmit", { prompt: "Add the rainfall chart\nwith last year's readings" });
  assert.equal(row().title, "Add the rainfall chart");
  assert.equal(row().status, "working");
  assert.equal(row().mood, "think");
});

test("tool events drive the activity line, the steps and the mood", () => {
  const { send, row } = setup();
  send("UserPromptSubmit", { prompt: "Fix it" });
  send("PreToolUse", { tool_name: "Read", tool_use_id: "t1", tool_input: { file_path: "C:\\work\\weather-station\\charts.py" } });
  assert.equal(row().activity, "Reading charts.py");
  assert.equal(row().mood, "look");
  assert.equal(row().steps[0].status, "running");
  send("PostToolUse", { tool_name: "Read", tool_use_id: "t1", tool_input: {} });
  assert.equal(row().steps[0].status, "done");
  send("PreToolUse", { tool_name: "Bash", tool_use_id: "t2", tool_input: { command: "python charts.py", description: "Draw the chart" } });
  assert.equal(row().activity, "Draw the chart");
  assert.equal(row().mood, "type");
  send("PostToolUseFailure", { tool_name: "Bash", tool_use_id: "t2", tool_input: {} });
  assert.equal(row().steps[1].status, "failed");
  assert.equal(row().stepCount, 2);
});

test("a finish that arrives before its start still closes the step", () => {
  const { send, row } = setup();
  send("UserPromptSubmit", { prompt: "Go" });
  send("PostToolUse", { tool_name: "Read", tool_use_id: "t9", tool_input: {} });
  send("PreToolUse", { tool_name: "Read", tool_use_id: "t9", tool_input: { file_path: "a.txt" } });
  assert.equal(row().steps[0].status, "done");
});

test("a start sent before the stop does not mark the session as working again", () => {
  const { send, row } = setup();
  send("UserPromptSubmit", { prompt: "Go" });
  send("Stop", { last_assistant_message: "All done", huddle_at: 500 });
  send("PreToolUse", { tool_name: "Read", tool_use_id: "t1", tool_input: {}, huddle_at: 400 });
  assert.equal(row().status, "done");
  assert.equal(row().activity, "Finished");
});

test("shell output keeps its last lines", () => {
  const { send, row } = setup();
  send("PreToolUse", { tool_name: "PowerShell", tool_use_id: "t1", tool_input: { command: "npm test" } });
  assert.deepEqual(row().terminal, { command: "npm test", lines: [] });
  send("PostToolUse", { tool_name: "PowerShell", tool_use_id: "t1", tool_input: { command: "npm test" }, tool_response: { stdout: "one\ntwo\nthree\nfour\nfive\n", stderr: "" } });
  assert.deepEqual(row().terminal.lines, ["two", "three", "four", "five"]);
});

test("task tools produce progress", () => {
  const { send, row } = setup();
  send("PostToolUse", { tool_name: "TaskCreate", tool_input: { subject: "Clean the data", activeForm: "Cleaning the data" }, tool_response: { task: { id: "1" } } });
  send("PostToolUse", { tool_name: "TaskCreate", tool_input: { subject: "Draw the chart" }, tool_response: { task: { id: "2" } } });
  assert.deepEqual(row().progress, { done: 0, total: 2, label: "Clean the data" });
  send("PostToolUse", { tool_name: "TaskUpdate", tool_input: { taskId: "1", status: "in_progress" } });
  assert.deepEqual(row().progress, { done: 0, total: 2, label: "Cleaning the data" });
  send("PostToolUse", { tool_name: "TaskUpdate", tool_input: { taskId: "1", status: "completed" } });
  send("PostToolUse", { tool_name: "TaskUpdate", tool_input: { taskId: "2", status: "completed" } });
  assert.deepEqual(row().progress, { done: 2, total: 2, label: "All steps done" });
  send("PostToolUse", { tool_name: "TaskCreate", tool_input: { subject: "Write it up" }, tool_response: { task: { id: "3" } } });
  assert.deepEqual(row().progress, { done: 0, total: 1, label: "Write it up" });
  send("PostToolUse", { tool_name: "TaskUpdate", tool_input: { taskId: "3", status: "deleted" } });
  assert.equal(row().progress, null);
});

test("the older to-do tool replaces the whole list", () => {
  const { send, row } = setup();
  send("PostToolUse", {
    tool_name: "TodoWrite",
    tool_input: { todos: [{ content: "One", status: "completed" }, { content: "Two", activeForm: "Doing two", status: "in_progress" }, { content: "Three", status: "pending" }] },
  });
  assert.deepEqual(row().progress, { done: 1, total: 3, label: "Doing two" });
});

test("a held permission request puts the session first and is released by a matching tool result", () => {
  const { huddle, send, row } = setup();
  huddle.apply({ session_id: "b", cwd: "C:\\work\\portal", hook_event_name: "UserPromptSubmit", prompt: "Other work" });
  send("UserPromptSubmit", { prompt: "Write the file" });
  const input = { file_path: "C:\\work\\weather-station\\notes.txt", content: "x" };
  const id = huddle.addRequest("permission", { session_id: "a", cwd: "C:\\work\\weather-station", tool_name: "Write", tool_input: input });
  assert.equal(huddle.snapshot().sessions[0].id, "a");
  assert.equal(row().status, "needs-you");
  assert.equal(row().mood, "ask");
  assert.deepEqual(row().request, { id, type: "permission", title: "Write notes.txt", where: "", detail: "x", mono: true, tabOnly: false, note: "" });
  const nested = huddle.addRequest("permission", {
    session_id: "b",
    cwd: "C:\\work\\portal",
    tool_name: "Edit",
    tool_input: { file_path: "C:\\work\\portal\\src\\ShareLink.tsx", old_string: "Hi", new_string: "Hello" },
  });
  assert.equal(row("b").request.where, "src\\ShareLink.tsx");
  assert.equal(row("b").request.detail, "- Hi\n+ Hello");
  huddle.removeRequest(nested);
  assert.deepEqual(send("PostToolUse", { tool_name: "Read", tool_use_id: "x", tool_input: {} }), []);
  assert.deepEqual(send("PostToolUse", { tool_name: "Write", tool_use_id: "y", tool_input: input }), [id]);
  huddle.removeRequest(id);
  assert.equal(row().status, "working");
});

test("the same request sent twice is found so the second can join the first", () => {
  const { huddle } = setup();
  const payload = { session_id: "a", cwd: "C:\\work", tool_name: "Write", tool_input: { file_path: "C:\\work\\a.txt", content: "x" } };
  assert.equal(huddle.findRequest("permission", payload), null);
  const id = huddle.addRequest("permission", payload);
  assert.equal(huddle.findRequest("permission", { ...payload }), id);
  assert.equal(huddle.findRequest("permission", { ...payload, session_id: "b" }), null);
  assert.equal(huddle.findRequest("permission", { ...payload, tool_input: { file_path: "C:\\work\\b.txt" } }), null);
  assert.equal(huddle.findRequest("question", payload), null);
});

test("a question request exposes its options", () => {
  const { huddle, row } = setup();
  const questions = [{ question: "Which colour?", header: "Colour", multiSelect: false, options: [{ label: "Red", description: "Warm" }, { label: "Blue", description: "Cool" }] }];
  const id = huddle.addRequest("question", { session_id: "a", cwd: "C:\\work\\weather-station", tool_name: "AskUserQuestion", tool_input: { questions } });
  assert.equal(row().activity, "Asked you a question");
  assert.deepEqual(row().request, { id, type: "question", questions });
});

test("a permission prompt with nothing held here points to the tab", () => {
  const { send, row } = setup();
  send("UserPromptSubmit", { prompt: "Go" });
  send("Notification", { notification_type: "permission_prompt", message: "needs permission" });
  assert.equal(row().status, "needs-you");
  assert.equal(row().activity, "Waiting for you in the tab");
  send("PreToolUse", { tool_name: "Read", tool_use_id: "t1", tool_input: {} });
  assert.equal(row().status, "working");
});

test("stop finishes the session and releases anything held", () => {
  const { huddle, send, row } = setup();
  send("UserPromptSubmit", { prompt: "Go" });
  const id = huddle.addRequest("permission", { session_id: "a", tool_name: "Bash", tool_input: { command: "ls" } });
  assert.deepEqual(send("Stop", { last_assistant_message: "All done" }), [id]);
  huddle.removeRequest(id);
  assert.equal(row().status, "done");
  assert.equal(row().mood, "done");
  assert.equal(row().lastMessage, "All done");
});

test("a request too long to show in full can only be decided in the tab", () => {
  const { huddle, row } = setup();
  huddle.addRequest("permission", { session_id: "a", tool_name: "Bash", tool_input: { command: "echo " + "z".repeat(25_000) } });
  assert.equal(row().request.tabOnly, true);
  assert.equal(row().request.detail.length, 20_000);
});

test("fields the card does not show by default are listed, and leaving the sandbox is decided in the tab", () => {
  const { huddle, row } = setup();
  const first = huddle.addRequest("permission", {
    session_id: "a",
    tool_name: "Bash",
    tool_input: { command: "npm run build", description: "Build", timeout: 60000, run_in_background: true, run_as: "admin" },
  });
  assert.equal(row().request.detail, "npm run build\n\nrun_in_background: true\n\nrun_as: admin");
  assert.equal(row().request.tabOnly, false);
  huddle.removeRequest(first);
  huddle.addRequest("permission", { session_id: "a", tool_name: "Bash", tool_input: { command: "curl example.com", dangerouslyDisableSandbox: true } });
  assert.equal(row().request.tabOnly, true);
  assert.match(row().request.detail, /dangerouslyDisableSandbox: true/);
  assert.match(row().request.note, /outside the sandbox/);
});

test("an edit shows the text it replaces and any replace-all switch", () => {
  const { huddle, row } = setup();
  huddle.addRequest("permission", { session_id: "a", cwd: "C:\\w", tool_name: "Edit", tool_input: { file_path: "C:\\w\\a.js", old_string: "let x", new_string: "const x", replace_all: true } });
  assert.equal(row().request.detail, "- let x\n+ const x\n\nreplace_all: true");
});

test("a run that fails shows as stopped by an error", () => {
  const { send, row } = setup();
  send("UserPromptSubmit", { prompt: "Go" });
  send("PreToolUse", { tool_name: "Read", tool_use_id: "t1", tool_input: {} });
  send("StopFailure", {});
  assert.equal(row().status, "done");
  assert.equal(row().activity, "Stopped by an error");
  assert.equal(row().mood, "idle");
  assert.equal(row().steps[0].status, "failed");
});

test("a run stopped by hand goes quiet when the session reports it is idle", () => {
  const { send, row } = setup();
  send("UserPromptSubmit", { prompt: "Go" });
  send("PreToolUse", { tool_name: "Read", tool_use_id: "t1", tool_input: {} });
  send("Notification", { notification_type: "idle_prompt" });
  assert.equal(row().status, "idle");
  assert.equal(row().activity, "Waiting for your next message");
  assert.equal(row().steps[0].status, "done");
});

test("session end removes the session", () => {
  const { send, huddle } = setup();
  send("SessionStart", { source: "startup" });
  send("SessionEnd", { reason: "other" });
  assert.equal(huddle.snapshot().sessions.length, 0);
});

test("dismissed sessions return on the next prompt", () => {
  const { huddle, send, row } = setup();
  send("UserPromptSubmit", { prompt: "Go" });
  send("Stop", {});
  huddle.dismiss("a");
  assert.equal(row(), undefined);
  send("UserPromptSubmit", { prompt: "Again" });
  assert.equal(row().status, "working");
});

test("the sweep hides finished sessions after a while and drops silent ones", () => {
  const { huddle, send, row, tick } = setup();
  send("UserPromptSubmit", { prompt: "Go" });
  huddle.apply({ session_id: "busy", hook_event_name: "UserPromptSubmit", prompt: "Long job" });
  send("Stop", {});
  tick(21 * 60_000);
  huddle.sweep();
  assert.equal(row(), undefined);
  assert.equal(row("busy").status, "working");
  tick(13 * 3_600_000);
  huddle.sweep();
  assert.equal(huddle.sessions.size, 0);
});

test("state survives a restart, with work in flight reset to resting", () => {
  const { huddle, send } = setup();
  send("UserPromptSubmit", { prompt: "Go" });
  const saved = JSON.parse(JSON.stringify(huddle.serialize()));
  const next = new Huddle({ now: () => 1_000_500 });
  next.restore(saved);
  const [row] = next.snapshot().sessions;
  assert.equal(row.title, "Go");
  assert.equal(row.status, "idle");
  assert.equal(next.figureSeq, 1);
});
