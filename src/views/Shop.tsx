// The shop: open models, each marked against the GPU memory you actually have,
// and one click to download. Two shelves:
//   picks         the ArcFlare catalogue (arcflare.net/models): chosen, described,
//                 licence-checked, with things that aren't language models too
//   hugging face  every GGUF repo on Hugging Face, searched live, with each
//                 quantisation's real file size and whether it fits
// Downloads run as jobs (the same `arcflare pull` the CLI uses), so they land
// where llama.cpp looks, resume if interrupted, and are checksummed.

import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Fit, type HubCatalogue, type HubModel, type Job, type ShopRepo, type ShopResult, type ShopSort } from "../lib/api";
import { EmptyState, JobStatus, Meter, Progress, ViewHead } from "../ui/kit";
import type { View } from "../App";
import { FIT_TEXT, ago, fmtCount, paramsFromName, recommendQuant, sortPicks, taskLabel, vramGb, type PickSort } from "../lib/shop";
import { Term } from "../ui/Term";

const fitChip = (f: Fit) => (f === "fits" ? "ok" : f === "tight" ? "warn" : f === "no" ? "bad" : "");
const fitTone = (f: Fit) => (f === "fits" ? "ok" : f === "tight" ? "warn" : f === "no" ? "bad" : undefined);

export function Shop({ jobs, go, freeGb }: { jobs: Job[]; go: (v: View) => void; freeGb: number | null }) {
  const [shelf, setShelf] = useState<"picks" | "hf">("picks");
  const [repo, setRepo] = useState<string | null>(null);
  const downloads = jobs.filter((j) => j.kind === "download");

  return (
    <div className="page flush">
      <div className="tabs">
        <button className={`tab${shelf === "picks" ? " on" : ""}`} onClick={() => setShelf("picks")}>ArcFlare picks</button>
        <button className={`tab${shelf === "hf" ? " on" : ""}`} onClick={() => setShelf("hf")}>All of Hugging Face</button>
      </div>
      <div className="page">
        <ViewHead index="05" label="shop" title="The shop" right={<button className="btn sm" onClick={() => go("models")}>my models</button>}>
          {shelf === "picks"
            ? <>Chosen open models with their licences, marked against {freeGb ? <>the <b>{freeGb.toFixed(1)} GB</b> free on your GPU</> : "your GPU"}. The biggest that fits comes first.</>
            : <>Every <Term k="gguf">GGUF</Term> model on Hugging Face. Pick a file and see whether it fits before you download it.</>}
        </ViewHead>
        <Downloads jobs={downloads} go={go} />
        {shelf === "picks"
          ? <Picks jobs={jobs} onRepo={setRepo} />
          : <HuggingFace onRepo={setRepo} />}
      </div>
      {repo && <Drawer repo={repo} jobs={jobs} onClose={() => setRepo(null)} />}
    </div>
  );
}

// ------------------------------------------------------------- downloads ----

