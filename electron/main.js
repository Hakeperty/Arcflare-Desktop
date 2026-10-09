// ArcFlare desktop — main process.
//
// The window, the IPC surface the UI talks through, and a file protocol for
// showing generated images, meshes and audio. The renderer runs sandboxed with
// no Node access; everything it can do is listed in preload.js.

const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, nativeTheme, systemPreferences } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const eng = require("./engine");
const image = require("./image");
const remote = require("./remote")(eng);
const agents = require("./agent")(eng);
const updater = require("./updater")({
  send: (ch, p) => send(ch, p),
  // On unless switched off in Settings; stored in the shared config.json.
  enabled: () => serve.loadConfig().desktopUpdates !== false,
});
const serve = require("arcflare/lib/serve");

const DEV_URL = process.env.ARCFLARE_DEV_URL;
let win = null;

// ------------------------------------------------------------ file access ----
//
// arcfile://local/?p=<path> — readable only if the app made it (studio
// folder, generator output) or the person picked it in a dialog. A renderer
// that can read any path is a renderer that can read ~/.ssh.

protocol.registerSchemesAsPrivileged([
  { scheme: "arcfile", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

const granted = new Set();
function grant(p) { if (p) granted.add(path.resolve(p)); return p; }

function allowed(p) {
  const abs = path.resolve(p);
  if (granted.has(abs)) return true;
  const roots = [eng.studioDir(), path.join(serve.HOME, "gen", "out")];
  return roots.some((r) => abs === r || abs.startsWith(path.resolve(r) + path.sep));
}

function fileFromUrl(u) {
  // arcfile://local/?p=<encoded absolute path>
  return new URL(u).searchParams.get("p") || "";
}

// ------------------------------------------------------------------ window ----

function createWindow() {
  nativeTheme.themeSource = "dark";
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: "#0b0b0a",
    title: "ArcFlare",
    show: false,
    // Our own title bar, with the OS's window controls kept (overlay on
    // Windows/Linux, traffic lights inset on macOS).
    titleBarStyle: "hidden",
    titleBarOverlay: process.platform === "darwin" ? undefined : { color: "#0b0b0a", symbolColor: "#a09d93", height: 36 },
    trafficLightPosition: { x: 14, y: 11 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  win.once("ready-to-show", () => win.show());
  // Never leave the window invisible: if the page has not painted in a few
  // seconds, show it anyway so an error is visible rather than nothing at all.
  setTimeout(() => { if (win && !win.isDestroyed() && !win.isVisible()) win.show(); }, 4000);
  win.webContents.on("did-fail-load", (_e, code, desc, url) => console.error(`[load] ${code} ${desc} ${url}`));
  win.webContents.on("render-process-gone", (_e, d) => console.error(`[renderer] gone: ${d.reason}`));
  win.webContents.on("console-message", (e) => {
    const { level, message, lineNumber, sourceId } = e;
    if (level === "error" || level === "warning" || level === 3 || level === 2) console.error(`[page] ${message} (${sourceId}:${lineNumber})`);
  });
  // Links open in the browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => {
    if (DEV_URL && url.startsWith(DEV_URL)) return;
    if (!url.startsWith("file:")) { e.preventDefault(); shell.openExternal(url); }
  });
  if (DEV_URL) win.loadURL(DEV_URL);
  else win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// Engine events → renderer.
for (const ev of ["model:progress", "model:loaded", "model:unloaded", "chat:delta", "job:update", "rc:status", "rc:turn", "agent:item", "agent:delta", "agent:status"]) {
  eng.bus.on(ev, (p) => {
    if (ev === "job:update" && p.state === "done" && p.result && p.result.file) grant(p.result.file);
    send(ev, p);
  });
}

// --------------------------------------------------------------------- ipc ----

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (e) {
      return { ok: false, error: e.message, log: e.log || null };
    }
  });
}

handle("sys:info", () => eng.systemInfo());

handle("settings:get", () => {
  const c = serve.loadConfig();
  return {
    llamaServer: c.llamaServer || "",
    memoryProfile: c.memoryProfile || serve.DEFAULT_PROFILE,
    studioVram: c.studioVram || "auto",
    sdcpp: c.sdcpp || "",
    imageModelsDir: c.imageModelsDir || "",
    comfyUrl: c.comfyUrl || "http://127.0.0.1:8188",
    genPython: c.genPython || "",
    stopServerOnQuit: c.stopServerOnQuit !== false,
    desktopUpdates: c.desktopUpdates !== false,
  };
});
handle("settings:set", (patch) => {
  const allowedKeys = ["llamaServer", "memoryProfile", "studioVram", "sdcpp", "imageModelsDir", "comfyUrl", "genPython", "stopServerOnQuit", "desktopUpdates"];
  const c = serve.loadConfig();
  for (const k of Object.keys(patch || {})) if (allowedKeys.includes(k)) c[k] = patch[k];
  serve.saveConfig(c);
  return true;
});

