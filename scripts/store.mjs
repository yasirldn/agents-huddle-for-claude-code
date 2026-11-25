// Builds the Microsoft Store package.
// The three identity values come from the app's Product identity page in Partner Center:
//   STORE_IDENTITY_NAME, STORE_PUBLISHER and STORE_PUBLISHER_NAME
// Without them, a package with test values is built, which the Store will not accept.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// The app is built into its own folder, so a copy running from dist does not get in the way.
const { scripts } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const build = spawnSync(scripts.package.replace("--out=dist ", "--out=dist-store/app "), { cwd: root, stdio: "inherit", shell: true });
const app = path.join(root, "dist-store", "app", "Agents Huddle-win32-x64");
if (build.status !== 0 || !existsSync(path.join(app, "Agents Huddle.exe"))) {
  console.error("The app could not be built, so there is nothing to package.");
  process.exit(1);
}

const overrides = [
  ["identityName", process.env.STORE_IDENTITY_NAME],
  ["publisher", process.env.STORE_PUBLISHER],
  ["publisherDisplayName", process.env.STORE_PUBLISHER_NAME],
]
  .filter(([, value]) => value)
  .map(([key, value]) => `-c.appx.${key}=${value}`);
if (overrides.length < 3) console.log("Building a test package. Set the three STORE_ values to build the one for the Store.");

const cli = path.join(root, "node_modules", "electron-builder", "cli.js");
const result = spawnSync(process.execPath, [cli, "--win", "appx", "--x64", "--prepackaged", app, ...overrides], { cwd: root, stdio: "inherit" });
process.exit(result.status ?? 1);
