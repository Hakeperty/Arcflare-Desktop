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

// Arcs (ArcFlare's own models) arrived in engine 1.3; an older engine has none.
let arcs = null;
try { arcs = require("arcflare/lib/arcs"); } catch { /* older engine */ }

// The ArcFlare Store (skills and MCP servers) arrived with the same engine as Arcs.
let storemod = null;
try { storemod = require("arcflare/lib/store"); } catch { /* older engine */ }

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

const chats = new Map(); // requestId -> http.ClientRequest, or null while the model is still (re)loading

/**
 * Stream a chat completion. Deltas go out as "chat:delta" events; resolves
 * with the final text and timings. `stop(requestId)` aborts it.
 */
async function chat(requestId, { messages, temperature, maxTokens }) {
  // Registered before the model is ready, so a stop pressed while it reloads
  // is remembered (stopChat removes the entry) instead of silently dropped.
  chats.set(requestId, null);
  let m;
  try { m = await ensureChatModel(); } catch (e) { chats.delete(requestId); throw e; }
  if (!chats.has(requestId)) throw new Error("stopped");
  // With an Arc chosen, its instructions go first and the chat's own system
  // prompt is added after them. They are put on here, in the main process, so
  // the page never holds them.
  const arc = activeArc();
  if (arc) {
    const own = messages[0] && messages[0].role === "system" ? messages[0].content : "";
    const rest = own ? messages.slice(1) : messages;
    messages = [{ role: "system", content: arcs.compose(arc, { surface: "chat", extra: own === DEFAULT_CHAT_SYSTEM ? "" : own }) }, ...rest];
    if (temperature == null && arc.sampling && arc.sampling.temperature != null) temperature = arc.sampling.temperature;
  }
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
        res.on("end", () => { chats.delete(requestId); reject(new Error(`the model answered ${res.statusCode}: ${err.slice(0, 200)}`)); });
        return;
      }
      let buf = "";
      let text = "";
      let timings = null;
      let failed = null;
      res.setEncoding("utf8"); // a multi-byte character split across two chunks stays whole
      res.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            const j = JSON.parse(payload);
            // A failure in the middle of a reply (out of GPU memory, say) arrives as an error object.
            if (j.error) { failed = String((j.error && j.error.message) || j.error).slice(0, 300); continue; }
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
        if (failed) return reject(new Error(`the model failed: ${failed}`));
        resolve({
          text,
          tokPerSec: timings && timings.predicted_per_second ? Math.round(timings.predicted_per_second * 10) / 10 : null,
          promptTokens: timings ? timings.prompt_n : null,
          outputTokens: timings ? timings.predicted_n : null,
        });
      });
      res.on("error", (e) => { chats.delete(requestId); reject(e); });
    });
    req.on("error", (e) => { chats.delete(requestId); reject(e); });
    chats.set(requestId, req);
    req.end(body);
  });
}

function stopChat(requestId) {
  const req = chats.get(requestId);
  chats.delete(requestId);
  if (req) req.destroy(new Error("stopped"));
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
    log: [], result: null, error: null, started: Date.now(), ended: null, meta };
  jobs.set(job.id, job);
  bus.emit("job:update", publicJob(job));
  return job;
}

function publicJob(j) {
  const { abort, ...rest } = j;
  return { ...rest, log: j.log.slice(-60) };
}

function update(job, patch) {
  // A finished job stays finished: a cancelled download's process still exits
  // (with a failure code) afterwards, and that must not turn it into "failed".
  if (job.state !== "running") return;
  Object.assign(job, patch);
  if (job.state !== "running") job.ended = Date.now();
  bus.emit("job:update", publicJob(job));
}

function logLine(job, line) {
  job.log.push(line);
  if (job.log.length > 400) job.log.splice(0, job.log.length - 400);
  bus.emit("job:update", publicJob(job));
}

/**
 * Why a CLI command failed, in its own words: the CLI marks the line that
 * says so with a cross. "exited with code 1" tells a person nothing.
 */
function failureReason(log) {
  for (let i = log.length - 1; i >= 0; i--) {
    const m = /^\s*[✗x×]\s+(.+)/.exec(log[i]);
    if (m) return m[1].trim();
  }
  return null;
}

