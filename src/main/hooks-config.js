import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RELAY_FILE } from "../shared/paths.js";

export const DEFAULT_HOLD_SECONDS = 300;

const isOurHook = (hook) => (hook?.args ?? []).some((arg) => path.basename(String(arg).replace(/\\/g, "/")).toLowerCase() === RELAY_FILE);
const isOurs = (group) => (group?.hooks ?? []).some(isOurHook);

// The hook groups the widget needs. Background hooks only report what happened
// and never delay a session. The two deciding hooks wait for an answer.
export function buildGroups({ node, relay, holdSeconds = DEFAULT_HOLD_SECONDS }) {
  const background = () => ({ type: "command", command: node, args: [relay, "event"], timeout: 10, async: true });
  const deciding = (kind) => ({ type: "command", command: node, args: [relay, kind, String(holdSeconds + 15)], timeout: holdSeconds + 30 });
  return {
    SessionStart: [{ hooks: [background()] }],
    UserPromptSubmit: [{ hooks: [background()] }],
    PreToolUse: [
      { matcher: "*", hooks: [background()] },
      { matcher: "AskUserQuestion", hooks: [deciding("question")] },
    ],
    PermissionRequest: [{ matcher: "*", hooks: [deciding("permission")] }],
    PostToolUse: [{ matcher: "*", hooks: [background()] }],
    PostToolUseFailure: [{ matcher: "*", hooks: [background()] }],
    Notification: [{ hooks: [background()] }],
    Stop: [{ hooks: [background()] }],
    StopFailure: [{ hooks: [background()] }],
    SubagentStart: [{ hooks: [background()] }],
    SubagentStop: [{ hooks: [background()] }],
    SessionEnd: [{ hooks: [{ type: "command", command: node, args: [relay, "event"], timeout: 5 }] }],
  };
}

export function hasHooks(settings) {
  return Object.values(settings?.hooks ?? {}).some((groups) => Array.isArray(groups) && groups.some(isOurs));
}

export function removeHooks(settings) {
  const next = structuredClone(settings ?? {});
  if (!next.hooks) return next;
  for (const event of Object.keys(next.hooks)) {
    if (!Array.isArray(next.hooks[event])) continue;
    // Only the widget's own entries go. Anything else in a shared group stays.
    next.hooks[event] = next.hooks[event]
      .map((group) => (isOurs(group) ? { ...group, hooks: group.hooks.filter((hook) => !isOurHook(hook)) } : group))
      .filter((group, index) => !(isOurs(settings.hooks[event][index]) && group.hooks.length === 0));
    if (next.hooks[event].length === 0) delete next.hooks[event];
  }
  if (Object.keys(next.hooks).length === 0) delete next.hooks;
  return next;
}

export function addHooks(settings, groups) {
  const next = removeHooks(settings);
  next.hooks ??= {};
  for (const [event, list] of Object.entries(groups)) {
    next.hooks[event] = [...(next.hooks[event] ?? []), ...list];
  }
  return next;
}

function readSettings(file) {
  if (!existsSync(file)) return { settings: {}, indent: 2, eol: "\n", trailing: "\n", exists: false };
  const text = readFileSync(file, "utf8").replace(/^﻿/, "");
  let settings;
  try {
    settings = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON, so it was left untouched (${error.message})`);
  }
  const indent = /^\{\r?\n([ \t]+)"/.exec(text)?.[1] ?? 2;
  return { settings, indent, eol: text.includes("\r\n") ? "\r\n" : "\n", trailing: /\n$/.test(text) ? "\n" : "", exists: true };
}

function writeSettings(file, settings, format) {
  let text = JSON.stringify(settings, null, format.indent) + format.trailing;
  if (format.eol === "\r\n") text = text.replace(/\r?\n/g, "\r\n");
  // A linked settings file is written through to its target, so the link survives.
  const target = existsSync(file) ? realpathSync(file) : file;
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.agents-huddle-tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, target);
}

// Hooks run under Node. When this code runs inside the app, the app's own
// executable is not Node, so the system one is looked up.
export function findNode() {
  if (!process.versions.electron) return process.execPath;
  const finder = process.platform === "win32" ? "where.exe" : "which";
  try {
    const found = execFileSync(finder, ["node"], { encoding: "utf8", windowsHide: true })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    // On Windows a hook with an argument list needs the real executable, not a script shim.
    const pick = process.platform === "win32" ? found.find((line) => /\.exe$/i.test(line)) : found[0];
    if (pick) return pick;
  } catch {}
  throw new Error("Node.js was not found on this computer");
}

// The relay paths the widget's hooks in a settings file point at.
export function relaysInSettings(settingsPath) {
  try {
    const { settings } = readSettings(settingsPath);
    const found = Object.values(settings?.hooks ?? {})
      .flat()
      .flatMap((group) => group?.hooks ?? [])
      .filter(isOurHook)
      .flatMap((hook) => hook.args.filter((arg) => isOurHook({ args: [arg] })));
    return [...new Set(found)];
  } catch {
    return [];
  }
}

export function status({ settingsPath, relayTarget }) {
  try {
    return { connected: hasHooks(readSettings(settingsPath).settings) && existsSync(relayTarget) };
  } catch (error) {
    return { connected: false, error: error.message };
  }
}

export function install({ settingsPath, relaySource, relayTarget, node = findNode(), holdSeconds = DEFAULT_HOLD_SECONDS }) {
  const current = readSettings(settingsPath);
  mkdirSync(path.dirname(relayTarget), { recursive: true });
  // Read and write rather than copy, since inside the packaged app the source sits in an archive.
  writeFileSync(relayTarget, readFileSync(relaySource));
  const backupPath = `${settingsPath}.agents-huddle-backup`;
  if (current.exists && !hasHooks(current.settings)) copyFileSync(settingsPath, backupPath);
  writeSettings(settingsPath, addHooks(current.settings, buildGroups({ node, relay: relayTarget, holdSeconds })), current);
  return { settingsPath, backupPath, relayTarget };
}

export function uninstall({ settingsPath }) {
  const current = readSettings(settingsPath);
  if (!current.exists || !hasHooks(current.settings)) return { settingsPath, changed: false };
  writeSettings(settingsPath, removeHooks(current.settings), current);
  return { settingsPath, changed: true };
}
