// First run: from "just installed" to "a model said hello" in four steps —
// what this machine has, the engine (llama.cpp), a first model that fits, and
// a hello. Every step can be skipped, closing keeps your place, and finishing
// remembers it (Settings and Home can open it again).

import { useEffect, useMemo, useRef, useState } from "react";
import { api, on, uid, type HubModel, type LocalModel, type ModelProgress, type SystemInfo } from "../lib/api";
import { setup, type SetupState } from "../lib/setup";
import { DotArt, Label, Meter, Progress, Spec, useJob } from "./kit";
import { Term } from "./Term";
import type { View } from "../App";

type Step = "machine" | "engine" | "model" | "hello";
const STEPS: { id: Step; label: string }[] = [
  { id: "machine", label: "your machine" },
  { id: "engine", label: "the engine" },
  { id: "model", label: "a first model" },
  { id: "hello", label: "say hello" },
];
const STEP_KEY = "arcflare.setup.step";

// Beginner-friendly chat models, best first. The first one that fits is the pick.
const PREFER = ["qwen3.5", "gpt-oss", "qwen3", "deepseek-r1-0528", "phi4-mini", "smollm3", "gemma3-270m"];

const vramOf = (m: HubModel) => { const x = /([\d.]+)\s*GB/i.exec(m.vram); return x ? Number(x[1]) : null; };

