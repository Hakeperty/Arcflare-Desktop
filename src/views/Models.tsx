// Models on this machine, and the hub's catalogue: what fits your GPU, and one
// click to download it or set it up.

import { useEffect, useMemo, useState } from "react";
import { api, type HubModel, type LoadedModel, type LocalModel, type ModelProgress } from "../lib/api";
import { EmptyState, JobStatus, Meter, Progress, ViewHead, fmtCtx, useJob } from "../ui/kit";
import { progressText, type View } from "../App";
import { Term } from "../ui/Term";

export function Models({ loaded, progress, go, freeGb }: { loaded: LoadedModel | null; progress: ModelProgress | null; go: (v: View) => void; freeGb?: number | null }) {
  const [tab, setTab] = useState<"local" | "hub">("local");
  return (
    <div className="page flush">
      <div className="tabs">
        <button className={`tab${tab === "local" ? " on" : ""}`} onClick={() => setTab("local")}>on this machine</button>
        <button className={`tab${tab === "hub" ? " on" : ""}`} onClick={() => setTab("hub")}>hub</button>
      </div>
      <div className="page">{tab === "local" ? <Local loaded={loaded} progress={progress} go={go} freeGb={freeGb ?? null} /> : <Hub />}</div>
    </div>
  );
}

function Local({ loaded, progress, go, freeGb }: { loaded: LoadedModel | null; progress: ModelProgress | null; go: (v: View) => void; freeGb: number | null }) {
  const [list, setList] = useState<LocalModel[] | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { api.models().then(setList).catch((e) => setErr(e.message)); }, []);

  async function load(id: string) {
    setErr(""); setBusy(id);
    try { await api.loadModel(id); } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }

  if (!list) return <div className="muted">Reading GGUF headers…</div>;
  return (
    <>
      <ViewHead index="05" label="models" title="On this machine">
        GGUF models ArcFlare found in your llama.cpp cache and model folders. Loading sizes the context to the VRAM that&apos;s actually free.
      </ViewHead>
      {err && <div className="err" style={{ marginBottom: 10 }}>{err}</div>}
      {progress && busy && !["loaded", "failed"].includes(progress.stage) && (
        <div className="panel" style={{ padding: 10, marginBottom: 12 }}>
          <div className="mono dim" style={{ fontSize: 12, marginBottom: 6 }}>{progressText(progress)}</div>
          <Progress value={null} />
        </div>
      )}
      {list.length === 0 && (
        <EmptyState seed="no-models" title="No models yet">Open the <b>hub</b> tab, pick one that fits your GPU, and download it.</EmptyState>
      )}
      <div className="col" style={{ gap: 8 }}>
        {list.map((m) => {
          const isLoaded = loaded?.id === m.id;
          return (
            <div key={m.id} className={`card model-row${isLoaded ? " loaded" : ""}`}>
              <span className={`led ${isLoaded ? "on" : m.fits === false ? "err" : "off"}`} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="mono truncate" style={{ fontWeight: 600 }}>{m.id}</div>
                <div className="dim mono" style={{ fontSize: 12 }}>
                  <Term k="quant">{m.quant}</Term> · {m.sizeGb} GB · trained {fmtCtx(m.trainCtx)} <Term k="context">ctx</Term>{m.moe ? <> · <Term k="moe">MoE</Term> {m.moe}</> : ""}{m.vision ? " · vision" : ""}
                  {m.bestCtx ? ` · ${fmtCtx(m.bestCtx)} fits now` : ""}
                </div>
              </div>
              {freeGb
                ? <Meter need={m.sizeGb} of={isLoaded ? m.sizeGb + freeGb : freeGb}
                    label={isLoaded ? "loaded" : m.sizeGb <= freeGb ? `${Math.round((m.sizeGb / freeGb) * 100)}% of free VRAM` : "bigger than free VRAM"} />
                : <span />}
              {isLoaded
                ? <button className="btn sm on" onClick={() => go("chat")}>chat →</button>
                : <button className={`btn sm${busy === m.id ? " on" : ""}`} disabled={!!busy} onClick={() => load(m.id)}>{busy === m.id ? "loading…" : "load"}</button>}
            </div>
          );
        })}
      </div>
    </>
  );
}

