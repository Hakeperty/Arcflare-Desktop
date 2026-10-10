// The whole surface the UI has: invoke a named channel, listen to a named
// event. Nothing else from Node or Electron reaches the page.

const { contextBridge, ipcRenderer } = require("electron");

const CHANNELS = new Set([
  "sys:info", "settings:get", "settings:set",
  "setup:state", "setup:find", "setup:folder", "setup:done",
  "models:list", "models:load", "models:unload",
  "chat:send", "chat:stop", "edit:plan",
  "rc:start", "rc:stop", "rc:status", "rc:say", "rc:clear",
  "agent:open", "agent:recent", "agent:state", "agent:list", "agent:send", "agent:stop", "agent:answer", "agent:auto", "agent:clear", "agent:close",
  "update:status", "update:check", "update:install",
  "gen:status", "gen:setup", "gen:3d", "gen:tts",
  "image:models", "image:generate", "comfy:status",
  "jobs:list", "jobs:cancel",
  "hub:catalogue", "hub:install",
  "harness:list", "harness:launch",
  "files:pick", "files:saveAs", "files:saveText", "files:writeBytes", "files:reveal", "files:openStudio", "files:list",
  "artifact:view",
  "open:external",
]);
const EVENTS = new Set(["model:progress", "model:loaded", "model:unloaded", "chat:delta", "job:update", "rc:status", "rc:turn", "update:status", "agent:item", "agent:delta", "agent:status"]);

contextBridge.exposeInMainWorld("arc", {
  platform: process.platform,
  invoke(channel, ...args) {
    if (!CHANNELS.has(channel)) return Promise.reject(new Error(`unknown channel ${channel}`));
    return ipcRenderer.invoke(channel, ...args);
  },
  on(event, fn) {
    if (!EVENTS.has(event)) throw new Error(`unknown event ${event}`);
    const listener = (_e, payload) => fn(payload);
    ipcRenderer.on(event, listener);
    return () => ipcRenderer.removeListener(event, listener);
  },
});
