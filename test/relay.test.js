import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createHookServer } from "../src/main/server.js";
import { pipePath } from "../src/shared/paths.js";

const relay = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "hook", "relay.mjs");
const TOKEN = "a".repeat(48);
const dataWithToken = mkdtempSync(path.join(os.tmpdir(), "agents-huddle-relay-"));
const dataWithout = mkdtempSync(path.join(os.tmpdir(), "agents-huddle-relay-"));
writeFileSync(path.join(dataWithToken, "token"), TOKEN);
after(() => {
  rmSync(dataWithToken, { recursive: true, force: true });
  rmSync(dataWithout, { recursive: true, force: true });
});

let counter = 0;
const testPipe = () => {
  const name = `agents-huddle-test-${process.pid}-${++counter}`;
  return process.platform === "win32" ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), `${name}.sock`);
};

function runRelay(pipe, args, input, data = dataWithToken) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [relay, ...args], { env: { ...process.env, AGENTS_HUDDLE_PIPE: pipe, AGENTS_HUDDLE_DATA: data } });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.on("close", (code) => resolve({ code, stdout }));
    child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
    return child;
  });
}

test("the relay and the app agree on the pipe path", () => {
  assert.match(pipePath({}), /agents-huddle-/);
  assert.equal(pipePath({ AGENTS_HUDDLE_PIPE: "x" }), "x");
});

test("with no widget running the relay exits quietly", async () => {
  const result = await runRelay(testPipe(), ["permission", "5"], { hook_event_name: "PermissionRequest" });
  assert.deepEqual(result, { code: 0, stdout: "" });
});

test("input that is not JSON is ignored", async () => {
  const result = await runRelay(testPipe(), ["event"], "not json");
  assert.deepEqual(result, { code: 0, stdout: "" });
});

test("a background event is delivered, trimmed and stamped, and prints nothing", async () => {
  const pipe = testPipe();
  const seen = [];
  const server = createHookServer({ pipePath: pipe, token: TOKEN, onEvent: (payload) => seen.push(payload), onHeld: () => {} });
  await server.listen();
  try {
    const result = await runRelay(pipe, ["event"], {
      hook_event_name: "PostToolUse",
      session_id: "s",
      tool_input: { content: "x".repeat(9000) },
      tool_response: { stdout: "a".repeat(5000) + "END" },
    });
    assert.deepEqual(result, { code: 0, stdout: "" });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].tool_input.content.length, 4000);
    assert.equal(seen[0].tool_response.stdout.endsWith("END"), true);
    assert.equal(typeof seen[0].huddle_at, "number");
  } finally {
    await server.close();
  }
});

const allow = { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } };

test("a held request prints the decision it is given, with the request passed through whole", async () => {
  const pipe = testPipe();
  let seen;
  const server = createHookServer({
    pipePath: pipe,
    token: TOKEN,
    onEvent: () => {},
    onHeld: (held) => {
      seen = held.payload;
      setTimeout(() => held.respond(allow), 50);
    },
  });
  await server.listen();
  try {
    const result = await runRelay(pipe, ["permission", "5"], { hook_event_name: "PermissionRequest", session_id: "s", tool_name: "Write", tool_input: { content: "y".repeat(9000) } });
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), allow);
    assert.equal(seen.tool_input.content.length, 9000);
  } finally {
    await server.close();
  }
});

test("a listener that cannot prove the secret receives nothing and cannot decide", async () => {
  const pipe = testPipe();
  let received = 0;
  const server = createHookServer({
    pipePath: pipe,
    token: "b".repeat(48),
    onEvent: () => received++,
    onHeld: (held) => (received++, held.respond(allow)),
  });
  await server.listen();
  try {
    const decision = await runRelay(pipe, ["permission", "5"], { hook_event_name: "PermissionRequest", session_id: "s", tool_name: "Write", tool_input: {} });
    const event = await runRelay(pipe, ["event"], { hook_event_name: "Stop", session_id: "s" });
    assert.deepEqual(decision, { code: 0, stdout: "" });
    assert.deepEqual(event, { code: 0, stdout: "" });
    assert.equal(received, 0);
  } finally {
    await server.close();
  }
});