function Downloads({ jobs, go }: { jobs: Job[]; go: (v: View) => void }) {
  const recent = jobs.slice(0, 4);
  if (!recent.length) return null;
  return (
    <div className="panel" style={{ padding: 12, marginBottom: 14 }}>
      <div className="col" style={{ gap: 10 }}>
        {recent.map((j) => (
          <div key={j.id} className="col" style={{ gap: 4 }}>
            <JobStatus job={j} />
            {j.state === "running" && (
              <div className="dim mono truncate" style={{ fontSize: 11 }} title={j.stage}>{j.stage}</div>
            )}
            <div className="row" style={{ gap: 6 }}>
              {j.state === "running" && <button className="btn ghost sm" onClick={() => api.cancelJob(j.id)}>cancel</button>}
              {j.state === "done" && <button className="btn sm primary" onClick={() => go("models")}>it&apos;s in my models →</button>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const runningFor = (jobs: Job[], pred: (j: Job) => boolean) => jobs.find((j) => j.state === "running" && pred(j));
const doneFor = (jobs: Job[], pred: (j: Job) => boolean) => jobs.some((j) => j.state === "done" && pred(j));

// ----------------------------------------------------------------- picks ----

function Picks({ jobs, onRepo }: { jobs: Job[]; onRepo: (repo: string) => void }) {
  const [data, setData] = useState<HubCatalogue | null>(null);
  const [err, setErr] = useState("");
  const [cat, setCat] = useState("All");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<PickSort>("best");
  const [fitsOnly, setFitsOnly] = useState(false);

  const load = (refresh?: boolean) => api.hub(refresh).then((d) => { setData(d); setErr(""); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  const cats = useMemo(() => {
    const n = new Map<string, number>();
    for (const m of data?.models ?? []) n.set(m.category, (n.get(m.category) ?? 0) + 1);
    return [...n].sort((a, b) => b[1] - a[1]);
  }, [data]);

  const shown = useMemo(() => {
    if (!data) return [];
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const list = data.models
      .filter((m) => cat === "All" || m.category === cat)
      .filter((m) => !fitsOnly || m.fit === "fits" || m.fit === "tight")
      .filter((m) => words.every((w) => [m.name, m.slug, m.author, m.category, ...m.tags, m.description].join(" ").toLowerCase().includes(w)));
    return sortPicks(list, sort);
  }, [data, cat, q, sort, fitsOnly]);

  if (!data) return <div className="muted">{err || "Loading the shop…"}</div>;

  return (
    <>
      <div className="row wrap" style={{ marginBottom: 10, gap: 8 }}>
        <input className="input" style={{ maxWidth: 300 }} placeholder={`search ${data.models.length} models`} value={q} onChange={(e) => setQ(e.target.value)} aria-label="search the picks" />
        <select className="select" style={{ width: "auto" }} value={sort} onChange={(e) => setSort(e.target.value as PickSort)} aria-label="sort">
          <option value="best">biggest that fits first</option>
          <option value="small">smallest first</option>
          <option value="new">newest first</option>
          <option value="name">name</option>
        </select>
        <label className="row" style={{ gap: 6, fontSize: 12.5 }}>
          <input type="checkbox" checked={fitsOnly} onChange={(e) => setFitsOnly(e.target.checked)} /> only what fits
        </label>
        <span className="grow" />
        <span className={`chip ${data.source === "live" ? "ok" : "warn"}`}>{data.source === "live" ? "live" : data.source === "cache" ? `offline · ${data.ageText}` : "offline · bundled copy"}</span>
        <button className="btn sm" onClick={() => load(true)}>refresh</button>
      </div>
      <div className="row wrap" style={{ marginBottom: 14, gap: 6 }}>
        <button className={`btn sm${cat === "All" ? " on" : ""}`} onClick={() => setCat("All")}>All · {data.models.length}</button>
        {cats.map(([c, n]) => <button key={c} className={`btn sm${cat === c ? " on" : ""}`} onClick={() => setCat(c)}>{c} · {n}</button>)}
      </div>
      {err && <div className="err" style={{ marginBottom: 10 }}>{err}</div>}

      <div className="shop-grid">
        {shown.map((m) => <PickCard key={m.slug} m={m} freeGb={data.freeGb} jobs={jobs} onRepo={onRepo} />)}
      </div>
      {shown.length === 0 && <EmptyState seed="shop-empty" title="Nothing on this shelf">Try another category, clear the search, or look through all of Hugging Face.</EmptyState>}
    </>
  );
}

function PickCard({ m, freeGb, jobs, onRepo }: { m: HubModel; freeGb: number | null; jobs: Job[]; onRepo: (repo: string) => void }) {
  const [err, setErr] = useState("");
  const running = runningFor(jobs, (j) => j.meta?.slug === m.slug);
  const have = m.installed || doneFor(jobs, (j) => j.meta?.slug === m.slug);
  const need = vramGb(m);
  const repo = m.plan.kind === "pull" && m.plan.ref ? m.plan.ref.split(":")[0] : null;

  async function install() {
    setErr("");
    try { await api.hubInstall(m.slug, m); } catch (e) { setErr((e as Error).message); }
  }

  return (
    <div className="card col" style={{ gap: 8 }}>
      <div className="row">
        <span className="mono grow truncate" style={{ fontWeight: 600 }} title={m.name}>{m.name}</span>
        {m.featured && <span className="chip warn" title="an ArcFlare favourite">★</span>}
        <span className="chip">{m.category}</span>
      </div>
      <div className="dim" style={{ fontSize: 12 }}>{m.author}</div>
      <div className="muted clamp3" style={{ fontSize: 13, lineHeight: 1.45, flex: 1 }}>{m.description}</div>
      {need && freeGb ? <Meter need={need} of={freeGb} tone={fitTone(m.fit)} label={`about ${need} GB of your ${freeGb.toFixed(0)} GB`} /> : null}
      <div className="row wrap" style={{ gap: 6 }}>
        <span className="chip">{m.defaultSize}</span>
        <span className="chip">{m.vram}</span>
        <span className={`chip ${fitChip(m.fit)}`}>{FIT_TEXT[m.fit]}</span>
        {m.commercial === false && <span className="chip bad" title={m.license}>non-commercial</span>}
        {m.commercial !== false && <span className="chip" title="licence">{m.license}</span>}
      </div>
      {running ? (
        <div className="col" style={{ gap: 4 }}>
          <Progress value={running.progress} />
          <div className="dim mono truncate" style={{ fontSize: 11 }} title={running.stage}>{running.stage}</div>
        </div>
      ) : (
        <div className="row" style={{ gap: 6 }}>
          {have
            ? <span className="chip ok">✓ downloaded</span>
            : m.plan.kind !== "none"
              ? <button className="btn primary sm" onClick={install}>{m.plan.kind === "pull" ? "download" : "set up"}</button>
              : <span className="dim mono" style={{ fontSize: 11 }}>no install command yet</span>}
          {repo && !have && <button className="btn sm" onClick={() => onRepo(repo)} title="choose a different quantisation">other sizes…</button>}
          <span className="grow" />
          <button className="btn ghost sm" onClick={() => api.openExternal(m.url)}>page</button>
        </div>
      )}
      {err && <div className="err" style={{ fontSize: 12 }}>{err}</div>}
    </div>
  );
}

// --------------------------------------------------------- hugging face ----

const SORTS: { id: ShopSort; label: string }[] = [
  { id: "trendingScore", label: "trending" },
  { id: "downloads", label: "most downloaded" },
  { id: "likes", label: "most liked" },
  { id: "lastModified", label: "recently updated" },
];
const TOPICS = ["llama", "qwen", "gemma", "mistral", "deepseek", "phi", "gpt-oss", "coder", "vision", "embedding", "tiny"];

function HuggingFace({ onRepo }: { onRepo: (repo: string) => void }) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<ShopSort>("trendingScore");
  const [res, setRes] = useState<{ freeGb: number | null; results: ShopResult[] } | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  // Search as you type (after a short pause); an older answer never overwrites a newer one.
  useEffect(() => {
    const n = ++seq.current;
    setBusy(true);
    const t = setTimeout(() => {
      api.shopSearch({ query: q, sort })
        .then((r) => { if (n === seq.current) { setRes(r); setErr(""); } })
        .catch((e) => { if (n === seq.current) setErr(e.message); })
        .finally(() => { if (n === seq.current) setBusy(false); });
    }, q ? 350 : 0);
    return () => clearTimeout(t);
  }, [q, sort]);

  return (
    <>
      <div className="row wrap" style={{ marginBottom: 10, gap: 8 }}>
        <input className="input" style={{ maxWidth: 360 }} placeholder="search Hugging Face: llama, qwen coder, 7b…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="search Hugging Face" />
        {SORTS.map((s) => <button key={s.id} className={`btn sm${sort === s.id ? " on" : ""}`} onClick={() => setSort(s.id)}>{s.label}</button>)}
        {busy && <span className="led busy" title="searching" />}
      </div>
      <div className="row wrap" style={{ marginBottom: 14, gap: 6 }}>
        <span className="dim mono" style={{ fontSize: 11 }}>try</span>
        {TOPICS.map((t) => <button key={t} className={`btn ghost sm${q === t ? " on" : ""}`} onClick={() => setQ(q === t ? "" : t)}>{t}</button>)}
      </div>
      {err && (
        <div className="panel" style={{ padding: 12, marginBottom: 12 }}>
          <div className="err">Couldn&apos;t reach Hugging Face: {err}</div>
          <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>The ArcFlare picks tab works offline.</div>
        </div>
      )}
      {res && (
        <div className="shop-grid">
          {res.results.map((r) => <ResultCard key={r.repo} r={r} onRepo={onRepo} />)}
        </div>
      )}
      {res && res.results.length === 0 && !err && <EmptyState seed="hf-empty" title="No GGUF models matched">Try fewer words, or a model family such as &quot;llama&quot; or &quot;qwen&quot;.</EmptyState>}
      {!res && !err && <div className="muted">Searching Hugging Face…</div>}
    </>
  );
}

function ResultCard({ r, onRepo }: { r: ShopResult; onRepo: (repo: string) => void }) {
  const name = r.repo.split("/")[1] ?? r.repo;
  const params = paramsFromName(name);
  const task = taskLabel(r.task);
  return (
    <div className="card click col" style={{ gap: 8 }} onClick={() => onRepo(r.repo)} role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onRepo(r.repo); } }}>
      <div className="mono truncate" style={{ fontWeight: 600 }} title={r.repo}>{name}</div>
      <div className="dim" style={{ fontSize: 12 }}>{r.author}</div>
      <div className="row wrap" style={{ gap: 6, flex: 1, alignContent: "flex-start" }}>
        {task && <span className="chip">{task}</span>}
        {params && <span className="chip">{params}</span>}
        {r.downloaded && <span className="chip ok">✓ on this machine</span>}
      </div>
      <div className="row dim mono" style={{ fontSize: 11, gap: 12 }}>
        <span title="downloads">⬇ {fmtCount(r.downloads)}</span>
        <span title="likes">♥ {fmtCount(r.likes)}</span>
        <span className="grow" />
        <span>{ago(r.updated)}</span>
      </div>
      <div className="go">choose a file →</div>
    </div>
  );
}

// ---------------------------------------------------------------- drawer ----

function Drawer({ repo, jobs, onClose }: { repo: string; jobs: Job[]; onClose: () => void }) {
  const [info, setInfo] = useState<ShopRepo | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    setInfo(null); setErr("");
    let alive = true;
    api.shopRepo(repo).then((r) => { if (alive) setInfo(r); }).catch((e) => { if (alive) setErr(e.message); });
    return () => { alive = false; };
  }, [repo]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  const rec = info ? recommendQuant(info.quants) : null;
  async function download(tag: string) {
    setErr("");
    try { await api.shopDownload(repo, tag); } catch (e) { setErr((e as Error).message); }
  }

  return (
    <div className="drawer-back" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-label={repo} onClick={(e) => e.stopPropagation()}>
        <div className="modal-h">
          <span className="grow truncate">{repo}</span>
          <button className="btn ghost sm" onClick={onClose} aria-label="close">close ✕</button>
        </div>
        <div className="drawer-b">
          {!info && !err && <div className="muted">Reading the file list…</div>}
          {err && <div className="err">{err}</div>}
          {info && (
            <>
              <div className="row wrap" style={{ gap: 6 }}>
                {taskLabel(info.task) && <span className="chip">{taskLabel(info.task)}</span>}
                {info.vision && <span className="chip">vision</span>}
                {info.license && <span className="chip" title="licence">{info.license}</span>}
                {info.downloads != null && <span className="chip">⬇ {fmtCount(info.downloads)}</span>}
                {info.likes != null && <span className="chip">♥ {fmtCount(info.likes)}</span>}
              </div>
              {info.gated && (
                <div className="panel" style={{ padding: 10, fontSize: 12.5 }}>
                  This model is gated. Accept its terms on its Hugging Face page and set <code className="md-code">HF_TOKEN</code> before downloading.
                </div>
              )}
              <p className="muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>
                Each file is one <Term k="quant">quantisation</Term> of the same model. {info.freeGb ? <>Sizes include the vision projector where there is one, and are marked against the <b>{info.freeGb.toFixed(1)} GB</b> free on your GPU.</> : "Bigger is smarter but needs more memory."}
              </p>
              {info.quants.length === 0 && <EmptyState seed="no-quants" title="No files to choose from">This repository has no GGUF files named by quantisation. Open its page to see what it holds.</EmptyState>}
              <div className="col" style={{ gap: 8 }}>
                {info.quants.map((q) => {
                  const run = runningFor(jobs, (j) => j.meta?.repo === repo && (j.meta?.tag ?? "") === q.tag);
                  const have = q.downloaded || doneFor(jobs, (j) => j.meta?.repo === repo && (j.meta?.tag ?? "") === q.tag);
                  return (
                    <div key={q.tag} className={`quant-row${q.tag === rec ? " best" : ""}`}>
                      <div className="grow" style={{ minWidth: 0 }}>
                        <div className="row" style={{ gap: 8 }}>
                          <span className="mono" style={{ fontWeight: 600 }}>{q.tag}</span>
                          <span className="mono dim" style={{ fontSize: 12 }}>{q.gb != null ? `${q.gb} GB` : "?"}{q.shards > 1 ? ` · ${q.shards} parts` : ""}</span>
                          {q.tag === rec && <span className="chip ok">suggested</span>}
                        </div>
                        {info.freeGb && q.gb ? <div style={{ marginTop: 6, maxWidth: 260 }}><Meter need={q.gb + 1} of={info.freeGb} tone={fitTone(q.fit)} /></div> : null}
                      </div>
                      <span className={`chip ${fitChip(q.fit)}`}>{FIT_TEXT[q.fit]}</span>
                      {run ? <div style={{ width: 120 }}><Progress value={run.progress} /></div>
                        : have ? <span className="chip ok">✓ downloaded</span>
                        : <button className={`btn sm${q.tag === rec ? " primary" : ""}`} onClick={() => download(q.tag)}>download</button>}
                    </div>
                  );
                })}
              </div>
            </>
          )}
          <div className="row" style={{ marginTop: 6 }}>
            <button className="btn ghost sm" onClick={() => api.openExternal(`https://huggingface.co/${repo}`)}>open on Hugging Face ↗</button>
          </div>
        </div>
      </aside>
    </div>
  );
}
