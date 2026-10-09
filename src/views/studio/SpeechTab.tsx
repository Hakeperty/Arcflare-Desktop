// Speech: text in, a .wav out. Preset voices, tone, or a cloned voice — a
// clip picked here, or one saved in the voice lab.

import { useEffect, useMemo, useState } from "react";
import { api, fileUrl, vramText, type GenModel, type SavedVoice, type StudioFile } from "../../lib/api";
import { Field, JobStatus, Panel, useJob } from "../../ui/kit";

const LANGS = ["", "en", "zh", "ja", "ko", "de", "fr", "es", "it", "pt", "ru", "hi", "ar"];

export function SpeechTab({ useVoice }: { useVoice?: { id: string; at: number } | null }) {
  const [models, setModels] = useState<GenModel[]>([]);
  const [modelId, setModelId] = useState("");
  const [text, setText] = useState("Hello! This voice was made on my own computer, with nothing sent to the cloud.");
  const [voice, setVoice] = useState("");
  const [lang, setLang] = useState("");
  const [instruct, setInstruct] = useState("");
  const [ref, setRef] = useState("");
  const [refText, setRefText] = useState("");
  const [saved, setSaved] = useState<SavedVoice[]>([]);
  const [clone, setClone] = useState("");
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
    api.voices().then(setSaved).catch(() => {});
  };
  useEffect(refresh, []);
  // "use in speech" from the voice lab: that voice, on a model that can clone it.
  useEffect(() => {
    if (!useVoice) return;
    api.voices().then(setSaved).catch(() => {});
    setClone(useVoice.id);
    setModelId((cur) => {
      const c = models.find((x) => x.id === cur);
      if (c?.cloning) return cur;
      return (models.find((x) => x.id === "kitten-tts-2" && x.installed) || models.find((x) => x.cloning && x.installed) ||
        models.find((x) => x.cloning))?.id || cur;
    });
  }, [useVoice?.at]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (job?.state === "done" || setupJob?.state === "done") refresh(); }, [job?.state, setupJob?.state]); // eslint-disable-line react-hooks/exhaustive-deps

  const m = useMemo(() => models.find((x) => x.id === modelId), [models, modelId]);

  async function run() {
    setErr("");
    try {
      const j = await api.tts({
        model: modelId, text, voice: voice || undefined, lang: lang || undefined,
        instruct: m?.instruct || m?.emotions ? instruct || undefined : undefined,
        clone: m?.cloning && clone ? clone : undefined,
        ref: m?.cloning && !clone ? ref || undefined : undefined, refText: !clone ? refText || undefined : undefined,
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
            {models.map((x) => <option key={x.id} value={x.id}>{x.label} · {x.params} · {vramText(x)}{x.installed ? "" : " · not installed"}</option>)}
          </select>
        </Field>
        {m && <div className="dim" style={{ fontSize: 13 }}>{m.note}</div>}
        {m && !m.installed && (
          <div className="panel" style={{ padding: 12, borderColor: "var(--accent)" }}>
            <div style={{ marginBottom: 8 }}>{m.label} isn't set up yet. Setup makes it its own Python environment and installs its packages ({m.noTorch ? "small: no torch, CPU only" : "a few GB"}).</div>
            <div className="row">
              {m.noTorch
                ? <button className="btn primary sm" onClick={async () => { const j = await api.genSetup(m.id); setSetupId(j.id); }}>set up</button>
                : <>
                  <button className="btn primary sm" onClick={async () => { const j = await api.genSetup(m.id, { torch: "cuda" }); setSetupId(j.id); }}>set up (NVIDIA)</button>
                  <button className="btn sm" onClick={async () => { const j = await api.genSetup(m.id, { torch: "cpu" }); setSetupId(j.id); }}>set up (CPU / Mac)</button>
                </>}
            </div>
            {setupJob && <div style={{ marginTop: 10 }}><JobStatus job={setupJob} /><div className="log" style={{ marginTop: 6 }}>{setupJob.log.slice(-8).join("\n")}</div></div>}
          </div>
        )}
        <Field label="text"><textarea className="textarea" rows={7} value={text} onChange={(e) => setText(e.target.value)} /></Field>
        <div className="grid2">
          <Field label="voice">
            <input className="input" value={voice} placeholder={m?.defaultVoice || "default"} list="voice-hints" onChange={(e) => setVoice(e.target.value)} />
            <datalist id="voice-hints">{(m?.voices || m?.voiceHints || []).map((v) => <option key={v} value={v} />)}</datalist>
          </Field>
          <Field label="language">
            <select className="select" value={lang} onChange={(e) => setLang(e.target.value)}>
              {LANGS.map((l) => <option key={l} value={l}>{l || "auto"}</option>)}
            </select>
          </Field>
        </div>
        {m?.instruct && <Field label="tone / emotion"><input className="input" value={instruct} placeholder="warm, a little excited" onChange={(e) => setInstruct(e.target.value)} /></Field>}
        {m?.emotions && (
          <Field label="emotion">
            <select className="select" value={m.emotions.includes(instruct) ? instruct : ""} onChange={(e) => setInstruct(e.target.value)}>
              <option value="">neutral</option>
              {m.emotions.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </Field>
        )}
        {m?.cloning && (
          <div className="panel" style={{ padding: 12 }}>
            <div className="label" style={{ marginBottom: 8 }}>clone a voice · only voices you have permission to use</div>
            <div className="row" style={{ marginBottom: 8 }}>
              <select className="select" value={clone} onChange={(e) => setClone(e.target.value)}>
                <option value="">{saved.length ? "a clip, picked below" : "no saved voices — make one in the voice lab"}</option>
                {saved.map((v) => <option key={v.id} value={v.id}>{v.name}{v.seconds != null ? ` · ${v.seconds}s` : ""}</option>)}
              </select>
            </div>
            {!clone && <><div className="row">
              <input className="input" value={ref} readOnly placeholder="a few seconds of clear speech (.wav)" />
              <button className="btn sm" onClick={async () => { const p = await api.pickFile({ filters: [{ name: "Audio", extensions: ["wav", "mp3", "flac"] }] }); if (p) setRef(p); }}>browse</button>
            </div>
            <div style={{ marginTop: 8 }}><input className="input" value={refText} placeholder="what the clip says (needed by qwen3-tts-clone)" onChange={(e) => setRefText(e.target.value)} /></div></>}
            {clone && <div className="dim" style={{ fontSize: 12 }}>uses the saved clip and its transcript</div>}
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
