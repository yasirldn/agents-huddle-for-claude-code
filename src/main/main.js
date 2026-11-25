import { app, BrowserWindow, ipcMain, Menu, nativeImage, screen, shell, Tray } from "electron";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDemo } from "./demo.js";
import { goToSession } from "./go-to.js";
import * as hooks from "./hooks-config.js";
import { createHookServer } from "./server.js";
import { Huddle } from "./store.js";
import { claudeSettingsPath, dataDir, installedRelayPath, legacyDataDir, pipePath, tokenPath } from "../shared/paths.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..", "..");
const option = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const flag = (name) => process.argv.includes(`--${name}`);

const demo = flag("demo");
const dev = flag("dev");
const shotPath = option("shot");
const startView = option("view") ?? "list";

const WIDTH = 376;
const EDGE = 4;
const ICONS = [
  "arrow-up-right", "x", "chevron-up", "chevron-down", "volume-2", "volume-x", "arrow-left", "terminal", "pencil", "file-text",
  "search", "globe", "circle", "circle-check", "circle-x", "loader-circle", "list-checks", "message-circle-question-mark",
  "users", "wrench", "book-open", "check",
];

const storage = dataDir();
const configFile = path.join(storage, "config.json");
const stateFile = path.join(storage, "state.json");
const settingsPath = claudeSettingsPath();
const relayTarget = installedRelayPath();
const relaySource = path.join(here, "..", "hook", "relay.mjs");

// Carries settings, remembered sessions and the secret over from where earlier versions kept them.
function moveOldData() {
  const old = legacyDataDir();
  if (demo || !old || path.resolve(old) === path.resolve(storage) || !existsSync(old)) return;
  for (const name of ["config.json", "state.json", "token"]) {
    const from = path.join(old, name);
    const to = path.join(storage, name);
    if (!existsSync(from) || existsSync(to)) continue;
    mkdirSync(storage, { recursive: true });
    copyFileSync(from, to);
  }
}
moveOldData();

// The browser cache is private to the app, so on Windows it stays in AppData.
app.setPath("userData", path.join(legacyDataDir() ?? storage, demo ? "electron-demo" : "electron"));
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};
const writeJson = (file, value) => {
  if (demo) return;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value, null, 2));
  } catch (error) {
    console.error(`could not write ${file}: ${error.message}`);
  }
};

const config = { sound: false, collapsed: false, position: null, holdSeconds: hooks.DEFAULT_HOLD_SECONDS, ...(demo ? {} : readJson(configFile, {})) };
const huddle = new Huddle();
const held = new Map();
let win = null;
let tray = null;
let server = null;
let anchor = null;
let lastHeight = 0;
let quitting = false;

function connection() {
  if (demo) return { connected: true };
  return hooks.status({ settingsPath, relayTarget });
}

// The relay prints a decision only when it carries this secret.
function loadToken() {
  const file = tokenPath();
  try {
    const saved = readFileSync(file, "utf8").trim();
    if (saved.length >= 32) return saved;
  } catch {}
  const fresh = randomBytes(24).toString("hex");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, fresh, { mode: 0o600 });
  return fresh;
}

// ---- requests the widget is holding for an answer ----

const trace = dev ? (...parts) => console.log("[held]", ...parts) : () => {};

function release(id, body) {
  const entry = held.get(id);
  trace("release", id, entry ? "found" : "missing", body ? JSON.stringify(body).slice(0, 120) : "pass");
  if (entry) {
    clearTimeout(entry.timer);
    held.delete(id);
    for (const respond of entry.responders) respond(body);
  }
  huddle.removeRequest(id);
}

function onHeld(request) {
  const isQuestion = request.kind === "question";
  const askable = !isQuestion || (Array.isArray(request.payload?.tool_input?.questions) && request.payload.tool_input.questions.length > 0);
  // With the widget out of sight nobody can answer here, so the tab asks as usual.
  if (!request.payload?.session_id || !askable || !onDisplay()) {
    request.respond(null);
    return;
  }
  const existing = huddle.findRequest(request.kind, request.payload);
  let id = existing && held.has(existing) ? existing : null;
  if (id) {
    trace("join", id);
    held.get(id).responders.add(request.respond);
  } else {
    id = huddle.addRequest(request.kind, request.payload);
    trace("hold", id, request.kind, request.payload.tool_name, request.payload.session_id);
    const timer = setTimeout(() => release(id, null), config.holdSeconds * 1000);
    held.set(id, { responders: new Set([request.respond]), timer, kind: request.kind, payload: request.payload });
  }
  const entry = held.get(id);
  request.onGone = () => {
    trace("gone", id);
    entry.responders.delete(request.respond);
    if (entry.responders.size > 0 || held.get(id) !== entry) return;
    clearTimeout(entry.timer);
    held.delete(id);
    huddle.removeRequest(id);
  };
}

function decide(id, choice) {
  const entry = held.get(id);
  if (!entry || entry.kind !== "permission") return release(id, null);
  if (choice === "allow") return release(id, { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
  if (choice === "deny") {
    return release(id, { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "Denied in Agents Huddle", interrupt: false } } });
  }
  release(id, null);
}