handle("models:list", () => eng.listModels());
handle("models:load", (id, opts) => eng.loadModel(id, opts));
handle("models:unload", () => eng.unloadModel());

handle("chat:send", (requestId, payload) => eng.chat(requestId, payload));
handle("chat:stop", (requestId) => eng.stopChat(requestId));

// Updates (see updater.js).
handle("update:status", () => updater.status());
handle("update:check", () => updater.check());
handle("update:install", () => updater.install());

// Control from your phone (see remote.js).
handle("rc:start", () => remote.start());
handle("rc:stop", () => remote.stop());
handle("rc:status", () => remote.status());
handle("rc:say", (text) => remote.say(text));
handle("rc:clear", () => remote.clear());

// The coding agent, on a folder the person picked (see agent.js).
// Folders picked for the agent are remembered, so they reopen without the
// dialog after a restart; anything else has to come through the picker.
const RECENT = path.join(serve.HOME, "desktop-agent-folders.json");
function recentFolders() { try { return JSON.parse(fs.readFileSync(RECENT, "utf8")).filter((x) => typeof x === "string"); } catch { return []; } }
handle("agent:recent", () => recentFolders().filter((f) => fs.existsSync(f)));
handle("agent:open", (folder, opts) => {
  const dir = path.resolve(String(folder || ""));
  if (!granted.has(dir) && !recentFolders().includes(dir)) throw new Error("pick the folder with the folder button");
  const r = agents.open(dir, opts || {});
  const list = [dir, ...recentFolders().filter((f) => f !== dir)].slice(0, 8);
  try { fs.mkdirSync(serve.HOME, { recursive: true }); fs.writeFileSync(RECENT, JSON.stringify(list, null, 2)); } catch { /* not fatal */ }
  return r;
});
handle("agent:state", (id) => agents.state(id));
handle("agent:list", () => agents.list());
handle("agent:send", (id, text) => agents.send(id, text));
handle("agent:stop", (id) => agents.stop(id));
handle("agent:answer", (id, approvalId, allow, always) => agents.answer(id, approvalId, allow, always));
handle("agent:auto", (id, on) => agents.setAuto(id, on));
handle("agent:clear", (id) => agents.clear(id));
handle("agent:close", (id) => agents.close(id));
handle("edit:plan", (req) => eng.planEdit(req));

handle("gen:status", () => eng.genStatus());
handle("gen:setup", (id, opts) => eng.genSetup(id, opts));
handle("gen:3d", (opts) => {
  if (opts.image) grant(opts.image);
  return eng.generate3d(opts);
});
handle("gen:tts", (opts) => {
  if (opts.ref) grant(opts.ref);
  return eng.speak(opts);
});

// The voice studio: saved voices live in the engine (~/.arcflare/voices), so
// `arcflare gen tts --clone <name>` uses the same ones.
const gv = require("arcflare/lib/gen/voices");
function publicVoice(v) {
  grant(v.clip);
  return { id: v.id, name: v.name, text: v.text || "", lang: v.lang || null, clip: v.clip,
    seconds: v.seconds, created: v.created, advice: gv.advice(v.seconds) };
}
handle("voices:list", () => gv.list().map(publicVoice));
handle("voices:save", (opts = {}) => {
  // Only a clip the person recorded here or picked in the dialog.
  if (!opts.clip || !allowed(opts.clip)) throw new Error("record a clip or pick one with browse");
  return publicVoice(gv.save({ name: opts.name, clip: opts.clip, text: opts.text, lang: opts.lang, replace: !!opts.replace }));
});
handle("voices:update", (id, patch = {}) => publicVoice(gv.update(id, { text: patch.text, lang: patch.lang, label: patch.name })));
handle("voices:remove", (id) => gv.remove(id));
handle("voices:writeTake", (bytes) => {
  // A take recorded in the voice studio, as WAV. Kept apart from the studio's
  // own outputs so recordings don't fill the speech tab's "recent" list.
  const dir = path.join(eng.studioDir(), "recordings");
  fs.mkdirSync(dir, { recursive: true });
  const buf = Buffer.from(bytes);
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF") throw new Error("not a WAV recording");
  const out = path.join(dir, `take-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.wav`);
  fs.writeFileSync(out, buf);
  return grant(out);
});
handle("voices:micAccess", async () => {
  // macOS asks once per app; elsewhere the OS does not gate it here.
  if (process.platform !== "darwin") return true;
  if (systemPreferences.getMediaAccessStatus("microphone") === "granted") return true;
  return systemPreferences.askForMediaAccess("microphone");
});