/** Run a CLI command as a job (pull, gen setup, engine install), streaming its output. */
function cliJob(kind, title, args, meta) {
  const job = newJob(kind, title, meta);
  const child = spawn(process.execPath, [ARCFLARE_BIN, ...args], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
    windowsHide: true,
  });
  job.abort = () => { try { child.kill(); } catch { /* gone */ } };
  child.on("error", (e) => update(job, { state: "failed", error: e.message }));
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
    : { state: "failed", error: failureReason(job.log) || `exited with code ${code}` }));
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
      if (ac.signal.aborted) return; // cancelled before it started: don't start it
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

// ------------------------------------------------------------------- arcs ----
//
// ArcFlare's own models: an open base picked for this GPU, run under
// ArcFlare's instructions. The choice is `arc` in ~/.arcflare/config.json, the
// same setting `arcflare arcs use` writes, so the app and the CLI agree.

// The Chat screen's stock system prompt; an Arc replaces it rather than stacking on it.
const DEFAULT_CHAT_SYSTEM = "You are a helpful assistant running locally on the user's own computer. Be clear and concise.";

/** The Arc in use, or null. */
function activeArc() {
  if (!arcs) return null;
  const id = cfg().arc;
  return id ? arcs.find(id) : null;
}

/** What the Arcs screen shows: each Arc without its instructions, and what it would run on here. */
async function arcList(refresh) {
  if (!arcs) return { available: false, active: null, freeGb: null, source: "none", notice: [], arcs: [] };
  const c = cfg();
  const synced = await arcs.sync({ cfg: c, refresh: !!refresh });
  let freeGb = null;
  try { freeGb = serve.freeDeviceBytes(c) / 1e9; } catch { /* unknown */ }
  // Memory the loaded chat model holds comes back when another is loaded in its place.
  const local = models.discover({ meta: false });
  return {
    available: true, active: c.arc || null, freeGb, source: synced.source, notice: hub.UNCENSORED_NOTICE || [],
    arcs: arcs.all().map((a) => {
      const pick = arcs.pickBase(a, { local, freeGb: freeGb || null });
      return {
        ...arcs.publicView(a),
        pick: { base: pick.base, installed: pick.installed, fits: pick.fits, modelId: pick.model ? pick.model.id : null, recommended: pick.recommended },
      };
    }),
  };
}

/** Choose an Arc (loading its base model), or pass null to go back to plain models. */
async function arcUse(id) {
  if (!arcs) throw new Error("this version of the ArcFlare engine has no Arcs yet: update ArcFlare");
  const c = cfg();
  if (!id) {
    delete c.arc;
    serve.saveConfig(c);
    return { active: null, loaded: state.loaded };
  }
  const a = arcs.find(id);
  if (!a) throw new Error(`no Arc named ${id}`);
  let freeGb = null;
  try { freeGb = serve.freeDeviceBytes(c) / 1e9; } catch { /* unknown */ }
  const pick = arcs.pickBase(a, { local: models.discover({ meta: false }), freeGb: freeGb || null });
  if (!pick.model) throw new Error(`${a.name} runs on ${pick.base.slug}, which isn't on this machine yet: download it first`);
  if (!state.loaded || state.loaded.id !== pick.model.id) await loadModel(pick.model.id);
  serve.saveConfig({ ...cfg(), arc: a.id });
  return { active: a.id, loaded: state.loaded };
}

/** Download the base model an Arc runs on here. `accept` confirms the notice for an abliterated base. */
function arcInstall(id, accept) {
  if (!arcs) throw new Error("this version of the ArcFlare engine has no Arcs yet: update ArcFlare");
  const a = arcs.find(id);
  if (!a) throw new Error(`no Arc named ${id}`);
  if (a.side === "abliterated" && accept !== true) throw new Error("confirm the notice about abliterated models first");
  return cliJob("download", `Download ${a.name}`, ["arcs", "pull", a.id, ...(a.side === "abliterated" ? ["--accept-uncensored"] : [])], { arc: a.id });
}

// ------------------------------------------------------------------ store ----
//
// Skills and MCP servers, from the engine's store (arcflare/lib/store.js): the
// same catalogue and the same files `arcflare store` uses, so something added
// here is added for the command line too. Models are the hub, below.

