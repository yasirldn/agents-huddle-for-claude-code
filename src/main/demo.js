// Fills the widget with made-up sessions, for looking at the interface without
// any real agent running. Started with: npm run demo
const WORK = "C:\\work";

export function loadDemo(huddle, view = "list") {
  if (view === "empty") return () => {};
  const send = (id, folder, name, extra = {}) => huddle.apply({ session_id: id, cwd: `${WORK}\\${folder}`, hook_event_name: name, ...extra });
  const task = (id, folder, taskId, subject, activeForm) =>
    send(id, folder, "PostToolUse", { tool_name: "TaskCreate", tool_input: { subject, activeForm }, tool_response: { task: { id: String(taskId) } } });
  const mark = (id, folder, taskId, status) => send(id, folder, "PostToolUse", { tool_name: "TaskUpdate", tool_input: { taskId: String(taskId), status } });
  let toolSeq = 0;
  const tool = (id, folder, tool_name, tool_input, tool_response) => {
    const tool_use_id = `demo-${++toolSeq}`;
    send(id, folder, "PreToolUse", { tool_name, tool_use_id, tool_input });
    if (tool_response !== undefined) send(id, folder, "PostToolUse", { tool_name, tool_use_id, tool_input, tool_response });
  };

  const a = ["a", "weather-station"];
  send(...a, "UserPromptSubmit", { prompt: "Add hourly rainfall to the dashboard" });
  [
    ["Read the station logs", "Reading the station logs"],
    ["Clean the gaps in the readings", "Cleaning the gaps in the readings"],
    ["Add the hourly rainfall query", "Adding the hourly rainfall query"],
    ["Draw the rainfall chart", "Drawing the rainfall chart"],
    ["Compare with last year", "Comparing with last year"],
    ["Update the tests", "Updating the tests"],
    ["Write the change notes", "Writing the change notes"],
  ].forEach(([subject, active], index) => task(...a, index + 1, subject, active));
  [1, 2, 3].forEach((taskId) => mark(...a, taskId, "completed"));
  mark(...a, 4, "in_progress");
  tool(...a, "Read", { file_path: `${WORK}\\weather-station\\data\\readings.csv` }, {});
  tool(...a, "Edit", { file_path: `${WORK}\\weather-station\\src\\queries.py` }, {});
  tool(...a, "Bash", { command: "python -m pytest tests/test_queries.py", description: "Run the query tests" }, { stdout: "12 passed in 1.84s" });
  tool(...a, "Grep", { pattern: "rainfall_mm" }, {});
  tool(...a, "Edit", { file_path: `${WORK}\\weather-station\\src\\charts.py` }, {});
  tool(...a, "Bash", { command: "python scripts/render_charts.py", description: "Draw the rainfall chart" });

  const b = ["b", "recipe-app"];
  send(...b, "UserPromptSubmit", { prompt: "Fix the share link text" });
  tool(...b, "Read", { file_path: `${WORK}\\recipe-app\\src\\share\\ShareLink.tsx` }, {});
  tool(...b, "Edit", { file_path: `${WORK}\\recipe-app\\src\\share\\ShareLink.tsx` }, {});
  if (view === "question") {
    huddle.addRequest("question", {
      session_id: "b",
      cwd: `${WORK}\\recipe-app`,
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [
          {
            question: "Which share link should the tests cover?",
            header: "Share link",
            multiSelect: false,
            options: [
              { label: "Recipe link", description: "The link that opens one recipe" },
              { label: "Shopping list link", description: "The link that opens a shopping list" },
              { label: "Both", description: "Run the two suites one after the other" },
            ],
          },
        ],
      },
    });
  } else if (view !== "collapsed") {
    huddle.addRequest("permission", {
      session_id: "b",
      cwd: `${WORK}\\recipe-app`,
      tool_name: "Bash",
      tool_input: { command: "npm run test:e2e -- share.spec.ts", description: "Run the share link tests" },
    });
  }

  const c = ["c", "agents-huddle"];
  send(...c, "UserPromptSubmit", { prompt: "Tighten the widget spacing" });
  [
    ["Measure the rows", "Measuring the rows"],
    ["Fix the header", "Fixing the header"],
    ["Fix the list", "Fixing the list"],
    ["Fix the detail view", "Fixing the detail view"],
    ["Check at 125% scaling", "Checking at 125% scaling"],
  ].forEach(([subject, active], index) => task(...c, index + 1, subject, active));
  [1, 2].forEach((taskId) => mark(...c, taskId, "completed"));
  mark(...c, 3, "in_progress");
  tool(...c, "Edit", { file_path: `${WORK}\\agents-huddle\\src\\renderer\\styles.css` });

  const d = ["d", "garden-planner"];
  send(...d, "UserPromptSubmit", { prompt: "Write the release notes for 2.3" });
  tool(...d, "Bash", { command: "git log v2.2..HEAD --oneline", description: "List the changes since 2.2" }, { stdout: "" });
  tool(...d, "Write", { file_path: `${WORK}\\garden-planner\\CHANGELOG.md` }, {});
  send(...d, "Stop", { last_assistant_message: "Release notes written, 14 changes covered" });

  // A little movement so the working agents read as live.
  const beats = [
    () => tool(...c, "Read", { file_path: `${WORK}\\agents-huddle\\src\\renderer\\app.js` }, {}),
    () => tool(...c, "Edit", { file_path: `${WORK}\\agents-huddle\\src\\renderer\\styles.css` }),
    () => tool(...a, "Bash", { command: "python scripts/render_charts.py", description: "Draw the rainfall chart" }),
  ];
  let beat = 0;
  const timer = setInterval(() => beats[beat++ % beats.length](), 3200);
  return () => clearInterval(timer);
}
