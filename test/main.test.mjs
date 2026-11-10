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