async function storeList(refresh) {
  if (!storemod) return { available: false, source: "none", skills: [], mcp: [] };
  const { data, source } = await storemod.load({ cfg: cfg(), refresh: !!refresh });
  const onPath = (() => { try { return require("arcflare/lib/mcp/apps").onPath; } catch { return () => null; } })();
  return {
    available: true, source,
    skills: data.skills.map((s) => {
      const st = storemod.skillState(s);
      return { id: s.id, name: s.name, description: s.description, category: s.category, uses: s.uses || [], text: s.text,
        installed: st.installed, fromStore: !!st.fromStore, current: st.installed ? !!st.current : false };
    }),
    mcp: data.mcp.map((m) => {
      const spec = m.ours ? null : storemod.mcpSpec(m, []);
      return { id: m.id, name: m.name, by: m.by, description: m.description, ours: !!m.ours,
        // What would run, for a server someone else makes: shown before it is added.
        runs: spec ? `${spec.command} ${spec.args.join(" ")}` : null,
        needs: m.needs || null, hasNeeds: m.ours || !m.needs ? true : !!onPath(m.needs),
        argument: m.argument || null, homepage: m.homepage || null,
        installed: storemod.mcpState(m).installed };
    }),
  };
}

async function storeEntry(kind, id) {
  if (!storemod) throw new Error("this version of the ArcFlare engine has no store yet: update ArcFlare");
  const { data } = await storemod.load({ cfg: cfg() });
  const e = (kind === "skill" ? data.skills : data.mcp).find((x) => x.id === id);
  if (!e) throw new Error(`the store has no ${kind === "skill" ? "skill" : "MCP server"} called ${id}`);
  return e;
}

async function storeSkillAdd(id) { storemod && storemod.addSkill(await storeEntry("skill", id)); return storeList(); }
async function storeSkillRemove(id) { if (storemod) storemod.removeSkill(String(id)); return storeList(); }

/** `accept` says the person saw who makes a third-party server and the command it runs. */
async function storeMcpAdd(id, extra, accept) {
  const m = await storeEntry("mcp", id);
  if (!m.ours && accept !== true) throw new Error("confirm the notice about running someone else's program first");
  const args = (Array.isArray(extra) ? extra : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 8);
  storemod.addMcp(m, { extra: args });
  return storeList();
}
async function storeMcpRemove(id) { if (storemod) storemod.removeMcp(String(id)); return storeList(); }

// -------------------------------------------------------------------- hub ----

async function hubCatalogue(refresh) {
  const c = cfg();
  const r = await hub.load({ cfg: c, refresh: !!refresh });
  let freeGb = null;
  try { freeGb = serve.freeDeviceBytes(c) / 1e9; } catch { /* unknown */ }
  return {
    source: r.source, url: r.url, ageText: hub.ageText(r.age), freeGb,
    notice: hub.UNCENSORED_NOTICE || [],
    models: r.data.models.map((m) => ({ ...m, fit: hub.fit(m, freeGb), plan: hub.installPlan(m) })),
  };
}

/** Is this hub entry a build with its refusals removed? By its tags, or its download's name. */
function isUncensored(m, plan) {
  return (m.tags || []).some((t) => t === "abliterated" || t === "uncensored") || (plan && plan.ref && hub.uncensoredRef(plan.ref));
}

function hubInstall(slug, m, accept) {
  const plan = hub.installPlan(m);
  if (plan.kind === "none") throw new Error("this hub entry has no install command yet");
  // The CLI asks before downloading an abliterated build, and a job has nobody
  // to ask. The app shows the same notice and passes the answer on.
  const uncensored = isUncensored(m, plan);
  if (uncensored && accept !== true) throw new Error("confirm the notice about abliterated models first");
  const downloads = plan.kind === "pull" || plan.kind === "arc";
  return cliJob(downloads ? "download" : "setup", `${downloads ? "Download" : "Set up"} ${m.name}`,
    [...plan.argv, ...(uncensored && downloads ? ["--accept-uncensored"] : [])], { slug });
}

// --------------------------------------------------------------- harnesses ----

function harnessList() {
  return harness.list().map((h) => ({ id: h.id, label: h.label, installed: !!h.installed, builtin: !!h.builtin, bin: h.bin || null }));
}

/**
 * Open a harness in a real terminal window, pointed at a model. Harnesses are
 * terminal programs; the honest thing is to give them a terminal.
 */
