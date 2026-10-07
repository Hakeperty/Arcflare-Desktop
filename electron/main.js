// ArcFlare desktop — main process.
//
// The window, the IPC surface the UI talks through, and a file protocol for
// showing generated images, meshes and audio. The renderer runs sandboxed with
// no Node access; everything it can do is listed in preload.js.

const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, nativeTheme } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const eng = require("./engine");
const image = require("./image");
const remote = require("./remote")(eng);
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
for (const ev of ["model:progress", "model:loaded", "model:unloaded", "chat:delta", "job:update", "rc:status", "rc:turn"]) {
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
  // llama-server is started detached so the CLI can share it; the app stops it
  // on quit unless the person chose to keep it (Settings).
  eng.shutdown({ stopServer: serve.loadConfig().stopServerOnQuit !== false });
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => eng.shutdown({ stopServer: serve.loadConfig().stopServerOnQuit !== false }));
