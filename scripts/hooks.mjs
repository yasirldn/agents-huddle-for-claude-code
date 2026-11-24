// Connects or disconnects the widget from the command line.
// Usage: node scripts/hooks.mjs install | remove | status
import path from "node:path";
import { fileURLToPath } from "node:url";
import { install, status, uninstall } from "../src/main/hooks-config.js";
import { claudeSettingsPath, installedRelayPath } from "../src/shared/paths.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const settingsPath = claudeSettingsPath();
const relayTarget = installedRelayPath();
const command = process.argv[2];

try {
  if (command === "install") {
    const result = install({ settingsPath, relayTarget, relaySource: path.join(here, "..", "src", "hook", "relay.mjs") });
    console.log(`Connected. Hooks added to ${result.settingsPath}`);
    console.log(`Settings as they were before the first install are kept at ${result.backupPath}`);
    console.log("Sessions that are already open pick the hooks up after a restart.");
  } else if (command === "remove") {
    const result = uninstall({ settingsPath });
    console.log(result.changed ? `Disconnected. Hooks removed from ${result.settingsPath}` : "Nothing to remove.");
  } else if (command === "status") {
    const result = status({ settingsPath, relayTarget });
    console.log(result.error ?? (result.connected ? "Connected" : "Not connected"));
  } else {
    console.error("Usage: node scripts/hooks.mjs install | remove | status");
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