function answer(id, answers) {
  const entry = held.get(id);
  if (!entry || entry.kind !== "question" || !answers || typeof answers !== "object") return release(id, null);
  const clean = Object.fromEntries(Object.entries(answers).map(([question, value]) => [String(question), String(value)]));
  release(id, {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...entry.payload.tool_input, answers: clean } },
  });
}

function onEvent(payload) {
  trace("event", payload.hook_event_name, payload.tool_name ?? "", payload.session_id);
  for (const id of huddle.apply(payload)) release(id, null);
}

// ---- window ----

function defaultPosition() {
  const area = screen.getPrimaryDisplay().workArea;
  return { x: area.x + area.width - WIDTH - EDGE, y: area.y + EDGE };
}

function onScreen(position) {
  if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return false;
  return screen.getAllDisplays().some(({ workArea: area }) => {
    return position.x > area.x - WIDTH + 80 && position.x < area.x + area.width - 80 && position.y >= area.y && position.y < area.y + area.height - 80;
  });
}

function fitHeight(wanted) {
  if (!win) return;
  const area = screen.getDisplayMatching({ x: anchor.x, y: anchor.y, width: WIDTH, height: 100 }).workArea;
  const room = area.y + area.height - anchor.y - EDGE;
  const height = Math.max(60, Math.min(Math.ceil(wanted), room));
  if (height === lastHeight) return;
  lastHeight = height;
  win.setBounds({ x: anchor.x, y: anchor.y, width: WIDTH, height });
}

const onDisplay = () => Boolean(win) && win.isVisible() && !win.isMinimized();

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  else win.showInactive();
  win.setAlwaysOnTop(true, "floating");
  buildTrayMenu();
}

// Anything held would wait unseen, so it goes back to the tabs.
function handBack() {
  for (const id of [...held.keys()]) release(id, null);
}

function minimizeWindow() {
  if (!win) return;
  handBack();
  win.minimize();
  buildTrayMenu();
}

const toggleWindow = () => (onDisplay() ? minimizeWindow() : showWindow());

