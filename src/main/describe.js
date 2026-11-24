export function clip(text, max) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + "…" : flat;
}

export function baseName(file) {
  return String(file ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "";
}

function relativeTo(file, cwd) {
  const full = String(file ?? "");
  const root = String(cwd ?? "");
  if (root && full.toLowerCase().startsWith(root.toLowerCase())) return full.slice(root.length).replace(/^[\\/]+/, "") || full;
  return full;
}

const words = (name) => String(name ?? "").replace(/[_-]+/g, " ").trim();

function mcpParts(name) {
  const [, server = "", tool = ""] = String(name).split("__");
  return { server: words(server), tool: words(tool) };
}

// What an agent is doing right now, in a few words, plus the kind of work it is.
export function describeTool(name, input = {}) {
  const tool = String(name ?? "");
  const file = baseName(input.file_path ?? input.notebook_path ?? input.path);
  if (tool === "Read") return { kind: "read", label: file ? `Reading ${file}` : "Reading a file" };
  if (tool === "Write") return { kind: "edit", label: file ? `Writing ${file}` : "Writing a file" };
  if (tool === "Edit" || tool === "MultiEdit" || tool === "NotebookEdit") return { kind: "edit", label: file ? `Editing ${file}` : "Editing a file" };
  if (tool === "Bash" || tool === "PowerShell") return { kind: "shell", label: input.description ? clip(input.description, 60) : `Running ${clip(input.command, 44)}` };
  if (tool === "Grep") return { kind: "search", label: input.pattern ? `Searching for ${clip(input.pattern, 36)}` : "Searching the code" };
  if (tool === "Glob") return { kind: "search", label: input.pattern ? `Finding ${clip(input.pattern, 40)}` : "Finding files" };
  if (tool === "WebSearch") return { kind: "web", label: input.query ? `Searching the web for ${clip(input.query, 30)}` : "Searching the web" };
  if (tool === "WebFetch") return { kind: "web", label: "Reading a web page" };
  if (tool === "Agent" || tool === "Task") return { kind: "agent", label: input.description ? `Delegating ${clip(input.description, 44)}` : "Briefing a subagent" };
  if (tool === "TodoWrite" || tool === "TaskCreate" || tool === "TaskUpdate" || tool === "TaskList" || tool === "TaskGet") return { kind: "plan", label: "Updating the plan" };
  if (tool === "AskUserQuestion") return { kind: "ask", label: "Asking you a question" };
  if (tool === "Skill") return { kind: "skill", label: input.skill ? `Loading the ${clip(input.skill, 36)} skill` : "Loading a skill" };
  if (tool === "ToolSearch") return { kind: "search", label: "Looking up a tool" };
  if (tool.startsWith("mcp__")) {
    const { server, tool: action } = mcpParts(tool);
    return { kind: "tool", label: clip(`Using ${action || server}`, 60) };
  }
  return { kind: "tool", label: `Using ${words(tool) || "a tool"}` };
}

// Longer than this and the request is not shown in full, so it cannot be allowed here.
export const MAX_DETAIL = 20_000;

// For each tool, the fields the card shows in its own way and the fields that
// change nothing about what runs. Every other field is listed under the main
// text, so nothing that would be approved is hidden.
const SHOWN = {
  Bash: { shown: ["command"], quiet: ["description", "timeout"] },
  PowerShell: { shown: ["command"], quiet: ["description", "timeout"] },
  Write: { shown: ["file_path", "content"] },
  Edit: { shown: ["file_path", "old_string", "new_string"] },
  MultiEdit: { shown: ["file_path", "edits"] },
  NotebookEdit: { shown: ["notebook_path", "new_source"] },
  Read: { shown: ["file_path"], quiet: ["offset", "limit"] },
  WebFetch: { shown: ["url"], quiet: ["prompt"] },
  WebSearch: { shown: ["query"] },
};

function otherFields(tool, input) {
  const spec = SHOWN[tool];
  if (!spec) return [];
  const skip = new Set([...spec.shown, ...(spec.quiet ?? [])]);
  return Object.entries(input ?? {})
    .filter(([key, value]) => !skip.has(key) && value !== undefined && value !== null && value !== "" && value !== false)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
}

const lines = (text) => String(text ?? "").split(/\r?\n/);
const diff = (before, after) => [...lines(before).map((line) => `- ${line}`), ...lines(after).map((line) => `+ ${line}`)].join("\n");

function request(tool, input, title, main, { where = "", mono = true } = {}) {
  const text = [String(main ?? ""), ...otherFields(tool, input)].filter(Boolean).join("\n\n");
  let note = "";
  if (input?.dangerouslyDisableSandbox === true) note = "Asks to run outside the sandbox, so decide in the tab";
  else if (text.length > MAX_DETAIL) note = "Too long to show in full here, so decide in the tab";
  return { title, where, detail: text.slice(0, MAX_DETAIL), mono, tabOnly: Boolean(note), note };
}

// A file request names the file in its heading, so its path is only worth
// showing when it adds a folder.
function fileRequest(tool, input, verb, file, cwd, main) {
  const name = baseName(file);
  const where = relativeTo(file, cwd);
  return request(tool, input, `${verb} ${name || "a file"}`, main, { where: where && where !== name ? where : "" });
}

// What a permission request is asking for: a heading and the exact text that would be approved.
export function describeRequest(name, input = {}, cwd = "") {
  const tool = String(name ?? "");
  const data = input ?? {};
  if (tool === "Bash" || tool === "PowerShell") return request(tool, data, "Run a command", data.command);
  if (tool === "Write") return fileRequest(tool, data, "Write", data.file_path, cwd, data.content);
  if (tool === "Edit") return fileRequest(tool, data, "Edit", data.file_path, cwd, diff(data.old_string, data.new_string));
  if (tool === "MultiEdit") {
    const edits = (data.edits ?? []).map((edit) => [diff(edit.old_string, edit.new_string), ...otherFields("Edit", edit)].join("\n")).join("\n\n");
    return fileRequest(tool, data, "Edit", data.file_path, cwd, edits);
  }
  if (tool === "NotebookEdit") return fileRequest(tool, data, "Edit", data.notebook_path, cwd, data.new_source);
  if (tool === "Read") return fileRequest(tool, data, "Read", data.file_path, cwd, "");
  if (tool === "WebFetch") return request(tool, data, "Fetch a web page", data.url);
  if (tool === "WebSearch") return request(tool, data, "Search the web", data.query, { mono: false });
  const detail = JSON.stringify(data, null, 1);
  if (tool.startsWith("mcp__")) {
    const { server, tool: action } = mcpParts(tool);
    return request(tool, data, clip(`Use ${action || server}${action && server ? ` in ${server}` : ""}`, 60), detail);
  }
  return request(tool, data, `Use ${words(tool) || "a tool"}`, detail);
}
