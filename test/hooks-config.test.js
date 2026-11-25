import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { addHooks, buildGroups, hasHooks, install, relaysInSettings, removeHooks, status, uninstall } from "../src/main/hooks-config.js";

const groups = buildGroups({ node: "node", relay: path.join("C:", "data", "agents-huddle", "hook", "agents-huddle-relay.mjs"), holdSeconds: 300 });

const existing = {
  model: "x",
  hooks: {
    PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "powershell.exe", args: ["-File", "check.ps1"] }] }],
  },
};

test("adding keeps other hooks and is safe to repeat", () => {
  const once = addHooks(existing, groups);
  const twice = addHooks(once, groups);
  assert.deepEqual(once, twice);
  assert.equal(once.hooks.PreToolUse.length, 3);
  assert.deepEqual(once.hooks.PreToolUse[0], existing.hooks.PreToolUse[0]);
  assert.equal(hasHooks(once), true);
  assert.equal(hasHooks(existing), false);
  assert.deepEqual(existing.hooks.PreToolUse.length, 1);
});

test("removing restores the settings exactly", () => {
  assert.deepEqual(removeHooks(addHooks(existing, groups)), existing);
  assert.deepEqual(removeHooks(addHooks({ model: "x" }, groups)), { model: "x" });
});

test("removing keeps a hook someone else added to one of the widget's groups", () => {
  const settings = addHooks(existing, groups);
  const mine = { type: "command", command: "notify.exe" };
  settings.hooks.Stop[0].hooks.push(mine);
  const cleaned = removeHooks(settings);
  assert.deepEqual(cleaned.hooks.Stop, [{ hooks: [mine] }]);
  assert.equal(hasHooks(cleaned), false);
});

test("the widget's hooks are recognised wherever its data folder is", () => {
  const elsewhere = buildGroups({ node: "node", relay: "D:\\tools\\huddle-data\\hook\\agents-huddle-relay.mjs" });
  const settings = addHooks(existing, elsewhere);
  assert.equal(hasHooks(settings), true);
  assert.deepEqual(removeHooks(settings), existing);
  const unrelated = { hooks: { Stop: [{ hooks: [{ type: "command", command: "node", args: ["C:\\other\\hook\\relay.mjs"] }] }] } };
  assert.equal(hasHooks(unrelated), false);
});

test("only the two deciding hooks can hold a session", () => {
  const all = Object.entries(groups).flatMap(([event, list]) => list.flatMap((group) => group.hooks.map((hook) => ({ event, matcher: group.matcher, ...hook }))));
  const blocking = all.filter((hook) => !hook.async && hook.timeout > 10);
  assert.deepEqual(blocking.map((hook) => `${hook.event}:${hook.matcher}:${hook.args[1]}`).sort(), ["PermissionRequest:*:permission", "PreToolUse:AskUserQuestion:question"]);
  for (const hook of blocking) {
    assert.equal(hook.timeout, 330);
    assert.equal(hook.args[2], "315");
  }
});

test("install and uninstall round-trip a settings file, keeping its formatting and a backup", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agents-huddle-test-"));
  try {
    const settingsPath = path.join(dir, "settings.json");
    const relaySource = path.join(dir, "relay-source.mjs");
    const relayTarget = path.join(dir, "data", "hook", "agents-huddle-relay.mjs");
    const original = JSON.stringify(existing, null, 4).replace(/\n/g, "\r\n") + "\r\n";
    writeFileSync(settingsPath, original);
    writeFileSync(relaySource, "// relay");

    assert.equal(status({ settingsPath, relayTarget }).connected, false);
    const result = install({ settingsPath, relaySource, relayTarget, node: "node" });
    assert.equal(existsSync(relayTarget), true);
    assert.equal(readFileSync(result.backupPath, "utf8"), original);
    assert.equal(status({ settingsPath, relayTarget }).connected, true);

    install({ settingsPath, relaySource, relayTarget, node: "node" });
    assert.equal(readFileSync(result.backupPath, "utf8"), original, "a second install must not overwrite the backup");

    assert.equal(uninstall({ settingsPath }).changed, true);
    assert.equal(readFileSync(settingsPath, "utf8"), original);
    assert.equal(uninstall({ settingsPath }).changed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a settings file that is not valid JSON is left alone", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agents-huddle-test-"));
  try {
    const settingsPath = path.join(dir, "settings.json");
    writeFileSync(settingsPath, "{ broken");
    writeFileSync(path.join(dir, "relay.mjs"), "");
    assert.throws(() => install({ settingsPath, relaySource: path.join(dir, "relay.mjs"), relayTarget: path.join(dir, "agents-huddle", "hook", "relay.mjs"), node: "node" }), /not valid JSON/);
    assert.equal(readFileSync(settingsPath, "utf8"), "{ broken");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the relay paths the widget's hooks point at can be read back", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agents-huddle-test-"));
  try {
    const settingsPath = path.join(dir, "settings.json");
    const old = path.win32.join("C:", "Users", "x", "AppData", "Roaming", "agents-huddle", "hook", "agents-huddle-relay.mjs");
    writeFileSync(settingsPath, JSON.stringify(addHooks(existing, buildGroups({ node: "node", relay: old }))));
    assert.deepEqual(relaysInSettings(settingsPath), [old]);
    writeFileSync(settingsPath, JSON.stringify(existing));
    assert.deepEqual(relaysInSettings(settingsPath), []);
    assert.deepEqual(relaysInSettings(path.join(dir, "missing.json")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
