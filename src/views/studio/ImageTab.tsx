// Images: stable-diffusion.cpp on this machine, or your own ComfyUI workflow.

import { useEffect, useState } from "react";
import { api, fileUrl, type ImageModels, type StudioFile } from "../../lib/api";
import { Field, JobStatus, Panel, useJob } from "../../ui/kit";
import type { Handoff } from "../Studio";

const SIZES: [number, number, string][] = [[512, 512, "512 square"], [768, 768, "768 square"], [1024, 1024, "1024 square"], [768, 512, "768×512 wide"], [512, 768, "512×768 tall"], [1024, 576, "1024×576 16:9"]];

export function ImageTab({ handoff }: { handoff: Handoff }) {
  const [backend, setBackend] = useState<"sdcpp" | "comfy">("sdcpp");
  const [models, setModels] = useState<ImageModels | null>(null);
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("a small wooden treasure chest with brass corners, centred, plain background, studio lighting");
  const [negative, setNegative] = useState("blurry, low quality, text, watermark");
  const [size, setSize] = useState(0);
  const [steps, setSteps] = useState(20);
  const [cfg, setCfg] = useState(7);
  const [seed, setSeed] = useState("");
  const [lowVram, setLowVram] = useState(false);
  const [workflow, setWorkflow] = useState("");
  const [comfy, setComfy] = useState<{ up: boolean; version?: string } | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [recent, setRecent] = useState<StudioFile[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const job = useJob(jobId);

  const refreshRecent = () => api.studioFiles("image").then((r) => { setRecent(r); if (!current && r[0]) setCurrent(r[0].path); }).catch(() => {});
  useEffect(() => {
    api.imageModels().then((m) => { setModels(m); if (m.models[0]) setModel(m.models[0].path); }).catch((e) => setErr(e.message));
    api.comfyStatus().then(setComfy).catch(() => setComfy({ up: false }));
    refreshRecent();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (job?.state === "done" && job.result?.file) { setCurrent(String(job.result.file)); refreshRecent(); }
  }, [job?.state]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run() {
    setErr("");
    const [w, h] = SIZES[size];
    try {
      const j = await api.generateImage({
        backend, model, workflow, prompt, negative, width: w, height: h, steps, cfg,
        seed: seed.trim() ? Number(seed) : undefined, lowVram,
      });
      setJobId(j.id);
    } catch (e) { setErr((e as Error).message); }
  }

  const running = job?.state === "running";
  return (
    <div style={{ display: "grid", gridTemplateColumns: "340px 1fr", flex: 1, minHeight: 0 }}>
      <div style={{ borderRight: "1px solid var(--border)", overflowY: "auto", padding: 14 }} className="col">
        <div className="row">
          <button className={`btn sm${backend === "sdcpp" ? " on" : ""}`} onClick={() => setBackend("sdcpp")}>stable-diffusion.cpp</button>
          <button className={`btn sm${backend === "comfy" ? " on" : ""}`} onClick={() => setBackend("comfy")}>
            <span className={`led ${comfy?.up ? "on" : "off"}`} /> comfyui
          </button>
        </div>
        {backend === "sdcpp" ? (
          models && !models.sd ? (
            <div className="empty" style={{ textAlign: "left" }}>
              stable-diffusion.cpp isn't installed. Get a release from <a href="https://github.com/leejet/stable-diffusion.cpp/releases" target="_blank" rel="noreferrer">github.com/leejet/stable-diffusion.cpp</a> and set its path in Settings.
            </div>
          ) : (
            <Field label="model">
              <select className="select" value={model} onChange={(e) => setModel(e.target.value)}>
                {models?.models.length === 0 && <option value="">no checkpoints found</option>}
                {models?.models.map((m) => <option key={m.path} value={m.path}>{m.name} · {m.sizeGb} GB</option>)}
              </select>
            </Field>
          )
        ) : (
          <Field label="comfyui workflow (api format .json, use {{prompt}})">
            <div className="row">
              <input className="input" value={workflow} readOnly placeholder="choose a workflow file" />
              <button className="btn sm" onClick={async () => { const p = await api.pickFile({ filters: [{ name: "Workflow", extensions: ["json"] }] }); if (p) setWorkflow(p); }}>browse</button>
            </div>
            {!comfy?.up && <span className="dim" style={{ fontSize: 12 }}>ComfyUI isn't running at the address in Settings.</span>}
          </Field>
        )}
        <Field label="prompt"><textarea className="textarea" rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} /></Field>
        <Field label="negative prompt"><textarea className="textarea" rows={2} value={negative} onChange={(e) => setNegative(e.target.value)} /></Field>
        {backend === "sdcpp" && (
          <>
            <div className="grid2">
              <Field label="size">
                <select className="select" value={size} onChange={(e) => setSize(Number(e.target.value))}>
                  {SIZES.map(([, , l], i) => <option key={l} value={i}>{l}</option>)}
                </select>
              </Field>
              <Field label="seed"><input className="input" value={seed} placeholder="random" onChange={(e) => setSeed(e.target.value.replace(/[^\d]/g, ""))} /></Field>
              <Field label={`steps · ${steps}`}><input type="range" min={4} max={60} value={steps} onChange={(e) => setSteps(Number(e.target.value))} /></Field>
              <Field label={`guidance · ${cfg}`}><input type="range" min={1} max={15} step={0.5} value={cfg} onChange={(e) => setCfg(Number(e.target.value))} /></Field>
            </div>
            <label className="row" style={{ gap: 8, fontSize: 13 }}>
              <input type="checkbox" checked={lowVram} onChange={(e) => setLowVram(e.target.checked)} /> low VRAM (weights in RAM, tiled VAE)
            </label>
          </>
        )}
        <button className="btn primary" onClick={run} disabled={running || !prompt.trim() || (backend === "sdcpp" ? !model : !workflow)}>
          {running ? "generating…" : "generate"}
        </button>
        {err && <div className="err">{err}</div>}
        {job && <JobStatus job={job} />}
      </div>

      <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div className="gridbg" style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", minHeight: 0, padding: 20 }}>
          {current
            ? <img src={fileUrl(current)} style={{ maxWidth: "100%", maxHeight: "100%", border: "1px solid var(--border)", imageRendering: "auto" }} />
            : <div className="empty">Your images appear here.</div>}
        </div>
        {current && (
          <div className="row" style={{ padding: "8px 14px", borderTop: "1px solid var(--border)" }}>
            <span className="mono dim truncate grow" style={{ fontSize: 12 }}>{current.split(/[\\/]/).pop()}</span>
            <button className="btn primary sm" onClick={() => handoff.imageTo3D(current)}>make 3D</button>
            <button className="btn sm" onClick={() => api.saveAs(current, { filters: [{ name: "PNG", extensions: ["png"] }] })}>save as…</button>
            <button className="btn sm" onClick={() => api.reveal(current)}>reveal</button>
          </div>
        )}
        <Panel title={`recent · ${recent.length}`} bodyClass="" className="">
          <div className="row" style={{ overflowX: "auto", padding: 8, gap: 8 }}>
            {recent.slice(0, 30).map((f) => (
              <img key={f.path} src={fileUrl(f.path)} title={f.name} onClick={() => setCurrent(f.path)}
                style={{ height: 72, width: 72, objectFit: "cover", cursor: "pointer", border: `1px solid ${f.path === current ? "var(--accent)" : "var(--border)"}` }} />
            ))}
            {recent.length === 0 && <span className="dim" style={{ fontSize: 12 }}>nothing yet</span>}
          </div>
        </Panel>
      </div>
    </div>
  );
}
