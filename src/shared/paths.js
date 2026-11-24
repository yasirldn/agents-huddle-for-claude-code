import os from "node:os";
import path from "node:path";

export const APP_ID = "agents-huddle";

const safeUser = () => os.userInfo().username.replace(/[^A-Za-z0-9_-]/g, "_");

// The relay script computes the same pipe path on its own, so keep the two in step.
export function pipePath(env = process.env) {
  if (env.AGENTS_HUDDLE_PIPE) return env.AGENTS_HUDDLE_PIPE;
  return process.platform === "win32" ? `\\\\.\\pipe\\${APP_ID}-${safeUser()}` : path.join(os.tmpdir(), `${APP_ID}-${safeUser()}.sock`);
}

export function dataDir(env = process.env) {
  if (env.AGENTS_HUDDLE_DATA) return env.AGENTS_HUDDLE_DATA;
  if (process.platform === "win32") return path.join(env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), APP_ID);
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", APP_ID);
  return path.join(env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), APP_ID);
}

export function tokenPath(env = process.env) {
  return path.join(dataDir(env), "token");
}

export function claudeSettingsPath(env = process.env) {
  return path.join(env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), "settings.json");
}

// The file name marks the hooks as the widget's own, wherever the data folder is.
export const RELAY_FILE = "agents-huddle-relay.mjs";

export function installedRelayPath(env = process.env) {
  return path.join(dataDir(env), "hook", RELAY_FILE);
}