const CATS = ["All", "Fits", "Chat", "Code", "Reasoning", "Vision", "Audio", "3D", "Embedding"];

function Hub() {
  const [data, setData] = useState<{ source: string; ageText: string; freeGb: number | null; models: HubModel[] } | null>(null);
  const [err, setErr] = useState("");
  const [cat, setCat] = useState("Fits");
  const [q, setQ] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJob(jobId);

  const load = (refresh?: boolean) => api.hub(refresh).then(setData).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  const shown = useMemo(() => {
    if (!data) return [];
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return data.models
      .filter((m) => cat === "All" || (cat === "Fits" ? m.fit === "fits" : m.category === cat))
      .filter((m) => words.every((w) => [m.name, m.author, m.category, ...m.tags, m.description].join(" ").toLowerCase().includes(w)))
      .sort((a, b) => vram(a) - vram(b));
  }, [data, cat, q]);

  async function install(m: HubModel) {
    setErr("");
    try { const j = await api.hubInstall(m.slug, m); setJobId(j.id); } catch (e) { setErr((e as Error).message); }
  }

  if (!data) return <div className="muted">{err || "Loading the hub…"}</div>;
  return (
    <>
      <ViewHead index="hub" label="arcflare.net" title="The hub" right={<>
        <span className={`chip ${data.source === "live" ? "ok" : "warn"}`}>{data.source === "live" ? "live" : data.source === "cache" ? `offline · ${data.ageText}` : "offline · bundled copy"}</span>
        <button className="btn sm" onClick={() => load(true)}>refresh</button>
      </>}>
        {data.freeGb ? <>Marked against the <b>{data.freeGb.toFixed(1)} GB</b> free on your GPU. </> : null}Smallest first.
      </ViewHead>
      <div className="row wrap" style={{ marginBottom: 12 }}>
        {CATS.map((c) => <button key={c} className={`btn sm${cat === c ? " on" : ""}`} onClick={() => setCat(c)}>{c}</button>)}
        <input className="input" style={{ maxWidth: 240, marginLeft: "auto" }} placeholder="search" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {job && <div className="panel" style={{ padding: 12, marginBottom: 12 }}><JobStatus job={job} />{job.log.length > 0 && <div className="log" style={{ marginTop: 8 }}>{job.log.slice(-6).join("\n")}</div>}</div>}
      {err && <div className="err" style={{ marginBottom: 10 }}>{err}</div>}
      <div className="grid3">
        {shown.map((m) => (
          <div key={m.slug} className="card col" style={{ gap: 8 }}>
            <div className="row">
              <span className="mono grow truncate" style={{ fontWeight: 600 }}>{m.name}</span>
              <span className="chip">{m.category}</span>
            </div>
            <div className="dim" style={{ fontSize: 12 }}>{m.author}</div>
            <div className="muted" style={{ fontSize: 13, lineHeight: 1.45, flex: 1 }}>{m.description}</div>
            <div className="row wrap" style={{ gap: 6 }}>
              <span className="chip">{m.defaultSize}</span>
              <span className="chip">{m.vram}</span>
              <span className={`chip ${m.fit === "fits" ? "ok" : m.fit === "tight" ? "warn" : m.fit === "no" ? "bad" : ""}`}>
                {m.fit === "fits" ? "fits" : m.fit === "tight" ? "tight" : m.fit === "no" ? "too big" : "?"}
              </span>
              {m.commercial === false && <span className="chip bad">non-commercial</span>}
            </div>
            <div className="row">
              {m.plan.kind !== "none"
                ? <button className="btn primary sm" onClick={() => install(m)}>{m.plan.kind === "pull" ? "download" : "set up"}</button>
                : <span className="dim mono" style={{ fontSize: 11 }}>no install command yet</span>}
              <button className="btn ghost sm" onClick={() => api.openExternal(m.url)}>page</button>
            </div>
          </div>
        ))}
      </div>
      {shown.length === 0 && <EmptyState seed="hub-empty" title="Nothing on this shelf">Try another category, or &quot;All&quot;.</EmptyState>}
    </>
  );
}

function vram(m: HubModel) {
  const x = /([\d.]+)\s*GB/i.exec(m.vram);
  return x ? Number(x[1]) : 1e9;
}
