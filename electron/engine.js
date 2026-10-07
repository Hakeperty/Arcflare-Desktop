// The bridge between the app and the ArcFlare engine (github.com/Hakeperty/ArcFlare-Code).
//
// Everything here runs in Electron's main process and reuses the engine's own
// modules — model discovery, context planning, llama-server supervision,
// generation — so the app and the CLI can never disagree about how a model is
// loaded or how much context it gets. This file adds only what a GUI needs on
// top: one place that knows which chat model is loaded, a job system that
// reports progress as events, and GPU-memory arbitration between chat and the
// studio.

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const { EventEmitter } = require("events");

const serve = require("arcflare/lib/serve");
const models = require("arcflare/lib/models");
const engine = require("arcflare/lib/engine");
const gen = require("arcflare/lib/gen");
const hub = require("arcflare/lib/hub");
const harness = require("arcflare/lib/harness");
const { ResidentPool } = require("arcflare/lib/gen/resident");

const ARCFLARE_BIN = require.resolve("arcflare/bin/arcflare.js");
const bus = new EventEmitter();
const pool = new ResidentPool();
const runner = pool.runner();

// ------------------------------------------------------------------ state ----

const state = {
  loaded: null,          // { id, servedId, port, ctx, name }
  lastModelId: null,     // what to reload after the studio borrowed the GPU
  loading: null,         // Promise while a load is in flight
  freedForStudio: false,
};

function cfg() { return serve.loadConfig(); }

function gb(bytes) { return bytes == null ? null : Math.round((bytes / 1e9) * 10) / 10; }

// ----------------------------------------------------------------- system ----

async function systemInfo() {
  const c = cfg();
  let mem = { freeBytes: null, totalBytes: null };
  try { mem = serve.deviceMemory(c); } catch { /* no backend probed yet */ }
  const st = await engine.status(c.port || serve.DEFAULT_PORT).catch(() => ({ running: false }));
  const py = gen.findPython(c);
  return {
    platform: process.platform,
    arch: process.arch,
    engineVersion: require("arcflare/package.json").version,
    gpu: { freeGb: gb(mem.freeBytes), totalGb: gb(mem.totalBytes) },
    ramGb: gb(os.totalmem()),
    llamaServer: engine.findServer(c.llamaServer, c.backend),
    serverRunning: !!st.running,
    loaded: state.loaded,
    python: py ? py.path : null,
    home: serve.HOME,
  };
}

// ----------------------------------------------------------------- models ----

function listModels() {
  const all = models.discover({ meta: true });
  models.flushMetaCache && models.flushMetaCache();
  const c = cfg();
  let freeBytes = null;
  try { freeBytes = serve.freeDeviceBytes(c); } catch { /* unknown */ }
  return all.map((m) => {
    const meta = m.meta || {};
    const plan = freeBytes ? serve.contextChoices(m, freeBytes) : null;
    return {
      id: m.id,
      name: meta.name || m.id.split(":")[0],
      file: m.file,
      sizeGb: gb(m.size),
      quant: meta.quant || (m.id.split(":")[1] || "").toUpperCase(),
      trainCtx: meta.trainCtx || null,
      moe: meta.expertCount ? `${meta.expertUsed}/${meta.expertCount}` : null,
      vision: !!(m.mmproj || meta.hasVision),
      bestCtx: plan ? plan.best.ctx : null,
      fits: freeBytes ? m.size + 1.5e9 < freeBytes : null,
    };
  });
}

function findModel(id) {
  const all = models.discover({ meta: true });
  return models.resolve(all, id);
}

/** Load a chat model, reporting each step on the bus as "model:progress". */
async function loadModel(id, opts = {}) {
  if (state.loading) await state.loading.catch(() => {});
  const m = findModel(id);
  if (!m) throw new Error(`no model "${id}"`);
  const run = (async () => {
    bus.emit("model:progress", { id, stage: "planning" });
    const r = await serve.loadModel(cfg(), m, {
      ctx: opts.ctx,
      onProgress: (p) => bus.emit("model:progress", { id, ...p }),
    });
    if (r.failed) {
      state.loaded = null;
      const e = new Error(r.error || "the model failed to load");
      e.log = r.log;
      throw e;
    }
    state.loaded = { id: m.id, servedId: r.servedId, port: r.port, ctx: r.ctx, name: (m.meta && m.meta.name) || m.id };
    state.lastModelId = m.id;
    state.freedForStudio = false;
    const c = cfg();
    serve.saveConfig({ ...c, lastModel: m.id });
    bus.emit("model:loaded", state.loaded);
    return state.loaded;
  })();
  state.loading = run;
  try { return await run; } finally { state.loading = null; }
}

