import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let editorPath;
function findEditor() {
  if (editorPath !== undefined) return editorPath;
  editorPath = null;
  if (process.platform !== "win32") return editorPath;
  try {
    const launcher = execFileSync("where.exe", ["code"], { encoding: "utf8", windowsHide: true })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /code\.cmd$/i.test(line));
    const candidate = launcher ? path.join(path.dirname(launcher), "..", "Code.exe") : null;
    if (candidate && existsSync(candidate)) editorPath = candidate;
  } catch {}
  return editorPath;
}

// Brings forward the VS Code window open on a folder, or opens one.
function openFolder(shell, cwd, then = () => {}) {
  const editor = findEditor();
  if (editor && cwd) execFile(editor, [cwd], { windowsHide: true }, () => then());
  else if (cwd) shell.openPath(cwd).then(() => then());
}

// Walks up from the session's process to the first one with a visible window
// and brings that window forward. A session inside VS Code's own terminal stops
// at VS Code, which is handled by folder instead.
export function focusScript(pid) {
  return `
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class HuddleWindow {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
}
"@
$id = ${pid}
for ($i = 0; $i -lt 12 -and $id -gt 0; $i++) {
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($p -and $p.ProcessName -eq 'Code') { Write-Output 'Code'; exit 0 }
  if ($p -and $p.MainWindowHandle -ne 0 -and [HuddleWindow]::IsWindowVisible($p.MainWindowHandle)) {
    if ([HuddleWindow]::IsIconic($p.MainWindowHandle)) { [HuddleWindow]::ShowWindow($p.MainWindowHandle, 9) | Out-Null }
    [HuddleWindow]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
    Write-Output $p.ProcessName
    exit 0
  }
  $id = [int](Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue).ParentProcessId
}
Write-Output 'none'
`;
}

function focusTerminal(shell, session, done) {
  if (process.platform !== "win32" || !Number.isInteger(session.pid) || session.pid <= 0) return openFolder(shell, session.cwd);
  const encoded = Buffer.from(focusScript(session.pid), "utf16le").toString("base64");
  execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { windowsHide: true, timeout: 10_000 }, (_error, stdout) => {
    const found = String(stdout ?? "").trim();
    if (found === "Code") openFolder(shell, session.cwd);
    done?.(found);
  });
}

// Takes you to where a session runs. A VS Code session goes to its own tab: the
// window on its folder comes forward first, because the extension's link is
// handled by the VS Code window used last. A terminal session brings its
// terminal window forward. A session that has not said where it runs opens its
// folder, as before.
export function goToSession(shell, session, done) {
  if (!session) return;
  if (/vscode/i.test(session.origin ?? "") && SESSION_ID.test(session.id)) {
    openFolder(shell, session.cwd, () => {
      setTimeout(() => {
        shell.openExternal(`vscode://anthropic.claude-code/open?session=${encodeURIComponent(session.id)}`).then(() => done?.("vscode"), () => done?.("failed"));
      }, 400);
    });
    return;
  }
  if (session.origin) return focusTerminal(shell, session, done);
  openFolder(shell, session.cwd, () => done?.("folder"));
}
