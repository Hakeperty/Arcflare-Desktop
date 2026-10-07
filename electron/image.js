// Images for the studio: stable-diffusion.cpp locally, or a running ComfyUI.
//
// stable-diffusion.cpp is the default because it matches the rest of ArcFlare:
// one native binary, GGUF and safetensors checkpoints, Vulkan/CUDA/Metal/ROCm,
// nothing to install into Python. ComfyUI is supported as a connector — if it
// is running, the studio can queue your own workflow with the prompt filled in.

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn, spawnSync } = require("child_process");

const IS_WIN = process.platform === "win32";
const EXE = IS_WIN ? ".exe" : "";
const MODEL_EXT = /\.(safetensors|ckpt|gguf)$/i;

function onPath(name) {
  const r = spawnSync(IS_WIN ? "where" : "which", [name], { encoding: "utf8", windowsHide: true });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() || null : null;
}

/** The sd.cpp binary: configured, on PATH, or in the usual folders. */
function findSd(cfg = {}) {
  const home = os.homedir();
  const tries = [
    cfg.sdcpp,
    process.env.ARCFLARE_SDCPP,
    onPath("sd-cli"), onPath("sd"),
    path.join(home, "AI", "sdcpp", "sd-cli" + EXE),
    path.join(home, "AI", "sdcpp", "sd" + EXE),
    path.join(home, "stable-diffusion.cpp", "build", "bin", "sd" + EXE),
    path.join(home, ".arcflare", "sdcpp", "sd-cli" + EXE),
  ];
  return tries.find((p) => p && fs.existsSync(p)) || null;
}

/** Image checkpoints in the configured folder, next to the binary, and in ~/.arcflare/image-models. */
function listImageModels(cfg = {}) {
  const sd = findSd(cfg);
  const dirs = [
    cfg.imageModelsDir,
    sd && path.join(path.dirname(sd), "models"),
    path.join(os.homedir(), ".arcflare", "image-models"),
  ].filter((d) => d && fs.existsSync(d));
  const out = [];
  const seen = new Set();
  const walk = (dir, depth) => {
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (e.isFile() && MODEL_EXT.test(e.name) && !seen.has(p)) {
        // Encoders and VAEs sit in the same folders but are not checkpoints.
        if (/(^|[-_.])(vae|clip|t5|t5xxl|text_encoder|taesd|lora)([-_.]|$)/i.test(e.name)) continue;
        seen.add(p);
        let size = 0;
        try { size = fs.statSync(p).size; } catch { /* unreadable */ }
        out.push({ path: p, name: e.name.replace(MODEL_EXT, ""), sizeGb: Math.round((size / 1e9) * 10) / 10 });
      }
    }
  };
  dirs.forEach((d) => walk(d, 0));
  return { sd, models: out.sort((a, b) => a.name.localeCompare(b.name)) };
}

/**
 * Generate one image with sd.cpp. Resolves to { file, ms }. Progress from
 * sd.cpp's "  12/20 - 1.23s/it" sampler lines goes to onEvent as percentages.
 */