function unloadModel() {
  engine.stop();
  state.loaded = null;
  bus.emit("model:unloaded", {});
}

/** Chat needs a model: reload the last one if the studio borrowed the GPU. */
async function ensureChatModel() {
  if (state.loading) return state.loading;
  if (state.loaded) {
    const st = await engine.status(state.loaded.port).catch(() => ({ running: false }));
    if (st.running) return state.loaded;
    state.loaded = null;
  }
  const id = state.lastModelId || cfg().lastModel;
  if (!id) throw new Error("no model loaded — pick one first");
  bus.emit("model:progress", { id, stage: "reloading" });
  return loadModel(id);
}

// ------------------------------------------------------------------- chat ----

const chats = new Map(); // requestId -> http.ClientRequest

/**
 * Stream a chat completion. Deltas go out as "chat:delta" events; resolves
 * with the final text and timings. `stop(requestId)` aborts it.
 */
async function chat(requestId, { messages, temperature, maxTokens }) {
  const m = await ensureChatModel();
  const body = JSON.stringify({
    model: m.servedId,
    messages,
    stream: true,
    temperature: temperature ?? 0.7,
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
    // Ask llama.cpp for its own timings in the final chunk.
    timings_per_token: false,
  });
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port: m.port, path: "/v1/chat/completions", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), Connection: "close" },
    }, (res) => {
      if (res.statusCode >= 400) {
        let err = "";
        res.on("data", (d) => (err += d));
        res.on("end", () => reject(new Error(`the model answered ${res.statusCode}: ${err.slice(0, 200)}`)));
        return;
      }
      let buf = "";
      let text = "";
      let timings = null;
      res.on("data", (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            const j = JSON.parse(payload);
            if (j.timings) timings = j.timings;
            const d0 = j.choices && j.choices[0] && j.choices[0].delta;
            if (!d0) continue;
            if (d0.reasoning_content) bus.emit("chat:delta", { requestId, kind: "reasoning", text: d0.reasoning_content });
            if (d0.content) { text += d0.content; bus.emit("chat:delta", { requestId, kind: "content", text: d0.content }); }
          } catch { /* keep-alive or partial line */ }
        }
      });
      res.on("end", () => {
        chats.delete(requestId);
        resolve({
          text,
          tokPerSec: timings && timings.predicted_per_second ? Math.round(timings.predicted_per_second * 10) / 10 : null,
          promptTokens: timings ? timings.prompt_n : null,
          outputTokens: timings ? timings.predicted_n : null,
        });
      });
      res.on("error", reject);
    });
    req.on("error", (e) => { chats.delete(requestId); reject(e); });
    chats.set(requestId, req);
    req.end(body);
  });
}

function stopChat(requestId) {
  const req = chats.get(requestId);
  if (req) { req.destroy(new Error("stopped")); chats.delete(requestId); }
}

/**
 * Turn an edit instruction plus a selection description into a list of mesh
 * operations, using the loaded chat model. Returns null when no model is
 * loaded — the renderer then falls back to its own keyword parser.
 */
