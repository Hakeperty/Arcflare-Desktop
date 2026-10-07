// Speech: text in, a .wav out. Preset voices, tone, or a cloned voice.

import { useEffect, useMemo, useState } from "react";
import { api, fileUrl, type GenModel, type StudioFile } from "../../lib/api";
import { Field, JobStatus, Panel, useJob } from "../../ui/kit";

const LANGS = ["", "en", "zh", "ja", "ko", "de", "fr", "es", "it", "pt", "ru"];

export function SpeechTab() {
  const [models, setModels] = useState<GenModel[]>([]);
  const [modelId, setModelId] = useState("");
  const [text, setText] = useState("Hello! This voice was made on my own computer, with nothing sent to the cloud.");
  const [voice, setVoice] = useState("");
  const [lang, setLang] = useState("");
  const [instruct, setInstruct] = useState("");
  const [ref, setRef] = useState("");
  const [refText, setRefText] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [setupId, setSetupId] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [recent, setRecent] = useState<StudioFile[]>([]);
  const job = useJob(jobId);
  const setupJob = useJob(setupId);

  const refresh = () => {
    api.genStatus().then((all) => {
      const tts = all.filter((m) => m.kind === "tts");
      setModels(tts);
      setModelId((cur) => cur || (tts.find((m) => m.installed) || tts[0])?.id || "");
    }).catch((e) => setErr(e.message));
    api.studioFiles("audio").then(setRecent).catch(() => {});
  };
  useEffect(refresh, []);
  useEffect(() => { if (job?.state === "done" || setupJob?.state === "done") refresh(); }, [job?.state, setupJob?.state]); // eslint-disable-line react-hooks/exhaustive-deps

  const m = useMemo(() => models.find((x) => x.id === modelId), [models, modelId]);

  async function run() {
    setErr("");
    try {
      const j = await api.tts({
        model: modelId, text, voice: voice || undefined, lang: lang || undefined,
        instruct: m?.instruct ? instruct || undefined : undefined,
        ref: m?.cloning ? ref || undefined : undefined, refText: refText || undefined,
      });
      setJobId(j.id);
    } catch (e) { setErr((e as Error).message); }
  }

  const running = job?.state === "running";
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 360px", flex: 1, minHeight: 0 }}>
      <div style={{ overflowY: "auto", padding: 18 }} className="col">
        <Field label="model">
          <select className="select" value={modelId} onChange={(e) => setModelId(e.target.value)}>
            {models.map((x) => <option key={x.id} value={x.id}>{x.label} · {x.params} · ~{x.vram} GB{x.installed ? "" : " · not installed"}</option>)}
          </select>
        </Field>
        {m && <div className="dim" style={{ fontSize: 13 }}>{m.note}</div>}
        {m && !m.installed && (
          <div className="panel" style={{ padding: 12, borderColor: "var(--accent)" }}>
            <div style={{ marginBottom: 8 }}>{m.label} isn't set up yet. Setup makes it its own Python environment and installs its packages (a few GB).</div>
            <div className="row">
              <button className="btn primary sm" onClick={async () => { const j = await api.genSetup(m.id, { torch: "cuda" }); setSetupId(j.id); }}>set up (NVIDIA)</button>
              <button className="btn sm" onClick={async () => { const j = await api.genSetup(m.id, { torch: "cpu" }); setSetupId(j.id); }}>set up (CPU / Mac)</button>
            </div>
            {setupJob && <div style={{ marginTop: 10 }}><JobStatus job={setupJob} /><div className="log" style={{ marginTop: 6 }}>{setupJob.log.slice(-8).join("\n")}</div></div>}
          </div>
        )}
        <Field label="text"><textarea className="textarea" rows={7} value={text} onChange={(e) => setText(e.target.value)} /></Field>
        <div className="grid2">
          <Field label="voice">
            <input className="input" value={voice} placeholder={m?.defaultVoice || "default"} onChange={(e) => setVoice(e.target.value)} />
          </Field>
          <Field label="language">
            <select className="select" value={lang} onChange={(e) => setLang(e.target.value)}>
              {LANGS.map((l) => <option key={l} value={l}>{l || "auto"}</option>)}
            </select>
          </Field>
        </div>
        {m?.instruct && <Field label="tone / emotion"><input className="input" value={instruct} placeholder="warm, a little excited" onChange={(e) => setInstruct(e.target.value)} /></Field>}
        {m?.cloning && (
          <div className="panel" style={{ padding: 12 }}>
            <div className="label" style={{ marginBottom: 8 }}>clone a voice · only voices you have permission to use</div>
            <div className="row">
              <input className="input" value={ref} readOnly placeholder="a few seconds of clear speech (.wav)" />
              <button className="btn sm" onClick={async () => { const p = await api.pickFile({ filters: [{ name: "Audio", extensions: ["wav", "mp3", "flac"] }] }); if (p) setRef(p); }}>browse</button>
            </div>
            <div style={{ marginTop: 8 }}><input className="input" value={refText} placeholder="what the clip says (needed by qwen3-tts-clone)" onChange={(e) => setRefText(e.target.value)} /></div>
          </div>
        )}
        <div className="row">
          <button className="btn primary" onClick={run} disabled={running || !m?.installed || !text.trim()}>{running ? "speaking…" : "speak"}</button>
          <span className="dim mono" style={{ fontSize: 12 }}>{text.length} characters</span>
        </div>
        {err && <div className="err">{err}</div>}
        {job && <JobStatus job={job} />}
        {job?.state === "done" && job.result?.file && (
          <Panel title={`${job.result.seconds ?? "?"}s of audio`}>
            <audio controls autoPlay src={fileUrl(String(job.result.file))} style={{ width: "100%" }} />
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn sm" onClick={() => api.saveAs(String(job.result!.file), { filters: [{ name: "WAV", extensions: ["wav"] }] })}>save as…</button>
              <button className="btn sm" onClick={() => api.reveal(String(job.result!.file))}>reveal</button>
            </div>
          </Panel>
        )}
      </div>
      <div style={{ borderLeft: "1px solid var(--border)", overflowY: "auto" }}>
        <div className="panel-h">recent · {recent.length}</div>
        <div className="col" style={{ padding: 10, gap: 8 }}>
          {recent.length === 0 && <span className="dim" style={{ fontSize: 12 }}>nothing yet</span>}
          {recent.slice(0, 40).map((f) => (
            <div key={f.path} className="col" style={{ gap: 4 }}>
              <span className="mono dim truncate" style={{ fontSize: 11 }}>{f.name}</span>
              <audio controls preload="none" src={fileUrl(f.path)} style={{ width: "100%", height: 32 }} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
