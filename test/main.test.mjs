// Main-process logic that needs no Electron window: the job system, chat
// streaming and its stop, terminal launching, and the ComfyUI connector.
// The engine runs against a throwaway ARCFLARE_HOME and a fake llama-server.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const tmp = mkdtempSync(join(tmpdir(), "arcflare-test-"));
process.env.ARCFLARE_HOME = join(tmp, "home");
const require = createRequire(import.meta.url);
const eng = require("../electron/engine.js");
const image = require("../electron/image.js");

const servers = [];
function listen(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    servers.push(s);
    s.listen(0, "127.0.0.1", () => resolve(s.address().port));
  });
}
after(() => {
  for (const s of servers) { s.closeAllConnections?.(); s.close(); }
  eng.pool.stopAll();
  rmSync(tmp, { recursive: true, force: true });
});

const jobState = (id) => eng.jobs().find((j) => j.id === id);
async function until(fn, what) {
  for (let i = 0; i < 200; i++) { if (fn()) return; await sleep(10); }
  assert.fail(`timed out waiting for ${what}`);
}

// ------------------------------------------------------------------ jobs ----

test("a cancelled job stays cancelled when its work then fails", async () => {
  let aborted = false;
  const job = eng.studioJob("image", "test", ({ signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(new Error("cancelled")); });
  }), 0);
  await sleep(20);
  eng.cancelJob(job.id);
  await until(() => aborted, "the abort");
  await sleep(20);
  const j = jobState(job.id);
  assert.equal(j.state, "cancelled");
  assert.equal(j.error, null);
  assert.ok(j.ended >= j.started, "a finished job records when it ended");
});

test("cancelling a job that already finished leaves it alone", async () => {
  const job = eng.studioJob("image", "test", async () => ({ file: "x.png" }), 0);
  await until(() => jobState(job.id).state === "done", "the job");
  const ended = jobState(job.id).ended;
  eng.cancelJob(job.id);
  assert.equal(jobState(job.id).state, "done");
  assert.equal(jobState(job.id).ended, ended);
});

test("a running job has no end time; a failed one does, with its error", async () => {
  let fail;
  const job = eng.studioJob("image", "test", () => new Promise((_, reject) => { fail = reject; }), 0);
  await until(() => fail, "the job to start");
  assert.equal(jobState(job.id).ended, null);
  fail(new Error("out of memory"));
  await until(() => jobState(job.id).state === "failed", "the failure");
  assert.equal(jobState(job.id).error, "out of memory");
  assert.ok(jobState(job.id).ended);
});

// -------------------------------------------------------------- terminals ----

test("spawnFirst skips programs that don't exist instead of crashing", async () => {
  const ran = await eng.spawnFirst([
    ["arcflare-no-such-terminal-1", ["-e"]],
    ["arcflare-no-such-terminal-2", ["--"]],
    [process.execPath, ["-e", "0"]],
  ], { stdio: "ignore" });
  assert.equal(ran, process.execPath);
});

test("spawnFirst rejects when nothing can be started", async () => {
  await assert.rejects(eng.spawnFirst([["arcflare-no-such-terminal-1", []]], { stdio: "ignore" }), /ENOENT/);
});

// ------------------------------------------------------------------- chat ----