async function planEdit({ instruction, selection, ops }) {
  if (!state.loaded) return null;
  const system = `You turn a request to edit a 3D mesh into JSON operations. Reply with ONLY a JSON array, no prose.
Available operations (applied to the SELECTED region unless "target":"all"):
${ops.map((o) => `- ${o}`).join("\n")}
The selection: ${JSON.stringify(selection)}.
Use small, conservative amounts unless the request is emphatic.`;
  const r = await chat(`plan-${Date.now()}`, {
    messages: [{ role: "system", content: system }, { role: "user", content: instruction }],
    temperature: 0.2,
    maxTokens: 400,
  });
  const m = /\[[\s\S]*\]/.exec(r.text);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// ------------------------------------------------------------------- jobs ----
//
// Everything slow — downloads, setups, generations — is a job: an id, a kind,
// a state and a stream of events on the bus ("job:update"). The renderer shows
// them all in one tray, and the app can be closed with a job running.

const jobs = new Map();
let jobSeq = 0;

function newJob(kind, title, meta = {}) {
  const job = { id: `job${++jobSeq}`, kind, title, state: "running", stage: "starting", progress: null,
    log: [], result: null, error: null, started: Date.now(), meta };
  jobs.set(job.id, job);
  bus.emit("job:update", publicJob(job));
  return job;
}

function publicJob(j) {
  const { abort, ...rest } = j;
  return { ...rest, log: j.log.slice(-60) };
}

function update(job, patch) {
  Object.assign(job, patch);
  bus.emit("job:update", publicJob(job));
}

function logLine(job, line) {
  job.log.push(line);
  if (job.log.length > 400) job.log.splice(0, job.log.length - 400);
  bus.emit("job:update", publicJob(job));
}

/** Run a CLI command as a job (pull, gen setup), streaming its output. */
function cliJob(kind, title, args, meta) {
  const job = newJob(kind, title, meta);
  const child = spawn(process.execPath, [ARCFLARE_BIN, ...args], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
    windowsHide: true,
  });
  job.abort = () => { try { child.kill(); } catch { /* gone */ } };
  const onData = (d) => {
    for (const raw of d.toString().split(/\r?\n|\r/)) {
      const line = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trimEnd();
      if (!line.trim()) continue;
      const pct = /(\d{1,3}(?:\.\d+)?)%/.exec(line);
      if (pct) update(job, { progress: Math.min(100, Number(pct[1])) });
      logLine(job, line);
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("close", (code) => update(job, code === 0
    ? { state: "done", progress: 100, stage: "done" }
    : { state: "failed", error: `exited with code ${code}` }));
  return publicJob(job);
}

// --------------------------------------------------------------- studio vram --

/**
 * Before a studio job: if chat holds the GPU and the job needs room, and the
 * setting allows it, stop the chat server. Chat reloads it on the next message.
 */
async function makeRoomFor(needGb) {
  const c = cfg();
  if ((c.studioVram || "auto") !== "auto" || !state.loaded) return false;
  let free = null;
  try { free = serve.freeDeviceBytes(c) / 1e9; } catch { /* unknown */ }
  if (free != null && free > needGb + 1) return false;
  engine.stop();
  state.loaded = null;
  state.freedForStudio = true;
  bus.emit("model:unloaded", { reason: "studio" });
  await new Promise((r) => setTimeout(r, 1000));
  return true;
}

function studioJob(kind, title, run, needGb) {
  const job = newJob(kind, title);
  const ac = new AbortController();
  job.abort = () => ac.abort();
  (async () => {
    try {
      if (await makeRoomFor(needGb || 0)) logLine(job, "freed the chat model's GPU memory for this job");
      const r = await run({
        signal: ac.signal,
        runner,
        onEvent: (ev) => {
          if (ev.event === "stage") update(job, { stage: ev.stage });
          if (ev.event === "info" && ev.device) logLine(job, `device: ${ev.device}`);
          if (ev.event === "info" && ev.cache) logLine(job, `model cache: ${ev.cache}`);
          if (ev.event === "progress" && typeof ev.pct === "number") update(job, { progress: ev.pct });
        },
      });
      update(job, { state: "done", stage: "done", progress: 100, result: r });
    } catch (e) {
      update(job, { state: "failed", error: e.message, stderr: e.stderr ? String(e.stderr).split("\n").slice(-15) : null });
    }
  })();
  return publicJob(job);
}

function studioDir() {
  const dir = path.join(require("electron").app.getPath("documents"), "ArcFlare Studio");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function stamp(prefix, ext) {
  const t = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return path.join(studioDir(), `${prefix}-${t}.${ext}`);
}

function generate3d(opts) {
  const m = gen.byId(opts.model);
  return studioJob("3d", `3D · ${m ? m.label : opts.model}`, (o) => gen.generate(cfg(), {
    ...opts, out: opts.out || stamp("mesh", "glb"), ...o,
  }), m ? m.vram : 6);
}

function speak(opts) {
  const m = gen.byId(opts.model, "tts");
  return studioJob("tts", `Speech · ${m ? m.label : opts.model}`, (o) => gen.speak(cfg(), {
    ...opts, out: opts.out || stamp("speech", "wav"), ...o,
  }), m ? m.vram : 4);
}

function genSetup(id, opts = {}) {
  const args = ["gen", "setup", id];
  if (opts.torch) args.push("--torch", opts.torch);
  if (opts.torchFrom) args.push("--torch-from", opts.torchFrom);
  if (opts.texture) args.push("--texture");
  return cliJob("setup", `Set up ${id}`, args, { model: id });
}

function genStatus() {
  const c = cfg();
  return gen.status(c).map((r) => ({
    id: r.id, kind: r.kind, label: r.label, params: r.params, vram: r.vram, note: r.note,
    cloning: !!r.cloning, instruct: !!r.instruct, text: !!r.text, texture: !!r.texture,
    installed: !!r.repoPresent && !!r.python, weights: !!r.weights, voices: r.voices || null,
    defaultVoice: r.defaultVoice || null,
  }));
}

// -------------------------------------------------------------------- hub ----

async function hubCatalogue(refresh) {
  const c = cfg();
  const r = await hub.load({ cfg: c, refresh: !!refresh });
  let freeGb = null;
  try { freeGb = serve.freeDeviceBytes(c) / 1e9; } catch { /* unknown */ }
  return {
    source: r.source, url: r.url, ageText: hub.ageText(r.age), freeGb,
    models: r.data.models.map((m) => ({ ...m, fit: hub.fit(m, freeGb), plan: hub.installPlan(m) })),
  };
}

function hubInstall(slug, m) {
  const plan = hub.installPlan(m);
  if (plan.kind === "none") throw new Error("this hub entry has no install command yet");
  return cliJob(plan.kind === "pull" ? "download" : "setup", `${plan.kind === "pull" ? "Download" : "Set up"} ${m.name}`, plan.argv, { slug });
}

// --------------------------------------------------------------- harnesses ----

function harnessList() {
  return harness.list().map((h) => ({ id: h.id, label: h.label, installed: !!h.installed, builtin: !!h.builtin, bin: h.bin || null }));
}

/**
 * Open a harness in a real terminal window, pointed at a model. Harnesses are
 * terminal programs; the honest thing is to give them a terminal.
 */
function launchHarness(id, modelId) {
  const args = ["use", id, ...(modelId ? [modelId] : [])];
  const node = process.execPath;
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  if (process.platform === "win32") {
    // A new console window titled ArcFlare, running the CLI with Electron's Node.
    spawn("cmd.exe", ["/d", "/c", "start", '"ArcFlare"', node, ARCFLARE_BIN, ...args], {
      env, detached: true, stdio: "ignore", windowsHide: false,
    }).unref();
  } else if (process.platform === "darwin") {
    const cmd = [node, ARCFLARE_BIN, ...args].map((a) => `'${String(a).replace(/'/g, "'\\''")}'`).join(" ");
    spawn("osascript", ["-e", `tell application "Terminal" to do script "ELECTRON_RUN_AS_NODE=1 ${cmd.replace(/"/g, '\\"')}"`], {
      detached: true, stdio: "ignore",
    }).unref();
  } else {
    const terms = [["x-terminal-emulator", ["-e"]], ["gnome-terminal", ["--"]], ["konsole", ["-e"]], ["xterm", ["-e"]]];
    for (const [t, pre] of terms) {
      try {
        spawn(t, [...pre, node, ARCFLARE_BIN, ...args], { env, detached: true, stdio: "ignore" }).unref();
        break;
      } catch { /* try the next terminal */ }
    }
  }
  return true;
}

// ------------------------------------------------------------------- misc ----

function cancelJob(id) {
  const j = jobs.get(id);
  if (j && j.abort) { j.abort(); update(j, { state: "cancelled" }); }
}

function shutdown({ stopServer = true } = {}) {
  for (const j of jobs.values()) if (j.state === "running" && j.abort) j.abort();
  pool.stopAll();
  if (stopServer) { try { engine.stop(); } catch { /* not running */ } }
}

module.exports = {
  bus, systemInfo, listModels, loadModel, unloadModel, chat, stopChat, planEdit,
  generate3d, speak, genSetup, genStatus, hubCatalogue, hubInstall,
  harnessList, launchHarness, cancelJob, jobs: () => [...jobs.values()].map(publicJob),
  studioDir, stamp, studioJob, cliJob, makeRoomFor, shutdown, cfg, state, pool,
};
