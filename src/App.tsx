import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { Palette } from "./ui/Palette";
import { api, on, platform, type LoadedModel, type ModelProgress, type SystemInfo } from "./lib/api";
import { useJobs } from "./ui/kit";
import { Home } from "./views/Home";
import { Chat } from "./views/Chat";
import { PhoneButton, PhonePanel, useRemote } from "./ui/Phone";
import { UpdatePill, useUpdates } from "./ui/Update";

// Home and Chat are in the first bundle. Every other screen, and the first-run wizard, is fetched the first
// time it is opened, so its code (three.js above all) is not parsed or held in memory until it is wanted.
const Agent = lazy(() => import("./views/Agent").then((m) => ({ default: m.Agent })));
const Studio = lazy(() => import("./views/Studio").then((m) => ({ default: m.Studio })));
const Models = lazy(() => import("./views/Models").then((m) => ({ default: m.Models })));
const Store = lazy(() => import("./views/Store").then((m) => ({ default: m.Store })));
const Harnesses = lazy(() => import("./views/Harnesses").then((m) => ({ default: m.Harnesses })));
const Settings = lazy(() => import("./views/Settings").then((m) => ({ default: m.Settings })));
const Jobs = lazy(() => import("./views/Jobs").then((m) => ({ default: m.Jobs })));
const Welcome = lazy(() => import("./ui/Welcome").then((m) => ({ default: m.Welcome })));
/** A screen that may still be loading. Each has its own boundary, so Chat (always mounted) is never hidden by one. */
const Later = ({ children }: { children: ReactNode }) => <Suspense fallback={null}>{children}</Suspense>;
import { setup } from "./lib/setup";

export type View = "home" | "chat" | "agent" | "studio" | "models" | "store" | "harnesses" | "jobs" | "settings";

const NAV: { id: View; label: string; key: string; group?: string }[] = [
  { id: "home", label: "home", key: "1" },
  { id: "chat", label: "chat", key: "2" },
  { id: "agent", label: "agent", key: "3" },
  { id: "studio", label: "studio", key: "4" },
  { id: "models", label: "models", key: "5", group: "machine" },
  { id: "store", label: "store", key: "6" },
  { id: "harnesses", label: "harnesses", key: "7" },
  { id: "jobs", label: "jobs", key: "8" },
  { id: "settings", label: "settings", key: "9" },
];

