import { Figure } from "./figure.js";
import { html, render, useEffect, useLayoutEffect, useRef, useState } from "./lib.js";

const api = window.huddle;
let icons = {};

const cx = (...names) => names.filter(Boolean).join(" ");
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

function ago(time) {
  const minutes = Math.floor((Date.now() - time) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} h ago`;
}

const STEP_ICONS = {
  shell: "terminal",
  edit: "pencil",
  read: "file-text",
  search: "search",
  web: "globe",
  agent: "users",
  plan: "list-checks",
  ask: "message-circle-question-mark",
  skill: "book-open",
  tool: "wrench",
};
const STATE_ICONS = { done: "circle-check", completed: "circle-check", running: "loader-circle", in_progress: "loader-circle", failed: "circle-x", pending: "circle" };

// Icon markup comes from the icon package shipped with the app, never from a session.
function Icon({ name, spin }) {
  return html`<span class=${cx("icon", spin && "spin")} dangerouslySetInnerHTML=${{ __html: icons[name] ?? "" }} />`;
}

function IconButton({ icon, label, onClick, small }) {
  const press = (event) => {
    event.stopPropagation();
    onClick();
  };
  return html`<button class=${cx("icon-btn", small && "small")} title=${label} aria-label=${label} onClick=${press}><${Icon} name=${icon} /></button>`;
}

function chime() {
  try {
    const audio = new AudioContext();
    const note = (frequency, start) => {
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, audio.currentTime + start);
      gain.gain.linearRampToValueAtTime(0.06, audio.currentTime + start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + start + 0.4);
      oscillator.connect(gain).connect(audio.destination);
      oscillator.start(audio.currentTime + start);
      oscillator.stop(audio.currentTime + start + 0.45);
    };
    note(660, 0);
    note(880, 0.14);
    setTimeout(() => audio.close(), 1000);
  } catch {}
}

function activityLine(session) {
  if (session.status === "done" && session.activity === "Finished") return `Finished ${ago(session.lastEventAt)}`;
  return session.activity;
}

// A new request can appear where the last one was just answered. Clicks in the
// first half second after it appears are ignored, so a double-click on one
// request never answers the next.
function useSettled() {
  const shownAt = useRef(Date.now());
  return () => Date.now() - shownAt.current > 500;
}

function Meta({ session }) {
  const progress = session.progress;
  if (progress) {
    return html`
      <div class="meta"><span class="num">${progress.done}/${progress.total}</span><span class="meta-label">${progress.label}</span></div>
      <div class="bar"><i style=${{ transform: `scaleX(${progress.done / progress.total})` }} /></div>
    `;
  }
  const note = session.status === "done" && session.lastMessage ? session.lastMessage : session.project;
  return html`
    <div class="meta">
      ${session.stepCount > 0 && html`<span class="num">${plural(session.stepCount, "step")}</span>`}
      <span class="meta-label">${note}</span>
    </div>
    <div class="bar ghost" />
  `;
}

function Summary({ session }) {
  return html`
    <${Figure} n=${session.n} mood=${session.mood} />
    <div class="text">
      <div class="title">${session.title}</div>
      <div class="activity">${activityLine(session)}</div>
      <${Meta} session=${session} />
    </div>
  `;
}

function Permission({ request }) {
  const settled = useSettled();
  const act = (choice) => settled() && api.decide(request.id, choice);
  return html`
    <div class="ask" onClick=${(event) => event.stopPropagation()}>
      <div class="ask-title">${request.title}</div>
      ${request.where && html`<div class="ask-where">${request.where}</div>`}
      ${request.detail && html`<pre class=${cx("code", !request.mono && "plain")}>${request.detail}</pre>`}
      ${request.note && html`<div class="ask-note">${request.note}</div>`}
      <div class="actions">
        <button class="btn primary" disabled=${request.tabOnly} onClick=${() => act("allow")}>Allow</button>
        <button class="btn" onClick=${() => act("deny")}>Deny</button>
        <button class="link" onClick=${() => act("pass")}>Decide in tab</button>
      </div>
    </div>
  `;
}

function Question({ request }) {
  const settled = useSettled();
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState({});
  const [picked, setPicked] = useState([]);
  const total = request.questions.length;
  const current = request.questions[index];
  if (!current) return null;

  const commit = (value) => {
    if (!settled()) return;
    const next = { ...answers, [current.question]: value };
    if (index + 1 < total) {
      setAnswers(next);
      setPicked([]);
      setIndex(index + 1);
    } else {
      api.answer(request.id, next);
    }
  };
  const choose = (label) => {
    if (!current.multiSelect) return commit(label);
    setPicked(picked.includes(label) ? picked.filter((item) => item !== label) : [...picked, label]);
  };

  return html`
    <div class="ask" onClick=${(event) => event.stopPropagation()}>
      <div class="ask-title">${current.question}${total > 1 && html`<span class="ask-count">${index + 1} of ${total}</span>`}</div>
      <div class="options">
        ${current.options.map(
          (option) => html`
            <button key=${option.label} class=${cx("option", picked.includes(option.label) && "picked")} onClick=${() => choose(option.label)}>
              <span class="option-label">${option.label}</span>
              ${option.description && html`<span class="option-text">${option.description}</span>`}
            </button>
          `,
        )}
      </div>
      <div class="actions">
        ${current.multiSelect && html`<button class="btn primary" disabled=${picked.length === 0} onClick=${() => commit(picked.join(", "))}>Send</button>`}
        <button class="link" onClick=${() => settled() && api.decide(request.id, "pass")}>Answer in tab</button>
      </div>
    </div>
  `;
}

function Request({ request }) {
  return request.type === "question" ? html`<${Question} key=${request.id} request=${request} />` : html`<${Permission} key=${request.id} request=${request} />`;
}

function Row({ session, index, expanded, onOpen }) {
  const onKey = (event) => {
    if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) onOpen();
  };
  return html`
    <div class=${cx("row", session.status)} style=${{ "--i": Math.min(index, 5) }} role="button" tabindex="0" onClick=${onOpen} onKeyDown=${onKey}>
      <${Summary} session=${session} />
      <div class="row-actions">
        <${IconButton} small icon="arrow-up-right" label="Open in VS Code" onClick=${() => api.open(session.id)} />
        ${!session.request && html`<${IconButton} small icon="x" label="Dismiss" onClick=${() => api.dismiss(session.id)} />`}
      </div>
      ${expanded && session.request && html`<${Request} request=${session.request} />`}
    </div>
  `;
}

function Checklist({ label, items, iconFor }) {
  return html`
    <section class="section">
      <div class="section-label">${label}</div>
      <div class="steps">
        ${items.map(
          (item) => html`
            <div key=${item.id} class=${cx("step", item.status)}>
              <${Icon} name=${STATE_ICONS[item.status] ?? "circle"} spin=${item.status === "running" || item.status === "in_progress"} />
              ${iconFor && html`<${Icon} name=${iconFor(item)} />`}
              <span class="step-label">${item.label}</span>
            </div>
          `,
        )}
      </div>
    </section>
  `;
}

function Detail({ session }) {
  const shown = session.tasks.slice(0, 8);
  const more = session.tasks.length - shown.length;
  return html`
    <div class="detail">
      <div class="row flat"><${Summary} session=${session} /></div>
      ${session.request && html`<div class="row flat"><${Request} request=${session.request} /></div>`}
      ${shown.length > 0 && html`<${Checklist} label="Plan" items=${shown} />`}
      ${more > 0 && html`<div class="more">and ${more} more</div>`}
      ${session.steps.length > 0 && html`<${Checklist} label="Recent steps" items=${session.steps} iconFor=${(step) => STEP_ICONS[step.kind] ?? "wrench"} />`}
      ${session.terminal &&
      html`
        <section class="section">
          <div class="section-label">Terminal</div>
          <div class="term">
            <div class="term-cmd">${session.terminal.command}</div>
            ${session.terminal.lines.map((line, at) => html`<div key=${at} class="term-out">${line}</div>`)}
          </div>
        </section>
      `}
      <div class="path">${session.cwd}</div>
    </div>
  `;
}

function Empty({ connection, onConnect }) {
  const connected = connection.connected;
  return html`
    <div class="empty">
      <${Figure} n=${0} mood="idle" size=${48} />
      <div class="empty-title">No agents running</div>
      <div class="empty-text">${connected ? "Start a session and it shows up here" : "Connect once and every new session shows up here"}</div>
      ${!connected && html`<button class="btn primary" onClick=${onConnect}>Connect Claude Code</button>`}
      ${!connected && html`<div class="fine">${connection.error ?? "Adds hooks to your settings file and keeps a backup"}</div>`}
    </div>
  `;
}

function Minis({ sessions, onPick }) {
  return html`
    <div class="minis">
      ${sessions.slice(0, 6).map(
        (session) => html`
          <button key=${session.id} class="mini" title=${session.title} aria-label=${session.title} onClick=${() => onPick(session.id)}>
            <${Figure} n=${session.n} mood=${session.mood} size=${20} />
          </button>
        `,
      )}
    </div>
  `;
}

function App({ boot }) {
  const [sessions, setSessions] = useState(boot.sessions);
  const [connection, setConnection] = useState(boot.connection);
  const [sound, setSound] = useState(boot.config.sound);
  const [collapsedPref, setCollapsedPref] = useState(boot.view === "collapsed" || boot.config.collapsed);
  const [openId, setOpenId] = useState(boot.view === "detail" ? boot.sessions.find((session) => !session.request)?.id ?? null : null);
  const [, setTick] = useState(0);
  const head = useRef(null);
  const content = useRef(null);
  const heard = useRef(new Set(boot.sessions.map((session) => session.request?.id).filter(Boolean)));
  const soundOn = useRef(sound);
  soundOn.current = sound;

  useEffect(() => {
    api.onState((state) => {
      const fresh = state.sessions.map((session) => session.request?.id).filter((id) => id && !heard.current.has(id));
      fresh.forEach((id) => heard.current.add(id));
      if (fresh.length && soundOn.current) chime();
      setSessions(state.sessions);
    });
    api.onConnection(setConnection);
    const timer = setInterval(() => setTick((value) => value + 1), 15_000);
    return () => clearInterval(timer);
  }, []);

  const asking = sessions.find((session) => session.request);
  const collapsed = collapsedPref && !asking;
  const open = openId ? sessions.find((session) => session.id === openId) : null;
  // Another agent's request stays in view while one agent is open.
  const elsewhere = open && asking && asking.id !== open.id ? asking : null;

  useLayoutEffect(() => {
    const report = () => {
      const body = content.current ? content.current.offsetHeight + 8 : 0;
      api.resize(16 + head.current.offsetHeight + body);
    };
    report();
    const observer = new ResizeObserver(report);
    if (content.current) observer.observe(content.current);
    return () => observer.disconnect();
  });

  const toggleSound = () => {
    setSound(!sound);
    api.setConfig({ sound: !sound });
    if (!sound) chime();
  };
  const setCollapsed = (value) => {
    setCollapsedPref(value);
    api.setConfig({ collapsed: value });
  };
  const connect = async () => setConnection(await api.connect());

  return html`
    <div class="panel">
      <header class="head" ref=${head}>
        ${open
          ? html`
              <${IconButton} icon="arrow-left" label="Back to all agents" onClick=${() => setOpenId(null)} />
              <${Minis} sessions=${sessions.filter((session) => session.id !== open.id)} onPick=${setOpenId} />
            `
          : html`
              <span class="brand">Agents Huddle</span>
              ${collapsed &&
              html`<${Minis}
                sessions=${sessions}
                onPick=${(id) => {
                  setCollapsed(false);
                  setOpenId(id);
                }}
              />`}
            `}
        <span class="grow" />
        ${open && html`<${IconButton} icon="arrow-up-right" label="Open in VS Code" onClick=${() => api.open(open.id)} />`}
        ${!collapsed && !open && html`<${IconButton} icon=${sound ? "volume-2" : "volume-x"} label=${sound ? "Sound is on" : "Sound is off"} onClick=${toggleSound} />`}
        <${IconButton} icon=${collapsed ? "chevron-down" : "chevron-up"} label=${collapsed ? "Expand" : "Collapse"} onClick=${() => setCollapsed(!collapsed)} />
        <${IconButton} icon="x" label="Minimise to the taskbar" onClick=${() => api.minimize()} />
      </header>
      ${!collapsed &&
      html`
        <div class="scroll">
          <div ref=${content}>
            ${open
              ? html`
                  ${elsewhere &&
                  html`<div class="list elsewhere">
                    <${Row} key=${elsewhere.id} session=${elsewhere} index=${0} expanded=${true} onOpen=${() => setOpenId(elsewhere.id)} />
                  </div>`}
                  <${Detail} session=${open} />
                `
              : sessions.length === 0
                ? html`<${Empty} connection=${connection} onConnect=${connect} />`
                : html`
                    <div class="list">
                      ${sessions.map(
                        (session, index) => html`
                          <${Row} key=${session.id} session=${session} index=${index} expanded=${asking && asking.id === session.id} onOpen=${() => setOpenId(session.id)} />
                        `,
                      )}
                    </div>
                  `}
          </div>
        </div>
      `}
    </div>
  `;
}

const boot = await api.boot();
icons = boot.icons;
render(html`<${App} boot=${boot} />`, document.getElementById("root"));
