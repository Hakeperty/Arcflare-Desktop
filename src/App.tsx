import { useEffect, useState } from "react";
import { api, on, platform, type LoadedModel, type ModelProgress, type SystemInfo } from "./lib/api";
import { useJobs } from "./ui/kit";
import { Home } from "./views/Home";
import { Chat } from "./views/Chat";
import { Studio } from "./views/Studio";
import { Models } from "./views/Models";
import { Harnesses } from "./views/Harnesses";
import { Settings } from "./views/Settings";
import { Jobs } from "./views/Jobs";
import { PhoneButton, PhonePanel, useRemote } from "./ui/Phone";
import { UpdatePill, useUpdates } from "./ui/Update";

export type View = "home" | "chat" | "studio" | "models" | "harnesses" | "jobs" | "settings";

const NAV: { id: View; label: string; key: string; group?: string }[] = [
  { id: "home", label: "home", key: "1" },
  { id: "chat", label: "chat", key: "2" },
  { id: "studio", label: "studio", key: "3" },
  { id: "models", label: "models", key: "4", group: "machine" },
  { id: "harnesses", label: "harnesses", key: "5" },
  { id: "jobs", label: "jobs", key: "6" },
  { id: "settings", label: "settings", key: "7" },
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

  // Ctrl/Cmd + 1..7 switch views, like tabs in a browser.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const n = NAV.find((x) => x.key === e.key);
      if (n) { e.preventDefault(); setView(n.id); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const mac = platform() === "darwin";
  const loadingNow = progress && !["loaded", "failed"].includes(progress.stage);

  return (
    <div className="app">
      <header className={`titlebar${mac ? " mac" : ""}`}>
        <span className="brand">arc<b>flare</b></span>
        <span>{"//"} {view}</span>
        <span className="grow" />
        <UpdatePill status={update} />
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
          <div className="label" style={{ padding: "8px 10px", lineHeight: 1.8 }}>
            engine {info?.engineVersion ?? "…"}<br />
            {info?.llamaServer ? <span style={{ color: "var(--accent-2)" }}>llama.cpp found</span> : <span style={{ color: "var(--danger)" }}>no llama.cpp</span>}
          </div>
        </nav>

        <main className="main">
          {view === "home" && <Home info={info} loaded={loaded} go={setView} jobs={jobs} />}
          {view === "chat" && <Chat loaded={loaded} progress={progress} go={setView} remote={remote} phoneChat={phoneChat} openPhone={() => setPhoneOpen(true)} />}
          {view === "studio" && <Studio loaded={loaded} />}
          {view === "models" && <Models loaded={loaded} progress={progress} go={setView} />}
          {view === "harnesses" && <Harnesses loaded={loaded} />}
          {view === "jobs" && <Jobs jobs={jobs} />}
          {view === "settings" && <Settings info={info} update={update} />}
        </main>
      </div>

      {phoneOpen && (
        <PhonePanel status={remote} onClose={() => setPhoneOpen(false)}
          onOpenChat={() => { setView("chat"); setPhoneChat((n) => n + 1); }} />
      )}

      <footer className="statusbar">
        <span className="row" style={{ gap: 6 }}>
          <span className={`led ${info?.serverRunning ? "on" : "off"}`} /> server {info?.serverRunning ? "up" : "idle"}
        </span>
        <span>gpu {info?.gpu.freeGb ?? "?"} / {info?.gpu.totalGb ?? "?"} GB free</span>
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
