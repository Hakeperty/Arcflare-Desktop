// In-app updates from the public GitHub releases.
//
// The release workflow uploads latest.yml / latest-mac.yml / latest-linux.yml
// next to the installers, which is what electron-updater reads. Updates are
// downloaded in the background but never installed mid-session: the renderer
// shows "ready — restart" and installs only when the person clicks it (or on
// the next quit).
//
// Where an in-place install can't work, the app says an update is available
// and links to the release page instead:
//   * macOS: the builds are unsigned, and Squirrel.Mac refuses unsigned apps.
//   * Linux .deb: only the AppImage can replace itself.
//   * Development (not packaged): nothing to update.

const { app } = require("electron");

const RELEASES = "https://github.com/Hakeperty/Arcflare-Desktop/releases/latest";
const FIRST_CHECK_MS = 10_000;
const EVERY_MS = 6 * 60 * 60 * 1000;

module.exports = function createUpdater({ send, enabled }) {
  let status = { state: "idle", version: null, percent: null, notes: null, url: null, error: null, lastChecked: null };
  let updater = null;
  let timers = [];

  // How this copy of the app can update itself.
  const mode = !app.isPackaged
    ? "none"
    : process.platform === "darwin"
      ? "link"
      : process.platform === "linux" && !process.env.APPIMAGE
        ? "link"
        : "install";

  const view = () => ({ ...status, current: app.getVersion(), mode });
  const set = (patch) => {
    status = { ...status, ...patch };
    send("update:status", view());
  };

  function load() {
    if (updater) return updater;
    ({ autoUpdater: updater } = require("electron-updater"));
    updater.autoDownload = mode === "install";
    updater.autoInstallOnAppQuit = mode === "install";
    updater.disableWebInstaller = true; // the NSIS build is a full installer
    updater.logger = { info() {}, warn: (m) => console.warn("[update]", m), error: (m) => console.error("[update]", m), debug() {} };
    updater.on("checking-for-update", () => set({ state: "checking", error: null }));
    updater.on("update-not-available", () => set({ state: "idle", version: null, percent: null, lastChecked: Date.now() }));
    updater.on("update-available", (info) => {
      const notes = typeof info.releaseNotes === "string" ? info.releaseNotes.replace(/<[^>]+>/g, "").slice(0, 2000) : null;
      set({
        state: mode === "install" ? "downloading" : "available",
        version: info.version,
        notes,
        percent: mode === "install" ? 0 : null,
        url: mode === "link" ? RELEASES : null,
        lastChecked: Date.now(),
      });
    });
    updater.on("download-progress", (p) => set({ state: "downloading", percent: Math.round(p.percent) }));
    updater.on("update-downloaded", (info) => set({ state: "ready", version: info.version, percent: 100 }));
    updater.on("error", (e) => {
      console.error("[update]", e && e.message);
      set({ state: "error", error: String((e && e.message) || e).split("\n")[0].slice(0, 200) });
    });
    return updater;
  }

  async function check() {
    if (mode === "none") { set({ state: "unsupported" }); return view(); }
    if (status.state === "downloading" || status.state === "ready") return view();
    try {
      await load().checkForUpdates();
    } catch (e) {
      set({ state: "error", error: String(e.message || e).slice(0, 200) });
    }
    return view();
  }

  function install() {
    if (status.state !== "ready" || !updater) throw new Error("no update is ready to install");
    // isSilent=false shows the installer's progress; isForceRunAfter=true reopens the app.
    setImmediate(() => updater.quitAndInstall(false, true));
    return true;
  }

  // The timers always run; each tick asks whether checks are switched on, so
  // turning the setting on later takes effect without a restart.
  function start() {
    if (mode === "none") { status = { ...status, state: "unsupported" }; return; }
    timers.push(setTimeout(() => { if (enabled()) check(); }, FIRST_CHECK_MS));
    timers.push(setInterval(() => { if (enabled()) check(); }, EVERY_MS));
  }

  function stop() {
    timers.forEach((t) => clearTimeout(t));
    timers = [];
  }

  return {
    start, stop, check, install,
    status: view,
  };
};