async function fakeLlama({ gate } = {}) {
  const port = await listen(async (req, res) => {
    if (req.url === "/health") {
      if (gate) await gate;
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end('{"status":"ok"}');
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    send({ choices: [{ delta: { content: "Hel" } }] });
    await sleep(40);
    send({ choices: [{ delta: { content: "lo" } }] });
    // Left open: the test either stops it or asks for the end.
    if (req.headers["x-finish"] !== "no") { send({ choices: [{ delta: {} }], timings: { predicted_per_second: 12.34, prompt_n: 3, predicted_n: 2 } }); res.end("data: [DONE]\n\n"); }
  });
  eng.state.loaded = { id: "fake:q4", servedId: "fake", port, ctx: 4096, name: "fake" };
  return port;
}

test("chat streams deltas and resolves with the text and speed", async () => {
  await fakeLlama();
  const deltas = [];
  const onDelta = (d) => { if (d.requestId === "t1") deltas.push(d.text); };
  eng.bus.on("chat:delta", onDelta);
  const r = await eng.chat("t1", { messages: [{ role: "user", content: "hi" }] });
  eng.bus.off("chat:delta", onDelta);
  assert.equal(r.text, "Hello");
  assert.deepEqual(deltas, ["Hel", "lo"]);
  assert.equal(r.tokPerSec, 12.3);
});

test("stop pressed while the model is still being checked or reloaded stops the chat", async () => {
  let open;
  const gate = new Promise((r) => { open = r; });
  await fakeLlama({ gate });
  const p = eng.chat("t2", { messages: [{ role: "user", content: "hi" }] });
  await sleep(30);          // chat is waiting on the model check
  eng.stopChat("t2");
  open();
  await assert.rejects(p, /stopped/);
});

test("three model loads in a row run one at a time", async () => {
  const models = require("arcflare/lib/models");
  const serve = require("arcflare/lib/serve");
  const real = { discover: models.discover, resolve: models.resolve, load: serve.loadModel, save: serve.saveConfig };
  let running = 0, most = 0;
  models.discover = () => [];
  models.resolve = (_, id) => ({ id, meta: {} });
  serve.saveConfig = () => {};
  serve.loadModel = async () => {
    most = Math.max(most, ++running);
    await sleep(20);
    running--;
    return { servedId: "x", port: 1, ctx: 4096 };
  };
  try {
    const loaded = await Promise.all(["a:q4", "b:q4", "c:q4"].map((id) => eng.loadModel(id)));
    assert.equal(most, 1);
    assert.deepEqual(loaded.map((l) => l.id), ["a:q4", "b:q4", "c:q4"]);
    assert.equal(eng.state.loading, null);
  } finally {
    models.discover = real.discover; models.resolve = real.resolve; serve.loadModel = real.load; serve.saveConfig = real.save;
    eng.state.loaded = null;
  }
});

test("a harness opened on Windows gets every path quoted and escaped for cmd.exe", () => {
  assert.equal(eng.winStartLine(["C:\\Users\\A&B\\ArcFlare.exe", "C:\\Program Files\\bin\\arcflare.js", "use", "claude"]),
    '/d /c start "ArcFlare" ^"C:\\Users\\A^&B\\ArcFlare.exe^" ^"C:\\Program^ Files\\bin\\arcflare.js^" ^"use^" ^"claude^"');
  assert.throws(() => eng.winStartLine(["C:\\Users\\100%\\ArcFlare.exe"]), /cannot pass a "%"/);
});

// ---------------------------------------------------------------- comfyui ----

test("a ComfyUI workflow takes a multi-line prompt with quotes", async () => {
  let queued = null;
  const port = await listen((req, res) => {
    const chunks = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", () => {
      if (req.url === "/prompt") { queued = JSON.parse(Buffer.concat(chunks).toString()); res.end('{"prompt_id":"p1"}'); }
      else if (req.url.startsWith("/history/")) res.end(JSON.stringify({ p1: { outputs: { 9: { images: [{ filename: "a.png" }] } } } }));
      else res.end("PNG");
    });
  });
  const wf = join(tmp, "wf.json");
  writeFileSync(wf, JSON.stringify({ 6: { inputs: { text: "{{prompt}}" } }, 7: { inputs: { text: "{{negative}}" } }, 3: { inputs: { seed: "{{seed}}" } } }));
  const out = join(tmp, "out.png");
  const prompt = 'a chest,\nbrass "corners"\twith a C:\\path';
  const r = await image.comfyRun(`http://127.0.0.1:${port}`, wf, { prompt, negative: "", seed: 7 }, out);
  assert.equal(r.file, out);
  assert.equal(queued.prompt[6].inputs.text, prompt);
  assert.equal(queued.prompt[3].inputs.seed, "7");
  assert.equal(readFileSync(out, "utf8"), "PNG");
});

test("a failed CLI job reports the CLI's own reason, not just an exit code", () => {
  assert.equal(eng.failureReason(["  finding the latest llama.cpp build", "  ✗ api.github.com answered 403", "  You can also install it yourself"]), "api.github.com answered 403");
  assert.equal(eng.failureReason(["downloading 40%", "done"]), null);
  assert.equal(eng.failureReason([]), null);
});

// ----------------------------------------------------------------- remote ----

test("a phone turn that fails outside the chat does not block the turns after it", async () => {
  const { EventEmitter } = await import("node:events");
  const bus = new EventEmitter();
  let first = true;
  bus.on("rc:turn", () => { if (first) { first = false; throw new Error("window gone"); } });
  const fake = { bus, state: { loaded: null }, chat: async () => ({ text: "ok", tokPerSec: null }), stopChat() {} };
  const remote = require("../electron/remote.js")(fake);
  const err = console.error; console.error = () => {};
  try {
    remote.say("one");
    remote.say("two");
    await until(() => remote.status().history.some((h) => h.role === "assistant" && h.content === "ok"), "the second turn");
  } finally { console.error = err; }
});