async function launchHarness(id, modelId) {
  const args = ["use", id, ...(modelId ? [modelId] : [])];
  const node = process.execPath;
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  if (process.platform === "win32") {
    // A new console window titled ArcFlare, running the CLI with Electron's Node.
    await spawnFirst([["cmd.exe", ["/d", "/c", "start", '"ArcFlare"', node, ARCFLARE_BIN, ...args]]],
      { env, detached: true, stdio: "ignore", windowsHide: false });
  } else if (process.platform === "darwin") {
    const cmd = [node, ARCFLARE_BIN, ...args].map((a) => `'${String(a).replace(/'/g, "'\\''")}'`).join(" ");
    await spawnFirst([["osascript", ["-e", `tell application "Terminal" to do script "ELECTRON_RUN_AS_NODE=1 ${cmd.replace(/"/g, '\\"')}"`]]],
      { detached: true, stdio: "ignore" });
  } else {
    // Find a terminal that is really there before starting it. spawn() does not throw for a missing
    // program (the failure arrives later, as an event), so trying them in a loop always "succeeded" with
    // the first name, and on a system without x-terminal-emulator (Fedora, Arch) nothing opened at all.
    const term = linuxTerminal();
    if (!term) throw new Error("no terminal program was found to open the harness in. Install one (gnome-terminal, konsole, xterm…) or set TERMINAL to yours");
    await spawnFirst([[term.cmd, [...term.pre, node, ARCFLARE_BIN, ...args]]], { env, detached: true, stdio: "ignore" });
  }
  return true;
}

/** How each Linux terminal is told to run a command: the program, and what goes before the command. */
const LINUX_TERMINALS = [
  ["x-terminal-emulator", ["-e"]], ["gnome-terminal", ["--"]], ["ptyxis", ["--"]], ["kgx", ["--"]], ["konsole", ["-e"]],
  ["xfce4-terminal", ["-x"]], ["tilix", ["-e"]], ["kitty", []], ["alacritty", ["-e"]], ["foot", []], ["wezterm", ["start", "--"]], ["xterm", ["-e"]],
];

/** The terminal to use on Linux: $TERMINAL when it names one that exists, else the first one installed. */
function linuxTerminal({ env = process.env, has = onPathSync } = {}) {
  const wanted = String(env.TERMINAL || "").trim();
  if (wanted && has(wanted)) {
    const known = LINUX_TERMINALS.find(([t]) => t === path.basename(wanted));
    return { cmd: wanted, pre: known ? known[1] : ["-e"] };
  }
  const hit = LINUX_TERMINALS.find(([t]) => has(t));
  return hit ? { cmd: hit[0], pre: hit[1] } : null;
}

function onPathSync(cmd) {
  const r = require("child_process").spawnSync("which", [cmd], { encoding: "utf8", timeout: 5000 });
  return r.status === 0 && !!String(r.stdout).trim();
}

/**
 * Start the first of `commands` ([file, args] pairs) that exists, detached.
 * spawn() reports a missing program as an "error" event, not an exception:
 * with nothing listening that event is an uncaught exception in the main
 * process, and a try/catch around spawn never gets to try the next one.
 */
function spawnFirst(commands, options) {
  return new Promise((resolve, reject) => {
    const tryNext = (i, lastError) => {
      if (i >= commands.length) return reject(lastError || new Error("nothing to run"));
      const [file, args] = commands[i];
      let child;
      try { child = spawn(file, args, options); } catch (e) { return tryNext(i + 1, e); }
      const onError = (e) => tryNext(i + 1, e);
      child.once("error", onError);
      child.once("spawn", () => {
        child.off("error", onError);
        child.on("error", () => {}); // it started; a later error is not ours to act on
        child.unref();
        resolve(file);
      });
    };
    tryNext(0, null);
  });
}

// ------------------------------------------------------------------- misc ----

function cancelJob(id) {
  const j = jobs.get(id);
  if (!j || j.state !== "running") return;
  // Mark it first: the abort can fail the job synchronously.
  update(j, { state: "cancelled" });
  if (j.abort) j.abort();
}

function shutdown({ stopServer = true } = {}) {
  for (const j of jobs.values()) if (j.state === "running" && j.abort) j.abort();
  pool.stopAll();
  if (stopServer) { try { engine.stop(); } catch { /* not running */ } }
}

module.exports = {
  bus, systemInfo, listModels, loadModel, unloadModel, ensureChatModel, chat, stopChat, planEdit,
  generate3d, speak, genSetup, genStatus, hubCatalogue, hubInstall,
  arcList, arcUse, arcInstall, activeArc, arcs,
  storeList, storeSkillAdd, storeSkillRemove, storeMcpAdd, storeMcpRemove,
  linuxTerminal, LINUX_TERMINALS,
  harnessList, launchHarness, spawnFirst, failureReason, cancelJob, jobs: () => [...jobs.values()].map(publicJob),
  studioDir, stamp, studioJob, cliJob, makeRoomFor, shutdown, cfg, state, pool,
};
