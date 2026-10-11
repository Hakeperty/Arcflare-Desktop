// The main-process side of the shop and the llama.cpp installer, run for real
// against a local stand-in for Hugging Face: search, a repo's quants, a download
// job with progress lines from the CLI, and "already installed" for the engine.
// No Electron needed (electron/engine.js only touches it lazily).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "arcflare-bridge-"));
const HOME = join(tmp, "arcflare");
mkdirSync(HOME, { recursive: true });

const BODY = randomBytes(3 * 1024 * 1024);
const PROJ = randomBytes(200_000);
const FILES = { "tiny-Q8_0.gguf": BODY, "mmproj-F16.gguf": PROJ };
const lfs = (b) => ({ size: b.length, sha256: createHash("sha256").update(b).digest("hex") });
const SIBLINGS = [
  { rfilename: "README.md", size: 10 },
  { rfilename: "tiny-Q8_0.gguf", size: BODY.length, lfs: lfs(BODY) },
  { rfilename: "tiny-Q4_K_M.gguf", size: 1_000_000, lfs: { size: 1_000_000, sha256: "0".repeat(64) } },
  { rfilename: "mmproj-F16.gguf", size: PROJ.length, lfs: lfs(PROJ) },
];

let server, eng;
before(async () => {
  server = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    res.setHeader("Content-Type", "application/json");
    if (u.pathname === "/api/models") {
      return res.end(JSON.stringify([{ id: "me/tiny", downloads: 5000, likes: 3, pipeline_tag: "text-generation", tags: ["gguf"] }]));
    }
    if (u.pathname === "/api/models/me/tiny/revision/main") {
      return res.end(JSON.stringify({ sha: "abc123", siblings: SIBLINGS, tags: ["gguf", "license:apache-2.0"], downloads: 5000, likes: 3, pipeline_tag: "text-generation", gated: false }));
    }
    const file = /^\/me\/tiny\/resolve\/[^/]+\/(.+)$/.exec(u.pathname);
    if (file && FILES[file[1]]) {
      const body = FILES[file[1]];
      res.writeHead(200, { "Content-Length": body.length, "Content-Type": "application/octet-stream" });
      let i = 0;
      const step = () => { if (i >= body.length) return res.end(); res.write(body.subarray(i, i += 384 * 1024)); setTimeout(step, 120); };
      return step();
    }
    res.statusCode = 404; res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  Object.assign(process.env, {
    ARCFLARE_HOME: HOME,
    LLAMA_CACHE: join(tmp, "cache"),
    HF_ENDPOINT: `http://127.0.0.1:${server.address().port}`,
    HOME: tmp, USERPROFILE: tmp,
  });
  mkdirSync(process.env.LLAMA_CACHE, { recursive: true });
  eng = createRequire(import.meta.url)(join(here, "..", "electron", "engine.js"));
});
after(() => { server?.close(); });

const waitForJob = (id, ms = 30000) => new Promise((resolve, reject) => {
  const seen = [];
  const t = setTimeout(() => reject(new Error(`job ${id} did not finish: ${JSON.stringify(seen.at(-1))}`)), ms);
  eng.bus.on("job:update", function on(j) {
    if (j.id !== id) return;
    seen.push(j);
    if (j.state !== "running") { clearTimeout(t); eng.bus.off("job:update", on); resolve(seen); }
  });
});

test("shop search returns tidy results marked as not downloaded", async () => {
  const r = await eng.shopSearch({ query: "tiny", sort: "downloads" });
  assert.deepEqual(r.results.map((x) => [x.repo, x.downloads, x.downloaded]), [["me/tiny", 5000, false]]);
});

test("a repo lists its quants smallest first, with the projector added to each and the licence", async () => {
  const r = await eng.shopRepo("me/tiny");
  assert.deepEqual(r.quants.map((q) => q.tag), ["Q4_K_M", "Q8_0"]);
  assert.equal(r.license, "apache-2.0");
  assert.equal(r.vision, true);
  assert.ok(r.quants.every((q) => q.downloaded === false));
});

test("shop calls refuse names that aren't a Hugging Face repo", async () => {
  await assert.rejects(eng.shopRepo("not a repo"), /isn't a Hugging Face repo/);
  assert.throws(() => eng.shopDownload("../etc/passwd", "x"), /isn't a model/);
  assert.throws(() => eng.shopDownload("me/tiny", "Q8 0; rm -rf"), /isn't a model/);
});

test("a download is a job whose progress and stage come from the CLI's progress lines", async () => {
  const job = eng.shopDownload("me/tiny", "Q8_0");
  assert.equal(job.kind, "download");
  assert.deepEqual([job.meta.repo, job.meta.tag], ["me/tiny", "Q8_0"]);
  const seen = await waitForJob(job.id);
  const last = seen.at(-1);
  assert.equal(last.state, "done", JSON.stringify(last.log));
  const pcts = seen.map((j) => j.progress).filter((p) => typeof p === "number");
  assert.ok(pcts.length >= 3, `only ${pcts.length} progress updates`);
  assert.deepEqual(pcts, [...pcts].sort((a, b) => a - b));
  assert.ok(seen.some((j) => /tiny-Q8_0\.gguf/.test(j.stage)), "the stage names the file");
  assert.ok(!last.log.some((l) => l.startsWith("progress ")), "progress lines are not log noise");
});

test("once downloaded, the repo says so", async () => {
  const r = await eng.shopRepo("me/tiny");
  assert.deepEqual(r.quants.map((q) => [q.tag, q.downloaded]), [["Q4_K_M", false], ["Q8_0", true]]);
  const s = await eng.shopSearch({ query: "tiny" });
  assert.equal(s.results[0].downloaded, true);
});

test("installing the engine when one is already there finishes at once and installs nothing", async () => {
  const exe = join(HOME, "engine", "b1-linux-cpu-x64", process.platform === "win32" ? "llama-server.exe" : "llama-server");
  mkdirSync(dirname(exe), { recursive: true });
  writeFileSync(exe, "");
  chmodSync(exe, 0o755);
  const job = eng.installEngine();
  assert.equal(job.kind, "setup");
  assert.equal(job.meta.engine, true);
  const seen = await waitForJob(job.id);
  assert.equal(seen.at(-1).state, "done", JSON.stringify(seen.at(-1).log));
  assert.ok(seen.at(-1).log.some((l) => /already installed/.test(l)), JSON.stringify(seen.at(-1).log));
});