async function fakeRelay() {
  const seen = { open: 0, close: 0 };
  let release;
  const gate = new Promise((r) => { release = r; });
  const port = await listen((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", async () => {
      if (req.method === "GET") return setTimeout(() => res.end('{"events":[]}'), 50);
      const type = JSON.parse(body).type;
      if (type in seen) seen[type]++;
      if (type === "open") await gate;
      res.end("{}");
    });
  });
  return { url: `http://127.0.0.1:${port}`, seen, release };
}

test("pressing start twice opens one relay session, and stop closes it", async () => {
  const relay = await fakeRelay();
  process.env.ARCFLARE_RELAY = relay.url;
  const { EventEmitter } = await import("node:events");
  const remote = require("../electron/remote.js")({ bus: new EventEmitter(), state: { loaded: null }, stopChat() {} });
  try {
    const a = remote.start(), b = remote.start();
    await until(() => relay.seen.open > 0, "the open");
    relay.release();
    await Promise.all([a, b]);
    assert.equal(relay.seen.open, 1);
    await remote.stop();
    assert.equal(relay.seen.close, 1);
    assert.equal(remote.status().on, false);
  } finally { delete process.env.ARCFLARE_RELAY; }
});

test("stop pressed while the relay is still answering start leaves phone control off", async () => {
  const relay = await fakeRelay();
  process.env.ARCFLARE_RELAY = relay.url;
  const { EventEmitter } = await import("node:events");
  const remote = require("../electron/remote.js")({ bus: new EventEmitter(), state: { loaded: null }, stopChat() {} });
  try {
    const a = remote.start();
    await until(() => relay.seen.open > 0, "the open");
    await remote.stop();
    relay.release();
    await a;
    assert.equal(remote.status().on, false);
    assert.equal(relay.seen.close, 1);
  } finally { delete process.env.ARCFLARE_RELAY; }
});

// ------------------------------------------------------------------ agent ----

test("MCP servers that finish starting after the agent session closed are stopped", async () => {
  const { EventEmitter } = await import("node:events");
  const { mkdirSync } = await import("node:fs");
  const run = require("arcflare/lib/agent/run");
  const real = run.connectMcp;
  let finish;
  run.connectMcp = () => new Promise((r) => { finish = r; });
  let stopped = 0;
  try {
    const fake = { bus: new EventEmitter(), ensureChatModel: async () => ({ id: "fake:q4", port: 1, servedId: "fake", ctx: 4096 }) };
    const agents = require("../electron/agent.js")(fake);
    const dir = join(tmp, "proj");
    mkdirSync(dir, { recursive: true });
    const s = await agents.open(dir, { machine: false, desktop: false, web: false });
    const p = agents.send(s.sessionId, "hi");
    await until(() => finish, "the MCP servers to start");
    agents.close(s.sessionId);
    finish({ reg: { stopAll: () => { stopped++; }, all: () => [] }, results: [] });
    await assert.rejects(p, /closed/);
    assert.equal(stopped, 1);
  } finally { run.connectMcp = real; }
});

// ------------------------------------------------------------- comfyui (2) ----

test("a ComfyUI workflow that finishes without an image fails instead of waiting forever", async () => {
  const port = await listen((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url === "/prompt") res.end('{"prompt_id":"p2"}');
      else res.end(JSON.stringify({ p2: { status: { status_str: "success", completed: true }, outputs: { 9: { gifs: [{ filename: "a.mp4" }] } } } }));
    });
  });
  const wf = join(tmp, "wf2.json");
  writeFileSync(wf, JSON.stringify({ 6: { inputs: { text: "{{prompt}}" } } }));
  await assert.rejects(image.comfyRun(`http://127.0.0.1:${port}`, wf, { prompt: "x" }, join(tmp, "out2.png")), /without saving an image/);
});

// ------------------------------------------------------------- gen setup ----

test("studio setup refuses a model or torch value that would be read as another CLI flag", () => {
  assert.throws(() => eng.genSetup("--torch-from=/bin/sh"), /no studio model/);
  assert.throws(() => eng.genSetup(""), /no studio model/);
  const id = eng.genStatus()[0].id;
  assert.throws(() => eng.genSetup(id, { torch: "--torch-from=/bin/sh" }), /unknown torch build/);
});
