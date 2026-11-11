// First-run setup: the few facts the welcome screen needs that the rest of the
// app doesn't — which GPU this is (so we can name the right llama.cpp build),
// a fresh search for llama-server, a folder to unzip one into, and whether
// setup has been done. Everything else the wizard uses (system info, the hub,
// downloads, loading, chat) is the app's existing IPC.
//
// The engine can download llama.cpp itself (`arcflare engine install` picks the
// build for this machine), so the wizard offers that as one button. Naming the
// file and linking the official releases stays as the way to do it by hand.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { shell } = require("electron");

const serve = require("arcflare/lib/serve");
const engine = require("arcflare/lib/engine");

const RELEASES = "https://github.com/ggml-org/llama.cpp/releases/latest";

let gpuCache = null;

/** The graphics card's name and vendor, from the OS. Cached; never throws. */
function gpu() {
  if (gpuCache) return gpuCache;
  let names = [];
  try {
    if (process.platform === "win32") {
      const r = spawnSync("powershell.exe", ["-NoProfile", "-Command",
        "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name"], { encoding: "utf8", timeout: 8000, windowsHide: true });
      names = (r.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    } else if (process.platform === "linux") {
      const r = spawnSync("sh", ["-c", "lspci 2>/dev/null | grep -Ei 'vga|3d|display'"], { encoding: "utf8", timeout: 5000 });
      names = (r.stdout || "").split("\n").map((s) => s.replace(/^.*?: /, "").trim()).filter(Boolean);
      // lspci is a package many systems do not have, and it is not there inside an AppImage's view of
      // some hosts. The kernel always says who made each card.
      if (!names.length) names = linuxCardsFromSys();
    } else if (process.platform === "darwin") {
      names = [os.cpus()[0]?.model?.includes("Apple") ? "Apple silicon" : "Mac GPU"];
    }
  } catch { /* unknown */ }
  // Prefer a discrete card over integrated graphics when there are several.
  const pick = names.find((n) => /nvidia|geforce|rtx|radeon rx|arc a/i.test(n)) || names[0] || null;
  const vendor = !pick ? "unknown"
    : /nvidia|geforce|rtx|quadro|tesla/i.test(pick) ? "nvidia"
    : /amd|radeon/i.test(pick) ? "amd"
    : /intel/i.test(pick) ? "intel"
    : /apple/i.test(pick) || process.platform === "darwin" ? "apple"
    : "unknown";
  gpuCache = { name: pick, vendor };
  return gpuCache;
}

/** Linux: each graphics card's maker, from /sys/class/drm (PCI vendor ids). */
function linuxCardsFromSys(root = "/sys/class/drm") {
  const VENDORS = { "0x10de": "NVIDIA graphics", "0x1002": "AMD Radeon graphics", "0x8086": "Intel graphics" };
  const out = [];
  try {
    for (const c of fs.readdirSync(root).filter((n) => /^card\d+$/.test(n))) {
      let id = "";
      try { id = fs.readFileSync(path.join(root, c, "device", "vendor"), "utf8").trim().toLowerCase(); } catch { continue; }
      if (VENDORS[id] && !out.includes(VENDORS[id])) out.push(VENDORS[id]);
    }
  } catch { /* no /sys: not Linux, or a sandbox */ }
  return out;
}

/**
 * Which llama.cpp release file fits this machine, in words a person can match
 * against the release page, and the folder ArcFlare looks in by default.
 */
function suggestBuild(vendor) {
  const p = process.platform;
  const home = os.homedir();
  if (p === "darwin") {
    return { backend: "metal", file: `llama-…-bin-macos-${process.arch === "arm64" ? "arm64" : "x64"}.zip`, why: "Macs use Metal, built into the macOS build.", folder: path.join(home, "llamacpp") };
  }
  const os_ = p === "win32" ? "win" : "ubuntu";
  if (vendor === "nvidia" && p === "win32") {
    return { backend: "cuda", file: "llama-…-bin-win-cuda-12.4-x64.zip (and the cudart-…-12.4 zip next to it)", why: "CUDA is fastest on NVIDIA cards.", folder: path.join(home, "llamacpp", "cuda") };
  }
  // Linux releases are .tar.gz, named "ubuntu" but built to run on other distributions too. There is no
  // ready-made CUDA build for Linux, and the Vulkan one runs on NVIDIA's own driver, so that is the one
  // to get; building with CUDA from source is faster still, for anyone who wants to.
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return {
    backend: "vulkan",
    file: p === "win32" ? "llama-…-bin-win-vulkan-x64.zip" : `llama-…-bin-${os_}-vulkan-${arch}.tar.gz`,
    why: vendor === "nvidia" ? "Vulkan runs on NVIDIA's driver with nothing else to install. (Building llama.cpp with CUDA yourself is faster still.)"
      : vendor === "amd" ? "Vulkan works on every recent AMD card without extra drivers." : vendor === "intel" ? "Vulkan runs on Intel graphics." : "Vulkan works on most graphics cards.",
    folder: path.join(home, "llamacpp", "vulkan"),
  };
}

module.exports = function registerSetup(handle, eng) {
  // Can this engine download llama.cpp by itself? (`arcflare engine install`, engine 1.1 and later.)
  const canInstall = (() => { try { require.resolve("arcflare/lib/engine-install"); return !!(eng && eng.cliJob); } catch { return false; } })();

  // One button: the engine picks the build for this machine, downloads it, unpacks it and remembers it.
  handle("setup:install", () => {
    if (!canInstall) throw new Error("this version of the ArcFlare engine cannot download llama.cpp: get it from the releases page instead");
    return eng.cliJob("setup", "Download llama.cpp", ["engine", "install"]);
  });

  handle("setup:state", () => {
    const c = serve.loadConfig();
    const g = gpu();
    return {
      done: !!c.setupDone && !process.env.ARCFLARE_FORCE_SETUP,
      forced: !!process.env.ARCFLARE_FORCE_SETUP,
      // ARCFLARE_FORCE_SETUP=noengine: preview the "llama.cpp missing" path
      // without hiding a real install (development only).
      pretendNoEngine: process.env.ARCFLARE_FORCE_SETUP === "noengine",
      gpu: g,
      build: suggestBuild(g.vendor),
      canInstall,
      releases: RELEASES,
    };
  });

  // Look again (PATH, ~/llamacpp/*, common build folders) and remember a hit.
  handle("setup:find", () => {
    const found = engine.findServer(null);
    if (found) {
      const c = serve.loadConfig();
      serve.saveConfig({ ...c, llamaServer: found });
    }
    return found || null;
  });

  // Make the suggested folder and open it, so unzipping lands where we look.
  handle("setup:folder", async () => {
    const g = gpu();
    const dir = suggestBuild(g.vendor).folder;
    fs.mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
    return dir;
  });

  handle("setup:done", (done) => {
    const c = serve.loadConfig();
    serve.saveConfig({ ...c, setupDone: !!done });
    return true;
  });
};
module.exports.suggestBuild = suggestBuild;
module.exports.linuxCardsFromSys = linuxCardsFromSys;