export function App() {
  const [view, setView] = useState<View>("home");
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [loaded, setLoaded] = useState<LoadedModel | null>(null);
  const [progress, setProgress] = useState<ModelProgress | null>(null);
  const jobs = useJobs();
  const remote = useRemote();
  const update = useUpdates();
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [phoneChat, setPhoneChat] = useState(0); // bump to show the Phone conversation
  const running = jobs.filter((j) => j.state === "running");
  // First run: open the welcome wizard until it's finished (or forced in dev).
  const [setupDone, setSetupDone] = useState<boolean | null>(null);
  const [welcome, setWelcome] = useState(false);
  useEffect(() => {
    setup.state().then((st) => { setSetupDone(st.done); if (!st.done || st.forced) setWelcome(true); }).catch(() => setSetupDone(true));
  }, []);
  const refreshInfo = () => api.systemInfo().then((i) => { setInfo(i); setLoaded(i.loaded); }).catch(() => {});

  // System info now and every 15 s: free VRAM moves as models load and unload.
  useEffect(() => {
    let alive = true;
    const tick = () => api.systemInfo().then((i) => { if (alive) { setInfo(i); setLoaded(i.loaded); } }).catch(() => {});
    tick();
    const t = setInterval(tick, 15000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  useEffect(() => {
    const offs = [
      on("model:progress", (p: ModelProgress) => setProgress(p)),
      on("model:loaded", (m: LoadedModel) => { setLoaded(m); setProgress(null); api.systemInfo().then(setInfo).catch(() => {}); }),
      on("model:unloaded", () => { setLoaded(null); api.systemInfo().then(setInfo).catch(() => {}); }),
    ];
    return () => offs.forEach((f) => f());
  }, []);

  // Ctrl/Cmd + K opens the command palette.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [newChat, setNewChat] = useState(0); // bump to start a new chat
  const mac = platform() === "darwin";
  const paletteItems = useMemo(() => [
    ...NAV.map((n) => ({ id: n.id as string, label: `Go to ${n.label}`, hint: `${mac ? "⌘" : "Ctrl "}${n.key}` })),
    { id: "new-chat", label: "New chat" },
  ], [mac]);
  const runPalette = (id: string) => {
    if (id === "new-chat") { setView("chat"); setNewChat((n) => n + 1); }
    else setView(id as View);
  };

  // Ctrl/Cmd + 1..9 switch views, like tabs in a browser.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() === "k" && !e.shiftKey && !e.altKey) { e.preventDefault(); setPaletteOpen((o) => !o); return; }
      const n = NAV.find((x) => x.key === e.key);
      if (n) { e.preventDefault(); setView(n.id); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const loadingNow = progress && !["loaded", "failed"].includes(progress.stage);

  return (
    <div className="app">
      <header className={`titlebar${mac ? " mac" : ""}`}>
        <span className="brand">arc<b>flare</b></span>
        <span>{"//"} {view}</span>
        <span className="grow" />
        <UpdatePill status={update} />
        <button className="palette-hint nodrag" onClick={() => setPaletteOpen(true)} title="Open the command palette" aria-label="Open the command palette">
          {mac ? "⌘" : "Ctrl"} K
        </button>
        <PhoneButton status={remote} onClick={() => setPhoneOpen(true)} />
        {loaded ? (
          <span className="row nodrag" style={{ gap: 6 }} title={`${loaded.id} · ${loaded.ctx} ctx`}>
            <span className="led on" /> {loaded.name}
          </span>
        ) : loadingNow ? (
          <span className="row" style={{ gap: 6 }}><span className="led busy" /> loading…</span>
        ) : (
          <span className="row" style={{ gap: 6 }}><span className="led off" /> no model</span>
        )}
      </header>

      <div className="body">
        <nav className="sidebar">
          {NAV.map((n) => (
            <div key={n.id}>
              {n.group && <div className="nav-group">{n.group}</div>}
              <button className={`nav${view === n.id ? " on" : ""}`} onClick={() => setView(n.id)}>
                <span className="dim">/</span>{n.label}
                {n.id === "jobs" && running.length > 0 && <span className="chip warn" style={{ marginLeft: "auto" }}>{running.length}</span>}
                {!(n.id === "jobs" && running.length > 0) && <span className="k">{mac ? "⌘" : "^"}{n.key}</span>}
              </button>
            </div>
          ))}
          <span className="grow" />
          <div className="label foot" style={{ lineHeight: 1.8 }}>
            engine {info?.engineVersion ?? "…"}<br />
            {info?.llamaServer ? <span style={{ color: "var(--accent-2)" }}>llama.cpp found</span> : <span style={{ color: "var(--danger)" }}>no llama.cpp</span>}
          </div>
        </nav>

        <main className="main">
          {view === "home" && <Home info={info} loaded={loaded} go={setView} jobs={jobs} setupDone={setupDone} openSetup={() => setWelcome(true)} />}
          {/* Chat stays mounted: a reply that is still streaming keeps arriving
              (and can still be stopped) while another screen is open. */}
          <div style={{ display: view === "chat" ? "contents" : "none" }}>
            <Chat active={view === "chat"} loaded={loaded} progress={progress} go={setView} remote={remote} phoneChat={phoneChat} newChat={newChat} openPhone={() => setPhoneOpen(true)} />
          </div>
          {view === "agent" && <Later><Agent loaded={loaded} go={setView} /></Later>}
          {view === "studio" && <Later><Studio loaded={loaded} /></Later>}
          {view === "models" && <Later><Models loaded={loaded} progress={progress} go={setView} freeGb={info?.gpu.freeGb ?? null} /></Later>}
          {view === "store" && <Later><Store loaded={loaded} go={setView} /></Later>}
          {view === "harnesses" && <Later><Harnesses loaded={loaded} /></Later>}
          {view === "jobs" && <Later><Jobs jobs={jobs} /></Later>}
          {view === "settings" && <Later><Settings info={info} update={update} openSetup={() => setWelcome(true)} /></Later>}
        </main>
      </div>

      {paletteOpen && <Palette items={paletteItems} onRun={runPalette} onClose={() => setPaletteOpen(false)} />}

      {welcome && (
        <Later>
          <Welcome info={info} onRefresh={refreshInfo} go={setView}
            onClose={(finished) => { setWelcome(false); if (finished) setSetupDone(true); refreshInfo(); }} />
        </Later>
      )}

      {phoneOpen && (
        <PhonePanel status={remote} onClose={() => setPhoneOpen(false)}
          onOpenChat={() => { setView("chat"); setPhoneChat((n) => n + 1); }} />
      )}

      <footer className="statusbar">
        <span className="row" style={{ gap: 6 }}>
          <span className={`led ${info?.serverRunning ? "on" : "off"}`} /> server {info?.serverRunning ? "up" : "idle"}
        </span>
        <span>{gpuText(info)}</span>
        {loaded && <span>ctx {Math.round(loaded.ctx / 1024)}K</span>}
        {progress && loadingNow && <span style={{ color: "var(--accent)" }}>{progressText(progress)}</span>}
        <span className="sp" />
        {remote?.on && <span style={{ color: "var(--accent-2)" }}>phone {remote.connected ? "connected" : "connecting"}{remote.clients ? ` · ${remote.clients} watching` : ""}</span>}
        {running.length > 0 && <span style={{ color: "var(--accent)" }}>{running.length} job{running.length > 1 ? "s" : ""} running · {running[0].title} · {running[0].stage}</span>}
        <span>{info?.platform ?? ""}</span>
      </footer>
    </div>
  );
}

/** Free GPU memory for the status bar, without a "?" for what isn't known. */
function gpuText(info: SystemInfo | null): string {
  const free = info?.gpu.freeGb, total = info?.gpu.totalGb;
  if (free == null) return info ? "gpu memory unknown" : "gpu …";
  return total ? `gpu ${free} / ${total} GB free` : `gpu ${free} GB free`;
}

export function progressText(p: ModelProgress): string {
  switch (p.stage) {
    case "planning": return "planning context…";
    case "reloading": return "reloading the chat model…";
    case "server-starting": return `starting llama-server… ${Math.round((p.ms || 0) / 1000)}s`;
    case "server-ready": return "server ready";
    case "loading": return `loading at ${Math.round((p.ctx || 0) / 1024)}K context…`;
    case "retry": return p.reason === "batch" ? "did not fit — smaller batch, same context" : `did not fit — retrying at ${Math.round((p.ctx || 0) / 1024)}K`;
    case "loaded": return "loaded";
    case "failed": return `failed: ${p.error}`;
  }
}
