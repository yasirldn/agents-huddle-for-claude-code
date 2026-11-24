const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("huddle", {
  boot: () => ipcRenderer.invoke("boot"),
  connect: () => ipcRenderer.invoke("connect"),
  onState: (listener) => ipcRenderer.on("state", (_event, state) => listener(state)),
  onConnection: (listener) => ipcRenderer.on("connection", (_event, state) => listener(state)),
  decide: (id, choice) => ipcRenderer.send("decide", id, choice),
  answer: (id, answers) => ipcRenderer.send("answer", id, answers),
  dismiss: (sessionId) => ipcRenderer.send("dismiss", sessionId),
  open: (sessionId) => ipcRenderer.send("open", sessionId),
  minimize: () => ipcRenderer.send("minimize"),
  resize: (height) => ipcRenderer.send("resize", height),
  setConfig: (patch) => ipcRenderer.send("config", patch),
});
