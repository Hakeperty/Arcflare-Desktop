// Models on this machine, and the hub's catalogue: what fits your GPU, and one
// click to download it or set it up.

import { useEffect, useMemo, useState } from "react";
import { api, type Arc, type ArcList, type HubModel, type LoadedModel, type LocalModel, type ModelProgress } from "../lib/api";
import { EmptyState, JobStatus, Meter, Progress, ViewHead, fmtCtx, useJob } from "../ui/kit";
import { progressText, type View } from "../App";
import { Term } from "../ui/Term";

export function Models({ loaded, progress, go, freeGb }: { loaded: LoadedModel | null; progress: ModelProgress | null; go: (v: View) => void; freeGb?: number | null }) {
  const [tab, setTab] = useState<"local" | "arcs" | "hub">("local");
  return (
    <div className="page flush">
      <div className="tabs">
        <button className={`tab${tab === "local" ? " on" : ""}`} onClick={() => setTab("local")}>on this machine</button>
        <button className={`tab${tab === "arcs" ? " on" : ""}`} onClick={() => setTab("arcs")}>arcs</button>
        <button className={`tab${tab === "hub" ? " on" : ""}`} onClick={() => setTab("hub")}>hub</button>
      </div>
      <div className="page">
        {tab === "local" ? <Local loaded={loaded} progress={progress} go={go} freeGb={freeGb ?? null} />
          : tab === "arcs" ? <Arcs loaded={loaded} go={go} />
          : <Hub />}
      </div>
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

/** The notice an abliterated download needs a yes to, as one question. */
function acceptNotice(lines: string[]): boolean {
  const text = lines.length ? lines.join("\n\n") : "This is an abliterated model: its refusals were removed by someone other than its authors. For adults (18+), and only for lawful uses.";
  return window.confirm(`${text}\n\nDownload it?`);
}

const ARC_GROUPS: { key: Arc["group"]; title: string }[] = [
  { key: "general", title: "general" },
  { key: "task", title: "for one job" },
  { key: "security", title: "cybersecurity" },
];

/**
 * ArcFlare's own models. Each is an open base model picked for this GPU,
 * running under ArcFlare's instructions; the instructions themselves never
 * reach this screen.
 */
function Arcs({ loaded, go }: { loaded: LoadedModel | null; go: (v: View) => void }) {
  const [data, setData] = useState<ArcList | null>(null);
  const [side, setSide] = useState<Arc["side"]>("standard");
  const [shelf, setShelf] = useState<"all" | Arc["group"]>("all");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJob(jobId);

  const load = (refresh?: boolean) => api.arcs(refresh).then(setData).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  // A finished download makes an Arc ready: read the list again.
  useEffect(() => { if (job?.state === "done") load(); }, [job?.state]);

  async function use(a: Arc | null) {
    setErr(""); setBusy(a ? a.id : "off");
    try { await api.arcUse(a ? a.id : null); await load(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); }
  }

  async function install(a: Arc) {
    setErr("");
    const accept = a.side === "abliterated" ? acceptNotice(data?.notice ?? []) : false;
    if (a.side === "abliterated" && !accept) return;
    try { const j = await api.arcInstall(a.id, accept); setJobId(j.id); } catch (e) { setErr((e as Error).message); }
  }

  if (!data) return <div className="muted">{err || "Reading the Arcs…"}</div>;
  if (!data.available) {
    return <EmptyState seed="no-arcs" title="Arcs need a newer engine">Update ArcFlare, then come back: Arcs arrived in a later version of the engine than the one this app is running.</EmptyState>;
  }
  const active = data.arcs.find((a) => a.id === data.active) ?? null;
  const onSide = data.arcs.filter((a) => a.side === side);
  const shown = onSide.filter((a) => shelf === "all" || a.group === shelf);
  const count = (g: "all" | Arc["group"]) => onSide.filter((a) => g === "all" || a.group === g).length;

  return (
    <>
      <ViewHead index="arc" label="arcflare's own models" title="Arcs" right={<>
        {active
          ? <><span className="chip ok"><span className="led on" /> {active.name} in use</span><button className="btn sm" disabled={!!busy} onClick={() => use(null)}>stop using it</button></>
          : <span className="chip">no Arc in use</span>}
        <button className="btn sm" onClick={() => load(true)}>refresh</button>
      </>}>
        Each Arc is an open model, picked for your GPU, running under instructions written for ArcFlare: its chat, its agent and its tools.
        The weights are the base model&apos;s, unchanged, under Apache-2.0 or MIT. Choosing one sets it for Chat and the Agent.
        {data.freeGb ? <> Sized against the <b>{data.freeGb.toFixed(1)} GB</b> free on your GPU.</> : null}
      </ViewHead>

      <div className="row wrap" style={{ marginBottom: 12 }}>
        <button className={`btn sm${side === "standard" ? " on" : ""}`} onClick={() => { setSide("standard"); setShelf("all"); }}>arcs</button>
        <button className={`btn sm${side === "abliterated" ? " danger on" : ""}`} onClick={() => { setSide("abliterated"); setShelf("all"); }}>abliterated</button>
        <span className="dim mono" style={{ fontSize: 11, margin: "0 4px" }}>/</span>
        <button className={`btn sm${shelf === "all" ? " on" : ""}`} onClick={() => setShelf("all")}>all {count("all")}</button>
        {ARC_GROUPS.filter((g) => count(g.key) > 0).map((g) => (
          <button key={g.key} className={`btn sm${shelf === g.key ? " on" : ""}`} onClick={() => setShelf(g.key)}>{g.title} {count(g.key)}</button>
        ))}
      </div>

      {side === "abliterated" && (
        <div className="err" style={{ marginBottom: 12, lineHeight: 1.5 }}>
          {(data.notice.length ? data.notice : ["These run on abliterated models: third-party builds with their refusals removed. For adults (18+), and only for lawful uses."]).map((l) => <div key={l}>{l}</div>)}
          <div style={{ marginTop: 6 }}>An Arc&apos;s instructions keep the work to what is lawful and authorised, but a model with its refusals removed follows them only as far as it chooses to.</div>
        </div>
      )}
      {job && <div className="panel" style={{ padding: 12, marginBottom: 12 }}><JobStatus job={job} />{job.log.length > 0 && <div className="log" style={{ marginTop: 8 }}>{job.log.slice(-6).join("\n")}</div>}</div>}
      {err && <div className="err" style={{ marginBottom: 10 }}>{err}</div>}

      <div className="grid3">
        {shown.map((a) => {
          const inUse = data.active === a.id;
          const running = inUse && !!loaded && loaded.id === a.pick.modelId;
          return (
            <div key={a.id} className={`card col${inUse ? " loaded" : ""}`} style={{ gap: 8 }}>
              <div className="row">
                <span className="mono grow truncate" style={{ fontWeight: 600 }}>{a.name}</span>
                <span className={`chip${a.group === "security" ? " warn" : ""}`}>{a.group === "security" ? "security" : a.group === "task" ? "task" : "general"}</span>
              </div>
              <div className="dim" style={{ fontSize: 12 }}>{a.focus}</div>
              <div className="muted" style={{ fontSize: 13, lineHeight: 1.45, flex: 1 }}>{a.description}</div>
              <div className="dim mono" style={{ fontSize: 11, lineHeight: 1.5 }}>
                runs on <span style={{ color: "var(--fg)" }}>{a.pick.base.slug}</span> · {a.pick.base.license}
                {a.bases.length > 1 ? ` · ${a.bases.length} sizes, ${Math.min(...a.bases.map((b) => b.gb))}–${Math.max(...a.bases.map((b) => b.gb))} GB` : ""}
              </div>
              <div className="row wrap" style={{ gap: 6 }}>
                <span className="chip">~{a.pick.base.gb} GB</span>
                <span className={`chip ${a.pick.installed ? "ok" : a.pick.fits ? "" : "bad"}`}>{a.pick.installed ? "ready" : a.pick.fits ? "not downloaded" : "too big for free VRAM"}</span>
                {(a.needs ?? []).map((n) => <span key={n} className="chip" title={`Built around ArcFlare's ${n === "web" ? "web tools" : "desktop control"}: switch it on in the Agent view`}>uses {n}</span>)}
              </div>
              <div className="row">
                {a.pick.installed
                  ? running
                    ? <button className="btn sm on" onClick={() => go("chat")}>chat →</button>
                    : <button className={`btn primary sm${busy === a.id ? " on" : ""}`} disabled={!!busy} onClick={() => use(a)}>{busy === a.id ? "loading…" : inUse ? "load" : "use"}</button>
                  : <button className="btn primary sm" disabled={!!jobId && job?.state === "running"} onClick={() => install(a)}>download</button>}
                <button className="btn ghost sm" onClick={() => api.openExternal(`https://arcflare.net/models/${a.id}`)}>page</button>
              </div>
            </div>
          );
        })}
      </div>
      {shown.length === 0 && <EmptyState seed="arcs-empty" title="Nothing on this shelf">Try &quot;all&quot;.</EmptyState>}
    </>
  );
}

const CATS = ["All", "Fits", "Chat", "Code", "Reasoning", "Vision", "Audio", "3D", "Embedding"];

// The hub's collections, the same four as arcflare.net/models: everything, the
// security models, ArcFlare's own, and the builds with refusals removed, which
// have a cybersecurity and an arcs shelf of their own.
type Collection = "all" | "cybersecurity" | "arcs" | "abliterated";
type Shelf = "all" | "cybersecurity" | "arcs";
const has = (m: HubModel, t: string) => m.tags.includes(t);
const isAbliterated = (m: HubModel) => has(m, "abliterated") || has(m, "uncensored");
function inCollection(m: HubModel, tab: Collection, shelf: Shelf): boolean {
  if (tab === "all") return true;
  if (tab === "cybersecurity") return has(m, "security") && !isAbliterated(m);
  if (tab === "arcs") return has(m, "arc") && !isAbliterated(m);
  if (!isAbliterated(m)) return false;
  return shelf === "all" || has(m, shelf === "cybersecurity" ? "security" : "arc");
}

function Hub() {
  const [data, setData] = useState<{ source: string; ageText: string; freeGb: number | null; notice?: string[]; models: HubModel[] } | null>(null);
  const [err, setErr] = useState("");
  const [cat, setCat] = useState("Fits");
  const [tab, setTab] = useState<Collection>("all");
  const [shelf, setShelf] = useState<Shelf>("all");
  const [q, setQ] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJob(jobId);

  const load = (refresh?: boolean) => api.hub(refresh).then(setData).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  const shown = useMemo(() => {
    if (!data) return [];
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return data.models
      .filter((m) => inCollection(m, tab, shelf))
      .filter((m) => cat === "All" || (cat === "Fits" ? m.fit === "fits" : m.category === cat))
      .filter((m) => words.every((w) => [m.name, m.author, m.category, ...m.tags, m.description].join(" ").toLowerCase().includes(w)))
      .sort((a, b) => vram(a) - vram(b));
  }, [data, cat, q, tab, shelf]);

  async function install(m: HubModel) {
    setErr("");
    // The same notice the CLI shows before it downloads a build with its refusals removed.
    const accept = isAbliterated(m) ? acceptNotice(data?.notice ?? []) : false;
    if (isAbliterated(m) && !accept) return;
    try { const j = await api.hubInstall(m.slug, m, accept); setJobId(j.id); } catch (e) { setErr((e as Error).message); }
  }
  const n = (t: Collection, sh: Shelf = "all") => (data ? data.models.filter((m) => inCollection(m, t, sh)).length : 0);

  if (!data) return <div className="muted">{err || "Loading the hub…"}</div>;
  return (
    <>
      <ViewHead index="hub" label="arcflare.net" title="The hub" right={<>
        <span className={`chip ${data.source === "live" ? "ok" : "warn"}`}>{data.source === "live" ? "live" : data.source === "cache" ? `offline · ${data.ageText}` : "offline · bundled copy"}</span>
        <button className="btn sm" onClick={() => load(true)}>refresh</button>
      </>}>
        {data.freeGb ? <>Marked against the <b>{data.freeGb.toFixed(1)} GB</b> free on your GPU. </> : null}Smallest first.
      </ViewHead>
      <div className="row wrap" style={{ marginBottom: 8 }}>
        {([["all", "all models"], ["cybersecurity", "cybersecurity"], ["arcs", "arcs"], ["abliterated", "abliterated"]] as const).map(([key, label]) => (
          <button key={key} className={`btn sm${tab === key ? (key === "abliterated" ? " danger on" : " on") : ""}`}
            onClick={() => { setTab(key); setShelf("all"); if (key !== "all") setCat("All"); }}>
            {label} <span className="dim">{n(key)}</span>
          </button>
        ))}
        {tab === "abliterated" && (
          <>
            <span className="dim mono" style={{ fontSize: 11, margin: "0 4px" }}>/</span>
            {(["all", "cybersecurity", "arcs"] as const).map((key) => (
              <button key={key} className={`btn sm${shelf === key ? " on" : ""}`} onClick={() => setShelf(key)}>
                {key} <span className="dim">{n("abliterated", key)}</span>
              </button>
            ))}
          </>
        )}
      </div>
      {tab === "abliterated" && (
        <div className="err" style={{ marginBottom: 10, lineHeight: 1.5 }}>
          {(data.notice && data.notice.length ? data.notice : ["These are abliterated models: third-party builds with their refusals removed. For adults (18+), and only for lawful uses."]).map((l) => <div key={l}>{l}</div>)}
        </div>
      )}
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
                ? <button className="btn primary sm" onClick={() => install(m)}>{m.plan.kind === "pull" || m.plan.kind === "arc" ? "download" : "set up"}</button>
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