export function Welcome({ info, onRefresh, onClose, go }: {
  info: SystemInfo | null;
  onRefresh: () => void;
  onClose: (finished: boolean) => void;
  go: (v: View) => void;
}) {
  const [st, setSt] = useState<SetupState | null>(null);
  const [step, setStep] = useState<Step>(() => {
    try { const s = localStorage.getItem(STEP_KEY) as Step | null; return s && STEPS.some((x) => x.id === s) ? s : "machine"; } catch { return "machine"; }
  });
  useEffect(() => { setup.state().then(setSt).catch(() => {}); }, []);
  useEffect(() => { try { localStorage.setItem(STEP_KEY, step); } catch { /* storage blocked */ } }, [step]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(false); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  const idx = STEPS.findIndex((s) => s.id === step);
  const next = () => setStep(STEPS[Math.min(STEPS.length - 1, idx + 1)].id);
  const finish = async (v?: View) => {
    await setup.done(true).catch(() => {});
    try { localStorage.removeItem(STEP_KEY); } catch { /* ignore */ }
    onClose(true);
    if (v) go(v);
  };

  return (
    <div className="modal-back welcome-back">
      <div className="welcome" role="dialog" aria-label="Set up ArcFlare">
        <aside className="welcome-rail">
          <DotArt seed="arcflare-welcome" cols={22} rows={8} className="welcome-art" />
          <div className="welcome-brand">arc<b>flare</b></div>
          <div className="dim" style={{ fontSize: 12, marginBottom: 18 }}>set up in four steps</div>
          <ol className="welcome-steps">
            {STEPS.map((s, i) => (
              <li key={s.id}>
                <button className={`welcome-step${s.id === step ? " on" : i < idx ? " done" : ""}`} onClick={() => setStep(s.id)}>
                  <span className="n">{i < idx ? "✓" : `0${i + 1}`}</span> {s.label}
                </button>
              </li>
            ))}
          </ol>
          <span className="grow" />
          <button className="btn ghost sm" onClick={() => onClose(false)} title="Close; your place is kept (Home → finish setup)">later</button>
        </aside>

        <section className="welcome-main">
          {step === "machine" && <MachineStep info={info} st={st} onNext={next} />}
          {step === "engine" && <EngineStep info={info} st={st} onRefresh={onRefresh} onNext={next} />}
          {step === "model" && <ModelStep info={info} onNext={next} />}
          {step === "hello" && <HelloStep info={info} onFinish={finish} />}
          {step !== "hello" && (
            <div className="welcome-skip">
              <button className="btn ghost sm" onClick={next}>skip this step →</button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- steps ----

function StepHead({ n, label, title, children }: { n: string; label: string; title: string; children?: React.ReactNode }) {
  return (
    <header style={{ marginBottom: 18 }}>
      <Label index={n}>{label}</Label>
      <div className="h1" style={{ fontSize: 24, margin: "8px 0 6px" }}>{title}</div>
      {children && <p className="muted" style={{ margin: 0, maxWidth: 560, lineHeight: 1.55 }}>{children}</p>}
    </header>
  );
}

function MachineStep({ info, st, onNext }: { info: SystemInfo | null; st: SetupState | null; onNext: () => void }) {
  const free = info?.gpu.freeGb ?? null, total = info?.gpu.totalGb ?? null;
  const verdict = free == null ? "We'll check what fits once the engine is set up."
    : free >= 20 ? "Plenty of room: big, capable models will run well here."
    : free >= 10 ? "A solid machine: good chat and coding models fit comfortably."
    : free >= 5 ? "Enough for fast small models — great for chat and getting started."
    : "Tight on graphics memory, so we'll pick a small model. It'll still be fast.";
  return (
    <>
      <StepHead n="01" label="your machine" title="Welcome. Let's see what this computer can run.">
        ArcFlare runs AI models on your own hardware: nothing is sent anywhere, there's no account, and it's free.
        The most important number is your graphics card's memory (<Term k="vram" />).
      </StepHead>
      <div className="panel" style={{ padding: 16 }}>
        <dl className="col" style={{ gap: 8, margin: 0 }}>
          <Spec k="graphics" v={st?.gpu.name ?? "…"} />
          <Spec k={<>free <Term k="vram">vram</Term></>} v={free != null ? `${free} GB${total ? ` of ${total}` : ""}` : "not measured yet"} />
          {free != null && total ? <Meter need={total - free} of={total} label={`${(total - free).toFixed(1)} GB already in use`} /> : null}
          <Spec k="memory (ram)" v={info ? `${info.ramGb} GB` : "…"} />
          <Spec k={<Term k="llamacpp">llama.cpp</Term>} v={info ? (info.llamaServer ? <span className="ok-t">found ✓</span> : <span className="warn-t">not yet — next step</span>) : "…"} />
          <Spec k="python (3d & speech)" v={info ? (info.python ? "ready" : "optional, later") : "…"} />
        </dl>
      </div>
      <p className="welcome-verdict">{verdict}</p>
      <div className="row" style={{ gap: 8 }}><button className="btn primary" onClick={onNext}>next: the engine →</button></div>
    </>
  );
}

function EngineStep({ info, st, onRefresh, onNext }: { info: SystemInfo | null; st: SetupState | null; onRefresh: () => void; onNext: () => void }) {
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const found = st?.pretendNoEngine ? null : info?.llamaServer;

  async function findIt() {
    setBusy(true); setMsg("");
    try {
      const p = await setup.find();
      setMsg(p ? `Found it: ${p}` : "Not found in the usual places yet. Download it below, or point to it yourself.");
      onRefresh();
    } catch (e) { setMsg((e as Error).message); }
    setBusy(false);
  }
  async function pickIt() {
    setMsg("");
    const exe = platformExe();
    const p = await api.pickFile({ title: `Choose llama-server${exe}`, filters: exe ? [{ name: "llama-server", extensions: ["exe"] }] : [] }).catch(() => null);
    if (!p) return;
    await api.saveSettings({ llamaServer: p });
    setMsg(`Saved: ${p}`);
    onRefresh();
  }

  if (found) {
    return (
      <>
        <StepHead n="02" label="the engine" title="The engine is ready.">
          <Term k="llamacpp" /> is what actually runs models on your GPU. ArcFlare found it, so there's nothing to do here.
        </StepHead>
        <div className="panel" style={{ padding: 14 }}><Spec k="llama-server" v={<span className="mono" style={{ fontSize: 12 }}>{found}</span>} /></div>
        <div className="row" style={{ gap: 8, marginTop: 18 }}><button className="btn primary" onClick={onNext}>next: pick a model →</button></div>
      </>
    );
  }

  return (
    <>
      <StepHead n="02" label="the engine" title="One download: the engine that runs models.">
        ArcFlare uses <Term k="llamacpp" />, a free, open engine, to run language models on your GPU. It isn't bundled,
        because the right build depends on your graphics card. It takes two minutes.
      </StepHead>
      <div className="welcome-options">
        <div className="card col">
          <div className="label"><span className="a">a</span> already have it?</div>
          <p className="muted" style={{ fontSize: 13, flex: 1 }}>We'll look on your PATH and in the usual folders.</p>
          <div className="row" style={{ gap: 6 }}>
            <button className="btn primary sm" disabled={busy} onClick={findIt}>{busy ? "looking…" : "find it for me"}</button>
            <button className="btn sm" onClick={pickIt}>choose the file…</button>
          </div>
        </div>
        <div className="card col">
          <div className="label"><span className="a">b</span> download it</div>
          {st ? (
            <>
              <p className="muted" style={{ fontSize: 13, margin: "6px 0" }}>
                For your {st.gpu.name ?? "graphics card"}, get the <b>{st.build.backend}</b> build: {st.build.why}
              </p>
              <div className="welcome-file">{st.build.file}</div>
              <ol className="welcome-howto">
                <li><button className="linkbtn" onClick={() => api.openExternal(st.releases)}>Open the official releases page ↗</button> and download that file.</li>
                <li><button className="linkbtn" onClick={() => setup.folder().catch(() => {})}>Open the folder</button> <span className="dim mono" style={{ fontSize: 11 }}>{st.build.folder}</span> and unzip it there.</li>
                <li>Come back and press <b>find it for me</b>.</li>
              </ol>
            </>
          ) : <p className="muted">Checking your graphics card…</p>}
        </div>
      </div>
      {msg && <p className="welcome-msg">{msg}</p>}
    </>
  );
}

function platformExe() { return window.arc.platform === "win32" ? ".exe" : ""; }

function ModelStep({ info, onNext }: { info: SystemInfo | null; onNext: () => void }) {
  const [local, setLocal] = useState<LocalModel[] | null>(null);
  const [hub, setHub] = useState<{ freeGb: number | null; models: HubModel[] } | null>(null);
  const [err, setErr] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [progress, setProgress] = useState<ModelProgress | null>(null);
  const before = useRef<Set<string>>(new Set());
  const job = useJob(jobId);

  useEffect(() => {
    api.models().then((m) => { setLocal(m); before.current = new Set(m.map((x) => x.id)); }).catch(() => setLocal([]));
    api.hub().then(setHub).catch((e) => setErr(e.message));
  }, []);
  useEffect(() => on("model:progress", (p: ModelProgress) => setProgress(p)), []);

  const freeGb = hub?.freeGb ?? info?.gpu.freeGb ?? null;
  const picks = useMemo(() => {
    if (!hub) return [];
    const ok = hub.models.filter((m) => m.plan.kind === "pull" && (m.category === "Chat" || m.category === "Reasoning")
      && (freeGb == null ? (vramOf(m) ?? 99) <= 8 : m.fit === "fits"));
    return PREFER.map((s) => ok.find((m) => m.slug === s)).filter(Boolean).slice(0, 3) as HubModel[];
  }, [hub, freeGb]);
  // Models already on disk: ones that fit right now first, then the rest
  // (they may fit once something else lets go of the GPU).
  const usable = [...(local ?? [])].sort((a, b) => Number(b.fits !== false) - Number(a.fits !== false) || b.sizeGb - a.sizeGb).slice(0, 4);

  async function load(id: string) {
    setErr(""); setLoading(id);
    try { await api.loadModel(id); onNext(); } catch (e) { setErr((e as Error).message); setLoading(null); }
  }
  async function download(m: HubModel) {
    setErr("");
    try { const j = await api.hubInstall(m.slug, m); setJobId(j.id); } catch (e) { setErr((e as Error).message); }
  }
  // When the download finishes, find the new file and load it.
  useEffect(() => {
    if (!job || job.state !== "done" || loading) return;
    api.models().then((m) => {
      setLocal(m);
      const fresh = m.find((x) => !before.current.has(x.id));
      if (fresh) load(fresh.id); else setErr("Downloaded, but the new model didn't show up in the list. Pick it below.");
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.state]);

  if (!info?.llamaServer) {
    return (
      <>
        <StepHead n="03" label="a first model" title="Set up the engine first.">
          Models need <Term k="llamacpp" /> to run. Go back one step, then come back here.
        </StepHead>
      </>
    );
  }

  return (
    <>
      <StepHead n="03" label="a first model" title="Pick a first model.">
        {freeGb != null ? <>These fit the <b>{freeGb.toFixed(1)} GB</b> free on your graphics card. </> : null}
        A model is one <Term k="gguf">GGUF</Term> file; bigger ones are smarter, smaller ones are faster. You can add more any time in Models.
      </StepHead>

      {loading ? (
        <div className="panel" style={{ padding: 16 }}>
          <div className="row" style={{ gap: 8 }}><span className="led busy" /> loading <b>{loading}</b>…</div>
          <div className="dim mono" style={{ fontSize: 12, marginTop: 8 }}>{progress ? stageText(progress) : "starting"}</div>
          <div style={{ marginTop: 10 }}><Progress value={null} /></div>
          <p className="dim" style={{ fontSize: 12, marginBottom: 0 }}>The first load takes a little while: the model is read from disk into your GPU.</p>
        </div>
      ) : job && job.state !== "done" ? (
        <div className="panel" style={{ padding: 16 }}>
          <div className="row" style={{ gap: 8 }}><span className={`led ${job.state === "running" ? "busy" : "off"}`} /> {job.title}</div>
          <div style={{ marginTop: 10 }}><Progress value={job.progress} /></div>
          <div className="dim mono" style={{ fontSize: 12, marginTop: 8 }}>{job.state === "failed" ? `failed: ${job.error}` : job.stage}</div>
          {job.state !== "running" && <button className="btn sm" style={{ marginTop: 10 }} onClick={() => setJobId(null)}>back</button>}
        </div>
      ) : (
        <>
          {usable.length > 0 && (
            <>
              <div className="label" style={{ margin: "4px 0 8px" }}>already on this computer</div>
              <div className="col" style={{ gap: 8, marginBottom: 18 }}>
                {usable.map((m) => (
                  <div key={m.id} className="welcome-pick">
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="mono truncate" style={{ fontWeight: 600 }}>{m.name}</div>
                      <div className="dim mono" style={{ fontSize: 11 }}>
                        {m.quant} · {m.sizeGb} GB{m.bestCtx ? ` · ${Math.round(m.bestCtx / 1024)}K context` : ""}
                        {m.fits === false && <span className="warn-t"> · needs more free memory than you have right now</span>}
                      </div>
                    </div>
                    <button className={`btn sm${m.fits !== false && !usable.some((x, i) => i < usable.indexOf(m) && x.fits !== false) ? " primary" : ""}`} onClick={() => load(m.id)}>use this</button>
                  </div>
                ))}
              </div>
            </>
          )}
          <div className="label" style={{ margin: "4px 0 8px" }}>{usable.length ? "or download a recommended one" : "recommended for you"}</div>
          {!hub && !err && <div className="muted">Loading the model list…</div>}
          <div className="col" style={{ gap: 8 }}>
            {picks.map((m, i) => {
              const need = vramOf(m);
              return (
                <div key={m.slug} className={`welcome-pick${i === 0 ? " best" : ""}`}>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="row" style={{ gap: 8 }}>
                      <span className="mono" style={{ fontWeight: 600 }}>{m.name}</span>
                      {i === 0 && <span className="chip ok">best pick</span>}
                    </div>
                    <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>{reason(m, freeGb)}</div>
                    {need && freeGb ? <div style={{ marginTop: 6, maxWidth: 280 }}><Meter need={need} of={freeGb} label={`${m.defaultSize} · about ${need} GB of your ${freeGb.toFixed(0)} GB`} /></div> : null}
                  </div>
                  <button className={`btn sm${i === 0 ? " primary" : ""}`} onClick={() => download(m)}>download</button>
                </div>
              );
            })}
            {hub && picks.length === 0 && <div className="muted">Nothing in the list fits right now. Free some graphics memory, or open Models to browse.</div>}
          </div>
        </>
      )}
      {err && <p className="welcome-msg err">{err}</p>}
    </>
  );
}

function reason(m: HubModel, freeGb: number | null): string {
  const what = m.category === "Reasoning" ? "thinks before it answers — good for tricky questions" : "fast, friendly chat";
  const room = freeGb ? `, fits your ${Math.round(freeGb)} GB card` : "";
  return `${what}${room}.`;
}

function stageText(p: ModelProgress): string {
  switch (p.stage) {
    case "planning": return "working out how much context fits…";
    case "server-starting": return `starting the engine… ${Math.round((p.ms || 0) / 1000)}s`;
    case "server-ready": return "engine ready";
    case "loading": return `loading at ${Math.round((p.ctx || 0) / 1024)}K context…`;
    case "retry": return "didn't fit — trying a smaller setting";
    case "failed": return `failed: ${p.error}`;
    default: return p.stage;
  }
}

function HelloStep({ info, onFinish }: { info: SystemInfo | null; onFinish: (v?: View) => void }) {
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "talking" | "done" | "error">("idle");
  const [err, setErr] = useState("");
  const [speed, setSpeed] = useState<number | null>(null);
  const rid = useRef("");
  const loaded = info?.loaded ?? null;

  useEffect(() => on("chat:delta", (d: { requestId: string; kind: string; text: string }) => {
    if (d.requestId === rid.current && d.kind === "content") setText((t) => t + d.text);
  }), []);

  async function hello() {
    rid.current = "hello-" + uid();
    setText(""); setErr(""); setState("talking");
    try {
      const r = await api.chat(rid.current, { messages: [{ role: "user", content: "Say hello to me in one short, friendly sentence. I just installed ArcFlare." }] });
      setText((t) => t || r.text);
      setSpeed(r.tokPerSec);
      setState("done");
    } catch (e) { setErr((e as Error).message); setState("error"); }
  }
  // Say hello as soon as there's a model to say it.
  useEffect(() => { if (loaded && state === "idle") hello(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [loaded]);

  return (
    <>
      <StepHead n="04" label="say hello" title={state === "done" ? "You're set." : "Say hello."}>
        {loaded
          ? <>Your model, <b>{loaded.name}</b>, is running on your own graphics card.</>
          : "Load a model in the previous step and it will say hello here."}
      </StepHead>
      <div className="welcome-hello">
        <div className="dim mono" style={{ fontSize: 11, marginBottom: 6 }}>{loaded ? loaded.name : "no model"} says</div>
        <div className="welcome-hello-text">{text || (state === "talking" ? "…" : "")}{state === "talking" && <span className="caret" />}</div>
        {speed ? <div className="dim mono" style={{ fontSize: 11, marginTop: 8 }}>{speed.toFixed(1)} <Term k="toks">tok/s</Term> on this machine</div> : null}
        {err && <p className="welcome-msg err">{err}</p>}
      </div>
      <div className="row" style={{ gap: 8, marginTop: 20, flexWrap: "wrap" }}>
        <button className="btn primary" onClick={() => onFinish("chat")}>open chat</button>
        <button className="btn" onClick={() => onFinish("agent")}>try the agent</button>
        <button className="btn" onClick={() => onFinish("studio")}>open the studio</button>
        {loaded && state !== "talking" && <button className="btn ghost" onClick={hello}>say hello again</button>}
        <span className="grow" />
        <button className="btn ghost sm" onClick={() => onFinish()}>finish</button>
      </div>
    </>
  );
}