function sdGenerate(cfg, opts, { onEvent = () => {}, signal } = {}) {
  return new Promise((resolve, reject) => {
    const sd = findSd(cfg);
    if (!sd) return reject(new Error("stable-diffusion.cpp not found — set its path in Settings, or install it from github.com/leejet/stable-diffusion.cpp"));
    if (!opts.model || !fs.existsSync(opts.model)) return reject(new Error("pick an image model (a .safetensors, .ckpt or .gguf checkpoint)"));
    const args = [
      "-m", opts.model,
      "-p", opts.prompt || "",
      "-W", String(opts.width || 512),
      "-H", String(opts.height || 512),
      "--steps", String(opts.steps || 20),
      "--cfg-scale", String(opts.cfg || 7),
      "-s", String(opts.seed == null || opts.seed === "" ? Math.floor(Math.random() * 2 ** 31) : opts.seed),
      "-o", opts.out,
    ];
    if (opts.negative) args.push("-n", opts.negative);
    if (opts.sampler) args.push("--sampling-method", opts.sampler);
    if (opts.initImage) args.push("-i", opts.initImage, "--strength", String(opts.strength ?? 0.75));
    // Low-VRAM switches: weights in RAM until needed, VAE in tiles.
    if (opts.lowVram) args.push("--offload-to-cpu", "--vae-tiling");
    const t0 = Date.now();
    const child = spawn(sd, args, { cwd: path.dirname(sd), windowsHide: true });
    const tail = [];
    if (signal) signal.addEventListener("abort", () => { try { child.kill(); } catch { /* gone */ } }, { once: true });
    const onData = (d) => {
      for (const line of d.toString().split(/\r?\n|\r/)) {
        if (!line.trim()) continue;
        tail.push(line); if (tail.length > 30) tail.shift();
        const m = /\|\s*(\d+)\/(\d+)\s*-/.exec(line) || /\b(\d+)\/(\d+)\s*-\s*[\d.]+\s*(?:s\/it|it\/s)/.exec(line);
        if (m) onEvent({ event: "progress", pct: Math.round((Number(m[1]) / Number(m[2])) * 100) });
        if (/loading|load model/i.test(line)) onEvent({ event: "stage", stage: "load-model" });
        else if (/sampling|sample/i.test(line)) onEvent({ event: "stage", stage: "sampling" });
        else if (/decod/i.test(line)) onEvent({ event: "stage", stage: "decode" });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (e) => reject(e));
    child.on("close", (code) => {
      if (code === 0 && fs.existsSync(opts.out)) return resolve({ file: opts.out, ms: Date.now() - t0 });
      const err = new Error(signal && signal.aborted ? "cancelled" : `stable-diffusion.cpp failed (exit ${code})`);
      err.stderr = tail.join("\n");
      reject(err);
    });
  });
}

// ---------------------------------------------------------------- comfyui ----

function comfyRequest(base, method, p, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(p, base);
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(u, {
      method, timeout: 5000,
      headers: data ? { "Content-Type": "application/json", "Content-Length": data.length } : {},
    }, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode >= 400) return reject(new Error(`ComfyUI answered ${res.statusCode}: ${buf.toString().slice(0, 200)}`));
        resolve({ buf, type: res.headers["content-type"] || "" });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("ComfyUI did not answer")); });
    req.end(data);
  });
}

async function comfyStatus(base) {
  try {
    const r = await comfyRequest(base, "GET", "/system_stats");
    const j = JSON.parse(r.buf.toString());
    return { up: true, version: j.system && j.system.comfyui_version, devices: (j.devices || []).map((d) => d.name) };
  } catch (e) {
    return { up: false, error: e.message };
  }
}

/**
 * Queue a ComfyUI API-format workflow, replacing {{prompt}}, {{negative}} and
 * {{seed}} anywhere in it, wait for it, and save the first image it made.
 */
async function comfyRun(base, workflowFile, vars, out, { onEvent = () => {}, signal } = {}) {
  let text = fs.readFileSync(workflowFile, "utf8");
  for (const [k, v] of Object.entries(vars)) {
    text = text.split(`{{${k}}}`).join(String(v ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"'));
  }
  const workflow = JSON.parse(text);
  const queued = JSON.parse((await comfyRequest(base, "POST", "/prompt", { prompt: workflow })).buf.toString());
  const id = queued.prompt_id;
  onEvent({ event: "stage", stage: "queued in ComfyUI" });
  const t0 = Date.now();
  for (;;) {
    if (signal && signal.aborted) throw new Error("cancelled");
    await new Promise((r) => setTimeout(r, 1000));
    const hist = JSON.parse((await comfyRequest(base, "GET", `/history/${id}`)).buf.toString());
    const entry = hist[id];
    if (!entry) continue;
    if (entry.status && entry.status.status_str === "error") throw new Error("ComfyUI reported an error running the workflow");
    const images = Object.values(entry.outputs || {}).flatMap((o) => o.images || []);
    if (!images.length) continue;
    const img = images[0];
    const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder || "", type: img.type || "output" });
    const r = await comfyRequest(base, "GET", `/view?${q}`);
    fs.writeFileSync(out, r.buf);
    return { file: out, ms: Date.now() - t0 };
  }
}

module.exports = { findSd, listImageModels, sdGenerate, comfyStatus, comfyRun };