function createWindow() {
  anchor = onScreen(config.position) ? { ...config.position } : defaultPosition();
  win = new BrowserWindow({
    x: anchor.x,
    y: anchor.y,
    width: WIDTH,
    height: 120,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: true,
    fullscreenable: false,
    skipTaskbar: false,
    alwaysOnTop: true,
    show: false,
    title: "Agents Huddle",
    icon: path.join(root, "assets", "icon.png"),
    webPreferences: { preload: path.join(here, "..", "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.setAlwaysOnTop(true, "floating");
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  if (dev || shotPath) win.webContents.on("console-message", (event) => console.log(`[page] ${event.message}`));
  // Nobody can answer while the page is down, so the tabs ask instead and the page restarts.
  win.webContents.on("render-process-gone", (_event, details) => {
    console.error(`the widget page stopped: ${details.reason}`);
    for (const id of [...held.keys()]) release(id, null);
    if (!quitting) win.reload();
  });
  win.on("moved", () => {
    const bounds = win.getBounds();
    anchor = { x: bounds.x, y: bounds.y };
    config.position = anchor;
    writeJson(configFile, config);
  });
  // Minimising from the taskbar hands requests back too. Closing the window,
  // for example from its taskbar button, quits the app.
  win.on("minimize", () => {
    handBack();
    buildTrayMenu();
  });
  win.on("restore", () => {
    win.setAlwaysOnTop(true, "floating");
    buildTrayMenu();
  });
  win.on("close", () => {
    if (!quitting) app.quit();
  });
  win.once("ready-to-show", showWindow);
  win.loadFile(path.join(here, "..", "renderer", "index.html"));
}

// ---- tray ----

function buildTrayMenu() {
  if (!tray) return;
  const { connected } = connection();
  const items = [
    { label: onDisplay() ? "Minimise the widget" : "Show the widget", click: toggleWindow },
    { label: "Move back to the top right corner", click: resetPosition },
    { type: "separator" },
    { label: connected ? "Disconnect Claude Code" : "Connect Claude Code", enabled: !demo, click: () => (connected ? disconnect() : connect()) },
  ];
  // A Store install cannot set itself to start with Windows this way.
  if (app.isPackaged && !process.windowsStore) {
    items.push({
      label: "Start with Windows",
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    });
  }
  items.push({ type: "separator" }, { label: "Quit", click: () => app.quit() });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function resetPosition() {
  anchor = defaultPosition();
  config.position = null;
  writeJson(configFile, config);
  const height = lastHeight || 120;
  lastHeight = 0;
  fitHeight(height);
  showWindow();
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(root, "assets", "tray.png")));
  tray.setToolTip("Agents Huddle");
  tray.on("click", toggleWindow);
  buildTrayMenu();
}

// ---- connection to the agent sessions ----

function tellConnection(extra = {}) {
  const state = { ...connection(), ...extra };
  win?.webContents.send("connection", state);
  buildTrayMenu();
  return state;
}

function connect() {
  try {
    hooks.install({ settingsPath, relaySource, relayTarget, holdSeconds: config.holdSeconds });
    return tellConnection();
  } catch (error) {
    return tellConnection({ error: error.message });
  }
}

function disconnect() {
  try {
    hooks.uninstall({ settingsPath });
    return tellConnection();
  } catch (error) {
    return tellConnection({ error: error.message });
  }
}

// Keeps the installed relay in step with the one this version ships.
function refreshRelay() {
  if (demo) return;
  try {
    // Hooks set up by an earlier version point at its relay, so they are moved to this one.
    const relays = hooks.relaysInSettings(settingsPath);
    if (relays.length && relays.some((relay) => path.resolve(relay) !== path.resolve(relayTarget))) {
      hooks.install({ settingsPath, relaySource, relayTarget, holdSeconds: config.holdSeconds });
      return;
    }
    if (!connection().connected) return;
    const shipped = readFileSync(relaySource);
    if (!existsSync(relayTarget) || !shipped.equals(readFileSync(relayTarget))) writeFileSync(relayTarget, shipped);
  } catch (error) {
    console.error(`could not refresh the relay: ${error.message}`);
  }
}

function openSession(sessionId) {
  if (demo) return;
  goToSession(shell, huddle.sessions.get(sessionId), (result) => trace("go to", sessionId, result));
}

// ---- state to the page and to disk ----

let pushTimer = null;
let saveTimer = null;
function onChange() {
  pushTimer ??= setTimeout(() => {
    pushTimer = null;
    win?.webContents.send("state", huddle.snapshot());
  }, 40);
  if (demo) return;
  saveTimer ??= setTimeout(() => {
    saveTimer = null;
    writeJson(stateFile, huddle.serialize());
  }, 1500);
}

function loadIcons() {
  const icons = {};
  for (const name of ICONS) {
    try {
      icons[name] = readFileSync(path.join(root, "node_modules", "lucide-static", "icons", `${name}.svg`), "utf8").replace(/<!--[\s\S]*?-->/g, "").trim();
    } catch {
      icons[name] = "";
    }
  }
  return icons;
}

function wireIpc() {
  const icons = loadIcons();
  ipcMain.handle("boot", () => ({ icons, config, demo, view: startView, connection: connection(), ...huddle.snapshot() }));
  ipcMain.handle("connect", () => connect());
  ipcMain.on("decide", (_event, id, choice) => decide(String(id), String(choice)));
  ipcMain.on("answer", (_event, id, answers) => answer(String(id), answers));
  ipcMain.on("dismiss", (_event, sessionId) => huddle.dismiss(String(sessionId)));
  ipcMain.on("open", (_event, sessionId) => openSession(String(sessionId)));
  ipcMain.on("minimize", minimizeWindow);
  ipcMain.on("resize", (_event, height) => Number.isFinite(height) && fitHeight(height));
  ipcMain.on("config", (_event, patch) => {
    if (typeof patch?.sound === "boolean") config.sound = patch.sound;
    if (typeof patch?.collapsed === "boolean") config.collapsed = patch.collapsed;
    writeJson(configFile, config);
  });
}

async function startServer() {
  const routes = {};
  if (dev) {
    routes["/state"] = (_req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(huddle.snapshot()));
    routes["/shot"] = async (_req, res) => {
      const image = await win.webContents.capturePage();
      res.writeHead(200, { "content-type": "image/png" }).end(image.toPNG());
    };
    // Settles the oldest held request, the way a click would, for checks run from a script.
    routes["/decide"] = (_req, res, url) => {
      const [id, entry] = [...held.entries()][0] ?? [];
      if (!id) return res.writeHead(404).end();
      const choice = url.searchParams.get("choice") ?? "pass";
      if (entry.kind === "question" && choice === "allow") {
        const questions = entry.payload.tool_input?.questions ?? [];
        answer(id, Object.fromEntries(questions.map((item) => [item.question, item.options?.[0]?.label ?? ""])));
      } else {
        decide(id, choice);
      }
      res.writeHead(204).end();
    };
  }
  server = createHookServer({ pipePath: pipePath(), token: loadToken(), onEvent, onHeld, routes });
  await server.listen();
}

if (!demo && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.on("window-all-closed", () => {});
  app.on("before-quit", () => {
    quitting = true;
    for (const id of [...held.keys()]) release(id, null);
    if (!demo) writeJson(stateFile, huddle.serialize());
    server?.close();
  });

  app.whenReady().then(async () => {
    if (demo) loadDemo(huddle, startView);
    else huddle.restore(readJson(stateFile, null));
    huddle.subscribe(onChange);
    setInterval(() => huddle.sweep(), 30_000);
    wireIpc();
    createWindow();
    createTray();
    if (!demo) {
      refreshRelay();
      try {
        await startServer();
      } catch (error) {
        console.error(`could not listen for sessions: ${error.message}`);
      }
    }
    if (shotPath) {
      setTimeout(async () => {
        const image = await win.webContents.capturePage();
        writeFileSync(shotPath, image.toPNG());
        app.exit(0);
      }, 2600);
    }
  });
}
