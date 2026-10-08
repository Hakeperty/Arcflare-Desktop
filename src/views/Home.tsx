// The first screen: what this machine has, what is loaded, what is running,
// and one click to each thing people come here to do.

import type { Job, LoadedModel, SystemInfo } from "../lib/api";
import { DotArt, Label, Meter, Panel, Spec, JobStatus } from "../ui/kit";
import type { View } from "../App";

export function Home({ info, loaded, go, jobs }: { info: SystemInfo | null; loaded: LoadedModel | null; go: (v: View) => void; jobs: Job[] }) {
  const ready = !!info?.llamaServer;
  const actions: { title: string; body: string; view: View; tag: string }[] = [
    { title: "Chat", body: "Talk to a model running on your own GPU. Nothing is sent anywhere.", view: "chat", tag: "01" },
    { title: "Agent", body: "Open a folder and ask. It reads, edits and runs commands there, asking before anything risky.", view: "agent", tag: "02" },
    { title: "Studio", body: "Images, 3D you can edit by pointing and asking, speech, and flows that chain them.", view: "studio", tag: "03" },
    { title: "Models", body: "What's on this machine, what fits your GPU, and one click to download more.", view: "models", tag: "04" },
    { title: "Harnesses", body: "OpenCode, Hermes or Codex, pointed at your local model, in a terminal.", view: "harnesses", tag: "05" },
  ];
  const total = info?.gpu.totalGb ?? 0;
  const free = info?.gpu.freeGb ?? null;

  return (
    <div className="page">
      <section className="banner marks">
        <DotArt seed="arcflare-home" cols={64} rows={14} className="banner-art" />
        <Label index="00">machine</Label>
        <div className="h1" style={{ fontSize: 26, margin: "8px 0 6px" }}>Your models, on your hardware.</div>
        <p className="muted" style={{ margin: 0, maxWidth: 560 }}>
          ArcFlare runs open models locally: chat, a coding agent, images, 3D and speech. No account, no cloud, no limits but your GPU.
        </p>
        <div className="row" style={{ marginTop: 16, gap: 8 }}>
          {loaded
            ? <button className="btn primary" onClick={() => go("chat")}>chat with {loaded.name}</button>
            : <button className="btn primary" onClick={() => go("models")}>choose a model</button>}
          <button className="btn" onClick={() => go("agent")}>open the agent</button>
        </div>
      </section>

      {!ready && info && (
        <div className="panel" style={{ borderColor: "var(--accent)", background: "var(--accent-soft)", padding: 14, marginBottom: 16 }}>
          <b>One thing first:</b> ArcFlare needs llama.cpp to run language models. Download a build for your GPU from{" "}
          <a href="https://github.com/ggml-org/llama.cpp/releases" target="_blank" rel="noreferrer">github.com/ggml-org/llama.cpp</a>, then
          set its <code className="md-code">llama-server</code> path in <a href="#" onClick={(e) => { e.preventDefault(); go("settings"); }}>Settings</a>.
        </div>
      )}

      <div className="grid2">
        <Panel title="this machine" right={<span className={`led ${info ? "on" : "busy"}`} />}>
          <dl className="col" style={{ gap: 6, margin: 0 }}>
            <Spec k="gpu free" v={free != null ? `${free} GB${total ? ` of ${total}` : ""}` : "…"} />
            {total > 0 && free != null && (
              <Meter need={total - free} of={total} label={`${(total - free).toFixed(1)} GB in use`} />
            )}
            <Spec k="ram" v={info ? `${info.ramGb} GB` : "…"} />
            <Spec k="llama.cpp" v={info?.llamaServer ? "found" : "not found"} />
            <Spec k="python (3d/tts)" v={info?.python ? "ready" : "not set up"} />
            <Spec k="engine" v={info?.engineVersion ?? "…"} />
          </dl>
        </Panel>
        <Panel title="chat model" right={<span className={`led ${loaded ? "on" : "off"}`} />}>
          {loaded ? (
            <dl className="col" style={{ gap: 6, margin: 0 }}>
              <Spec k="model" v={loaded.name} />
              <Spec k="id" v={loaded.id} />
              <Spec k="context" v={`${Math.round(loaded.ctx / 1024)}K tokens`} />
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn primary sm" onClick={() => go("chat")}>open chat</button>
                <button className="btn sm" onClick={() => go("agent")}>agent</button>
              </div>
            </dl>
          ) : (
            <div className="col" style={{ gap: 10 }}>
              <span className="muted">Nothing loaded. Pick a model in Chat or Models, and ArcFlare sizes its context to your free VRAM.</span>
              <div className="row"><button className="btn sm" onClick={() => go("models")}>choose a model</button></div>
            </div>
          )}
        </Panel>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12, marginTop: 16 }}>
        {actions.map((a) => (
          <div key={a.view} className="card click col" style={{ gap: 0 }} onClick={() => go(a.view)}>
            <div className="label"><span className="a">{a.tag}</span></div>
            <div className="h2" style={{ marginTop: 10 }}>{a.title}</div>
            <p className="muted" style={{ fontSize: 13, margin: "6px 0 0", flex: 1 }}>{a.body}</p>
            <div className="go">open →</div>
          </div>
        ))}
      </div>

      {jobs.length > 0 && (
        <Panel title="recent jobs" className="" right={<button className="btn ghost sm" onClick={() => go("jobs")}>all</button>}>
          <div className="col">{jobs.slice(0, 4).map((j) => <JobStatus key={j.id} job={j} />)}</div>
        </Panel>
      )}
    </div>
  );
}