handle("image:models", () => image.listImageModels(serve.loadConfig()));
handle("image:generate", (opts) => {
  const c = serve.loadConfig();
  const out = eng.stamp("image", "png");
  const needGb = opts.lowVram ? 2 : 6;
  if (opts.backend === "comfy") {
    if (!opts.workflow) throw new Error("pick a ComfyUI workflow (API format .json)");
    return eng.studioJob("image", "Image · ComfyUI", (o) => image.comfyRun(c.comfyUrl || "http://127.0.0.1:8188",
      opts.workflow, { prompt: opts.prompt, negative: opts.negative || "", seed: opts.seed ?? Math.floor(Math.random() * 2 ** 31) },
      out, o), 0);
  }
  return eng.studioJob("image", `Image · ${path.basename(opts.model || "")}`, (o) => image.sdGenerate(c, { ...opts, out }, o), needGb);
});
handle("comfy:status", () => image.comfyStatus(serve.loadConfig().comfyUrl || "http://127.0.0.1:8188"));

handle("jobs:list", () => eng.jobs());
handle("jobs:cancel", (id) => eng.cancelJob(id));

handle("hub:catalogue", (refresh) => eng.hubCatalogue(refresh));
handle("hub:install", (slug, model) => eng.hubInstall(slug, model));

handle("harness:list", () => eng.harnessList());
handle("harness:launch", (id, modelId) => eng.launchHarness(id, modelId));

handle("files:pick", async (opts = {}) => {
  const r = await dialog.showOpenDialog(win, {
    properties: [opts.directory ? "openDirectory" : "openFile"],
    filters: opts.filters || [],
    title: opts.title,
  });
  if (r.canceled || !r.filePaths[0]) return null;
  return grant(r.filePaths[0]);
});
handle("files:saveAs", async (src, opts = {}) => {
  if (!allowed(src)) throw new Error("not a file this app created or opened");
  const r = await dialog.showSaveDialog(win, { defaultPath: path.basename(src), filters: opts.filters || [] });
  if (r.canceled || !r.filePath) return null;
  fs.copyFileSync(src, r.filePath);
  return r.filePath;
});
handle("files:writeBytes", (name, bytes) => {
  // For edited meshes: the renderer exports a .glb; it lands in the studio folder.
  const safe = path.basename(String(name)).replace(/[^\w.\-]+/g, "_") || "export.bin";
  const out = path.join(eng.studioDir(), safe);
  fs.writeFileSync(out, Buffer.from(bytes));
  return grant(out);
});
handle("files:reveal", (p) => { if (allowed(p)) shell.showItemInFolder(p); return true; });
handle("files:openStudio", () => shell.openPath(eng.studioDir()));
handle("files:list", (kind) => {
  const ext = { image: /\.(png|jpe?g|webp)$/i, mesh: /\.glb$/i, audio: /\.wav$/i }[kind] || /.*/;
  const dir = eng.studioDir();
  return fs.readdirSync(dir)
    .filter((f) => ext.test(f))
    .map((f) => {
      const p = path.join(dir, f);
      const st = fs.statSync(p);
      return { path: p, name: f, bytes: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 200);
});
handle("open:external", (url) => {
  if (!/^https?:\/\//.test(String(url))) throw new Error("only web links");
  shell.openExternal(url);
  return true;
});

// --------------------------------------------------------------- lifecycle ----

app.whenReady().then(() => {
  protocol.handle("arcfile", (req) => {
    const p = fileFromUrl(req.url);
    if (!allowed(p) || !fs.existsSync(p)) return new Response("not allowed", { status: 403 });
    return net.fetch(pathToFileURL(p).toString());
  });
  createWindow();
  updater.start();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => {
  updater.stop();
  remote.shutdown();
  agents.shutdown();
  // llama-server is started detached so the CLI can share it; the app stops it
  // on quit unless the person chose to keep it (Settings).
  eng.shutdown({ stopServer: serve.loadConfig().stopServerOnQuit !== false });
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => eng.shutdown({ stopServer: serve.loadConfig().stopServerOnQuit !== false }));
