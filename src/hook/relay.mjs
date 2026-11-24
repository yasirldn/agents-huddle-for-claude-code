// Forwards one hook event to the Agents Huddle widget over a local pipe.
// It always exits 0 and prints nothing unless the widget returns a decision,
// so sessions behave as usual whenever the widget is closed.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const started = Date.now();
const kind = ["permission", "question"].includes(process.argv[2]) ? process.argv[2] : "event";
const waitSeconds = Number(process.argv[3]) > 0 ? Number(process.argv[3]) : 315;
const MAX_TEXT = 4000;

const done = () => process.exit(0);
process.on("uncaughtException", done);
process.on("unhandledRejection", done);
setTimeout(done, kind === "event" ? 1500 : waitSeconds * 1000);

// The app keeps the same two locations in shared/paths.js.
const user = os.userInfo().username.replace(/[^A-Za-z0-9_-]/g, "_");
function pipePath() {
  if (process.env.AGENTS_HUDDLE_PIPE) return process.env.AGENTS_HUDDLE_PIPE;
  return process.platform === "win32" ? `\\\\.\\pipe\\agents-huddle-${user}` : path.join(os.tmpdir(), `agents-huddle-${user}.sock`);
}
function dataDir() {
  if (process.env.AGENTS_HUDDLE_DATA) return process.env.AGENTS_HUDDLE_DATA;
  if (process.platform === "win32") return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "agents-huddle");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "agents-huddle");
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "agents-huddle");
}

// The widget keeps a secret in this user's own folder. The relay and whoever
// listens on the pipe each prove they know it before anything is sent, and a
// decision counts only if its proof covers its exact text. Each proof names its
// purpose, so one cannot stand in for another. The secret never crosses the pipe.
let token = "";
try {
  token = readFileSync(path.join(dataDir(), "token"), "utf8").trim();
} catch {}
if (!token) done();
const nonce = randomBytes(16).toString("hex");
const sign = (...parts) => createHmac("sha256", token).update(parts.join(":")).digest("hex");
const digest = (text) => createHash("sha256").update(text).digest("hex");
const client = sign("client", nonce);

// File contents and command output can run to megabytes. For background events
// the widget only shows a summary, so long strings are cut. Output keeps its end.
function trim(value, key = "", depth = 0) {
  if (typeof value === "string") {
    if (value.length <= MAX_TEXT) return value;
    return key === "stdout" || key === "stderr" ? value.slice(-MAX_TEXT) : value.slice(0, MAX_TEXT);
  }
  if (depth > 8) return null;
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => trim(item, key, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, trim(v, k, depth + 1)]));
  return value;
}

if (process.stdin.isTTY) done();

let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;

let body;
try {
  const parsed = JSON.parse(raw);
  // Background hooks can reach the widget out of order, so each carries its start time.
  parsed.huddle_at = started;
  // Requests go through whole, so the widget shows exactly what would be approved.
  body = JSON.stringify(kind === "event" ? trim(parsed) : parsed);
} catch {
  done();
}

function call(method, route, headers = {}, payload) {
  return new Promise((resolve) => {
    const request = http.request({ socketPath: pipePath(), path: route, method, headers }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => (text += chunk));
      response.on("end", () => resolve({ status: response.statusCode, proof: response.headers["x-agents-huddle-proof"], text }));
      response.on("error", done);
    });
    request.on("error", done);
    request.end(payload);
  });
}

const hello = await call("GET", `/hello?nonce=${nonce}`, { "x-agents-huddle-client": client });
if (hello.proof !== sign("hello", nonce)) done();

const reply = await call(
  "POST",
  `/hook/${kind}`,
  { "content-type": "application/json", "content-length": Buffer.byteLength(body), "x-agents-huddle-nonce": nonce, "x-agents-huddle-client": client },
  body,
);
if (kind === "event" || reply.status !== 200 || !reply.text) done();
if (reply.proof !== sign("decision", nonce, digest(reply.text))) done();
try {
  JSON.parse(reply.text);
} catch {
  done();
}
process.stdout.write(reply.text, done);