const sign = (...parts) => createHmac("sha256", TOKEN).update(parts.join(":")).digest("hex");
const digest = (text) => createHash("sha256").update(text).digest("hex");

function getRaw(pipe, route, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: pipe, path: route, method: "GET", headers }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode, proof: res.headers["x-agents-huddle-proof"] }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("the widget signs nothing for a caller that does not know the secret", async () => {
  const pipe = testPipe();
  const server = createHookServer({ pipePath: pipe, token: TOKEN, onEvent: () => {}, onHeld: () => {} });
  await server.listen();
  try {
    assert.deepEqual(await getRaw(pipe, "/hello?nonce=abc"), { status: 403, proof: undefined });
    assert.deepEqual(await getRaw(pipe, "/hello?nonce=abc", { "x-agents-huddle-client": "f".repeat(64) }), { status: 403, proof: undefined });
    assert.deepEqual(await getRaw(pipe, "/hello?nonce=abc", { "x-agents-huddle-client": sign("client", "abc") }), { status: 204, proof: sign("hello", "abc") });
  } finally {
    await server.close();
  }
});

test("a decision whose proof does not cover its exact text is ignored", async () => {
  const pipe = testPipe();
  const fake = http.createServer((req, res) => {
    const url = new URL(req.url, "http://local");
    if (req.method === "GET") return res.writeHead(204, { "x-agents-huddle-proof": sign("hello", url.searchParams.get("nonce")) }).end();
    req.resume();
    req.on("end", () => {
      const nonce = req.headers["x-agents-huddle-nonce"];
      const text = JSON.stringify(allow);
      const other = JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny" } } });
      res.writeHead(200, { "x-agents-huddle-proof": sign("decision", nonce, digest(other)) }).end(text);
    });
  });
  await new Promise((resolve) => fake.listen(pipe, resolve));
  try {
    const result = await runRelay(pipe, ["permission", "5"], { hook_event_name: "PermissionRequest", session_id: "s", tool_name: "Write", tool_input: {} });
    assert.deepEqual(result, { code: 0, stdout: "" });
  } finally {
    await new Promise((resolve) => fake.close(resolve));
  }
});

test("with no secret saved, a request is not sent at all", async () => {
  const pipe = testPipe();
  let held = 0;
  const server = createHookServer({ pipePath: pipe, token: TOKEN, onEvent: () => {}, onHeld: (request) => (held++, request.respond(allow)) });
  await server.listen();
  try {
    const result = await runRelay(pipe, ["permission", "5"], { hook_event_name: "PermissionRequest", session_id: "s" }, dataWithout);
    assert.deepEqual(result, { code: 0, stdout: "" });
    assert.equal(held, 0);
  } finally {
    await server.close();
  }
});

test("a held request that is passed back prints nothing", async () => {
  const pipe = testPipe();
  const server = createHookServer({ pipePath: pipe, token: TOKEN, onEvent: () => {}, onHeld: (held) => held.respond(null) });
  await server.listen();
  try {
    const result = await runRelay(pipe, ["question", "5"], { hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: { questions: [] } });
    assert.deepEqual(result, { code: 0, stdout: "" });
  } finally {
    await server.close();
  }
});

test("the widget learns when a held request goes away, and the relay gives up after its wait", async () => {
  const pipe = testPipe();
  let gone = false;
  const server = createHookServer({ pipePath: pipe, token: TOKEN, onEvent: () => {}, onHeld: (held) => (held.onGone = () => (gone = true)) });
  await server.listen();
  try {
    const result = await runRelay(pipe, ["permission", "1"], { hook_event_name: "PermissionRequest", session_id: "s" });
    assert.deepEqual(result, { code: 0, stdout: "" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(gone, true);
  } finally {
    await server.close();
  }
});
