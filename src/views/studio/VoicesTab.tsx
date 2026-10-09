// The voice lab: record or import a voice, save it under a name, then hear it
// on every cloning model. Saved voices live in the engine (~/.arcflare/voices),
// so `arcflare gen tts --clone <name>` and the speech tab use the same ones.

import { useEffect, useMemo, useRef, useState } from "react";
import { api, fileUrl, on, vramText, type GenModel, type Job, type SavedVoice } from "../../lib/api";
import { clipAdvice, decodeToMono, encodeWav, normalize, trimSilence, TAKE_RATE } from "../../lib/wav";
import { EmptyState, Field, JobStatus, Panel, useJob } from "../../ui/kit";

const MAX_SECONDS = 30;
const LANGS = ["", "en", "zh", "ja", "ko", "de", "fr", "es", "it", "pt", "ru", "hi", "ar"];

// Something to read aloud while recording. Varied sounds clone better than
// one repeated phrase, and reading a known text means the transcript is
// already written (qwen3-tts-clone needs it).
const SCRIPTS = [
  "The quick brown fox jumps over the lazy dog. I'm recording a short sample of my own voice, speaking clearly and at my usual pace, so it can be copied faithfully.",
  "On a bright spring morning, Jamie walked to the harbour, bought fresh bread and watched the fishing boats return. It was quiet, calm, and a little bit cold.",
  "Please call Stella. Ask her to bring these things with her from the store: six spoons of fresh snow peas, five thick slabs of blue cheese, and maybe a snack for her brother Bob.",
];

/** Resolves when a job stops running. Checks the list too, in case it already has. */
function waitJob(id: string): Promise<Job> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (j: Job) => { if (!done && j.id === id && j.state !== "running") { done = true; off(); resolve(j); } };
    const off = on("job:update", finish);
    api.jobs().then((all) => { const j = all.find((x) => x.id === id); if (j) finish(j); }).catch(() => {});
  });
}

type Take = { path: string; seconds: number | null };

export function VoicesTab({ onUse }: { onUse?: (voiceId: string) => void }) {
  const [voices, setVoices] = useState<SavedVoice[]>([]);
  const [models, setModels] = useState<GenModel[]>([]);
  const [sel, setSel] = useState<string | "new">("new");
  const [err, setErr] = useState("");

  const refresh = (pick?: string) => {
    api.voices().then((v) => {
      setVoices(v);
      if (pick) setSel(pick);
      else setSel((cur) => (cur !== "new" && !v.some((x) => x.id === cur) ? (v[0]?.id ?? "new") : cur));
    }).catch((e) => setErr(e.message));
    api.genStatus().then((all) => setModels(all.filter((m) => m.kind === "tts" && m.cloning))).catch(() => {});
  };
  useEffect(() => refresh(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const voice = voices.find((v) => v.id === sel) || null;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", flex: 1, minHeight: 0 }}>
      <div style={{ borderRight: "1px solid var(--border)", overflowY: "auto" }}>
        <div className="panel-h"><span className="grow">voices · {voices.length}</span></div>
        <div className="col" style={{ padding: 10, gap: 6 }}>
          <button className={`btn sm${sel === "new" ? " primary" : ""}`} onClick={() => setSel("new")}>+ new voice</button>
          {voices.map((v) => (
            <button key={v.id} className={`voice-item${sel === v.id ? " on" : ""}`} onClick={() => setSel(v.id)}>
              <div className="truncate">{v.name}</div>
              <div className="dim mono" style={{ fontSize: 11 }}>
                {v.id} · {v.seconds != null ? `${v.seconds}s` : "clip"}{v.lang ? ` · ${v.lang}` : ""}{v.text ? "" : " · no transcript"}
              </div>
            </button>
          ))}
        </div>
      </div>
      <div style={{ overflowY: "auto", padding: 18 }} className="col">
        {err && <div className="err">{err}</div>}
        {sel === "new"
          ? <NewVoice existing={voices} onSaved={(v) => refresh(v.id)} />
          : voice
            ? <VoiceDetail key={voice.id} voice={voice} models={models} onChanged={() => refresh()} onUse={onUse} />
            : <EmptyState seed="voices" title="no voice selected" />}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- new ----

function NewVoice({ existing, onSaved }: { existing: SavedVoice[]; onSaved: (v: SavedVoice) => void }) {
  const [take, setTake] = useState<Take | null>(null);
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [lang, setLang] = useState("en");
  const [script, setScript] = useState(0);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const clash = !!id && existing.some((v) => v.id === id);
  const advice = clipAdvice(take?.seconds);

  async function save() {
    if (!take) return;
    setBusy(true); setErr("");
    try {
      const v = await api.saveVoice({ name, clip: take.path, text, lang: lang || null, replace: clash });
      setTake(null); setName(""); setText(""); setConsent(false);
      onSaved(v);
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  }

  return (
    <>
      <div className="h2">New voice</div>
      <div className="dim" style={{ fontSize: 13 }}>
        Record or import 5-30 seconds of one person speaking clearly, with no music or other voices.
        Everything stays on this computer.
      </div>

      <Panel title="1 · read this aloud" right={<button className="btn sm" onClick={() => setScript((script + 1) % SCRIPTS.length)}>another</button>}>
        <div style={{ fontSize: 16, lineHeight: 1.6 }}>{SCRIPTS[script]}</div>
      </Panel>

      <Recorder onTake={(t) => { setTake(t); if (!text) setText(SCRIPTS[script]); }} />

      <div className="row dim" style={{ fontSize: 12 }}>
        <span>or</span>
        <button className="btn sm" onClick={async () => {
          const p = await api.pickFile({ filters: [{ name: "Audio", extensions: ["wav", "mp3", "flac", "ogg", "m4a"] }], title: "A clip of the voice" });
          if (p) { setTake({ path: p, seconds: null }); setText(""); }
        }}>import a clip…</button>
      </div>

      {take && (
        <Panel title="2 · check the take">
          <audio controls src={fileUrl(take.path)} style={{ width: "100%" }}
            onLoadedMetadata={(e) => { const d = (e.target as HTMLAudioElement).duration; if (isFinite(d)) setTake((t) => t && { ...t, seconds: Math.round(d * 100) / 100 }); }} />
          <div className="row mono dim" style={{ fontSize: 12, marginTop: 6 }}>
            <span>{take.seconds != null ? `${take.seconds}s` : "…"}</span>
            {advice ? <span style={{ color: "var(--accent)" }}>{advice}</span> : take.seconds != null && <span>good length</span>}
          </div>
        </Panel>
      )}

      {take && (
        <Panel title="3 · save it">
          <div className="col">
            <div className="grid2">
              <Field label="name">
                <input className="input" value={name} placeholder="narrator, me, grandpa…" onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field label="language">
                <select className="select" value={lang} onChange={(e) => setLang(e.target.value)}>
                  {LANGS.map((l) => <option key={l} value={l}>{l || "unknown"}</option>)}
                </select>
              </Field>
            </div>
            {clash && <div className="dim" style={{ fontSize: 12 }}>a voice called "{id}" exists — saving replaces it</div>}
            <Field label="what the clip says">
              <textarea className="textarea" rows={3} value={text} placeholder="the exact words — qwen3-tts-clone needs them; other models don't"
                onChange={(e) => setText(e.target.value)} />
            </Field>
            <label className="row" style={{ fontSize: 13, gap: 8, alignItems: "flex-start" }}>
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} style={{ marginTop: 3 }} />
              <span>This is my own voice, or the speaker has given me permission to clone it.</span>
            </label>
            <div className="row">
              <button className="btn primary" disabled={busy || !id || !consent} onClick={save}>{busy ? "saving…" : "save voice"}</button>
              {id && <span className="dim mono" style={{ fontSize: 12 }}>arcflare gen tts "…" --clone {id}</span>}
            </div>
            {err && <div className="err">{err}</div>}
          </div>
        </Panel>
      )}
    </>
  );
}

/** Microphone → a trimmed 24 kHz WAV take on disk. */
function Recorder({ onTake }: { onTake: (t: Take) => void }) {
  const [state, setState] = useState<"idle" | "recording" | "processing">("idle");
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [err, setErr] = useState("");
  const rec = useRef<{ mr: MediaRecorder; stream: MediaStream; ctx: AudioContext; raf: number; t0: number; timer: number } | null>(null);

  useEffect(() => () => stopAll(), []); // eslint-disable-line react-hooks/exhaustive-deps

  function stopAll() {
    const r = rec.current;
    if (!r) return;
    cancelAnimationFrame(r.raf);
    clearInterval(r.timer);
    r.stream.getTracks().forEach((t) => t.stop());
    r.ctx.close().catch(() => {});
    rec.current = null;
  }

  async function start() {
    setErr("");
    try {
      if (!(await api.micAccess())) throw new Error("microphone access was refused — allow it in the system settings");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true },
      });
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      const chunks: Blob[] = [];
      const mr = new MediaRecorder(stream);
      mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      mr.onstop = async () => {
        stopAll();
        setState("processing");
        try {
          const raw = await decodeToMono(new Blob(chunks, { type: mr.mimeType }));
          const clip = normalize(trimSilence(raw));
          if (clip.length < TAKE_RATE * 0.5) throw new Error("that take is silent — check the microphone and try again");
          const path = await api.writeTake(encodeWav(clip));
          onTake({ path, seconds: Math.round((clip.length / TAKE_RATE) * 100) / 100 });
        } catch (e) { setErr((e as Error).message); }
        setState("idle");
        setLevel(0);
      };
      const t0 = Date.now();
      const tick = () => {
        analyser.getFloatTimeDomainData(buf);
        let peak = 0;
        for (const v of buf) peak = Math.max(peak, Math.abs(v));
        setLevel(peak);
        if (rec.current) rec.current.raf = requestAnimationFrame(tick);
      };
      const timer = window.setInterval(() => {
        const s = (Date.now() - t0) / 1000;
        setElapsed(s);
        if (s >= MAX_SECONDS && mr.state === "recording") mr.stop();
      }, 100);
      rec.current = { mr, stream, ctx, raf: requestAnimationFrame(tick), t0, timer };
      mr.start(250);
      setElapsed(0);
      setState("recording");
    } catch (e) {
      stopAll();
      setErr((e as Error).message);
    }
  }

  function stop() {
    if (rec.current && rec.current.mr.state === "recording") rec.current.mr.stop();
  }

  const loudTone = level > 0.95 ? "var(--danger)" : level > 0.08 ? "var(--accent-2)" : "var(--muted-2)";
  return (
    <Panel title="record">
      <div className="row" style={{ gap: 12 }}>
        {state === "recording"
          ? <button className="btn primary" onClick={stop}>■ stop</button>
          : <button className="btn primary" onClick={start} disabled={state === "processing"}>{state === "processing" ? "processing…" : "● record"}</button>}
        <span className="mono" style={{ fontSize: 13, minWidth: 70 }}>{elapsed.toFixed(1)}s / {MAX_SECONDS}s</span>
        <div className="grow" style={{ height: 8, background: "var(--border)", borderRadius: 4, overflow: "hidden" }}>
          <i style={{ display: "block", height: "100%", width: `${Math.min(100, level * 100)}%`, background: loudTone, transition: "width 60ms linear" }} />
        </div>
      </div>
      <div className="dim" style={{ fontSize: 12, marginTop: 8 }}>
        {state === "recording"
          ? level > 0.95 ? "too loud — move back from the microphone" : "speaking… stop when you've read the passage"
          : "a quiet room, the microphone a hand's width away. Silence at the start and end is trimmed."}
      </div>
      {err && <div className="err" style={{ marginTop: 8 }}>{err}</div>}
    </Panel>
  );
}

// ---------------------------------------------------------------- detail ----

const TRY_LINE = "Hi! This is a cloned voice, made on this computer. How does it sound?";

function VoiceDetail({ voice, models, onChanged, onUse }: {
  voice: SavedVoice; models: GenModel[]; onChanged: () => void; onUse?: (voiceId: string) => void;
}) {
  const [text, setText] = useState(voice.text);
  const [lang, setLang] = useState(voice.lang || "");
  const [line, setLine] = useState(TRY_LINE);
  const usable = useMemo(() => models.filter((m) => !m.needsRefText || voice.text), [models, voice.text]);
  const [modelId, setModelId] = useState("");
  const [emotion, setEmotion] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [compare, setCompare] = useState<{ model: GenModel; job: Job | null }[] | null>(null);
  const [comparing, setComparing] = useState(false);
  const [err, setErr] = useState("");
  const job = useJob(jobId);

  useEffect(() => {
    setModelId((cur) => cur && usable.some((m) => m.id === cur) ? cur
      : (usable.find((m) => m.id === "kitten-tts-2" && m.installed) || usable.find((m) => m.installed) || usable[0])?.id || "");
  }, [usable]);
  const m = usable.find((x) => x.id === modelId);
  const dirty = text !== voice.text || (lang || null) !== (voice.lang || null);

  async function speak() {
    setErr("");
    try {
      const j = await api.tts({ model: modelId, text: line, clone: voice.id, instruct: m?.emotions && emotion ? emotion : undefined });
      setJobId(j.id);
    } catch (e) { setErr((e as Error).message); }
  }

  async function runCompare() {
    const ready = usable.filter((x) => x.installed);
    if (!ready.length) { setErr("no cloning model is set up yet"); return; }
    setErr("");
    setComparing(true);
    const rows = ready.map((model) => ({ model, job: null as Job | null }));
    setCompare([...rows]);
    // One at a time: each model loads into the same GPU.
    for (const row of rows) {
      try {
        const j = await api.tts({ model: row.model.id, text: line, clone: voice.id });
        row.job = j;
        setCompare([...rows]);
        row.job = await waitJob(j.id);
      } catch (e) {
        row.job = { id: "", kind: "tts", title: row.model.label, state: "failed", stage: "", progress: null, log: [], result: null, error: (e as Error).message, started: Date.now() };
      }
      setCompare([...rows]);
    }
    setComparing(false);
  }

  return (
    <>
      <div className="row">
        <div className="h2 grow">{voice.name}</div>
        {onUse && <button className="btn sm" onClick={() => onUse(voice.id)}>use in speech</button>}
        <button className="btn sm" onClick={async () => {
          if (!window.confirm(`Delete the voice "${voice.name}"? Its clip is removed from ~/.arcflare/voices.`)) return;
          try { await api.removeVoice(voice.id); onChanged(); } catch (e) { setErr((e as Error).message); }
        }}>delete</button>
      </div>
      <div className="dim mono" style={{ fontSize: 12 }}>
        {voice.id} · {voice.seconds != null ? `${voice.seconds}s` : "clip"} · saved {new Date(voice.created).toLocaleDateString()} · arcflare gen tts "…" --clone {voice.id}
      </div>

      <Panel title="reference clip">
        <audio controls src={fileUrl(voice.clip)} style={{ width: "100%" }} />
        {voice.advice && <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>{voice.advice}</div>}
        <div className="col" style={{ marginTop: 10 }}>
          <Field label="what the clip says">
            <textarea className="textarea" rows={3} value={text} placeholder="needed by qwen3-tts-clone" onChange={(e) => setText(e.target.value)} />
          </Field>
          <div className="row">
            <select className="select" value={lang} onChange={(e) => setLang(e.target.value)} style={{ maxWidth: 140 }}>
              {LANGS.map((l) => <option key={l} value={l}>{l || "unknown"}</option>)}
            </select>
            <button className="btn sm" disabled={!dirty} onClick={async () => {
              try { await api.updateVoice(voice.id, { text, lang: lang || null }); onChanged(); } catch (e) { setErr((e as Error).message); }
            }}>save changes</button>
          </div>
        </div>
      </Panel>

      <Panel title="try it">
        <div className="col">
          <Field label="say">
            <textarea className="textarea" rows={3} value={line} onChange={(e) => setLine(e.target.value)} />
          </Field>
          <div className="grid2">
            <Field label="model">
              <select className="select" value={modelId} onChange={(e) => setModelId(e.target.value)}>
                {usable.map((x) => <option key={x.id} value={x.id}>{x.label} · {vramText(x)}{x.installed ? "" : " · not installed"}</option>)}
              </select>
            </Field>
            {m?.emotions ? (
              <Field label="emotion">
                <select className="select" value={emotion} onChange={(e) => setEmotion(e.target.value)}>
                  <option value="">neutral</option>
                  {m.emotions.map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
              </Field>
            ) : <div />}
          </div>
          {m && <div className="dim" style={{ fontSize: 12 }}>{m.note}{m.license ? ` · licence: ${m.license}` : ""}</div>}
          {models.length > usable.length && <div className="dim" style={{ fontSize: 12 }}>add a transcript to try qwen3-tts-clone too</div>}
          {m && !m.installed && <div className="dim" style={{ fontSize: 12 }}>{m.label} isn't set up — set it up from the speech tab or Models.</div>}
          <div className="row">
            <button className="btn primary" disabled={!m?.installed || !line.trim() || job?.state === "running"} onClick={speak}>
              {job?.state === "running" ? "speaking…" : "speak"}
            </button>
            <button className="btn" disabled={comparing || !line.trim()} onClick={runCompare}>{comparing ? "comparing…" : "compare all models"}</button>
          </div>
          {err && <div className="err">{err}</div>}
          {job && <JobStatus job={job} />}
          {job?.state === "done" && job.result?.file && <Result job={job} />}
        </div>
      </Panel>

      {compare && (
        <Panel title="side by side" right={<span className="dim mono" style={{ fontSize: 11 }}>same line, every installed cloning model</span>}>
          <div className="col" style={{ gap: 12 }}>
            {compare.map(({ model, job: j }) => (
              <div key={model.id} className="col" style={{ gap: 4 }}>
                <div className="row mono" style={{ fontSize: 12 }}>
                  <span className="grow">{model.label}</span>
                  <span className="dim">{!j ? "waiting" : j.state === "running" ? j.stage : j.state}</span>
                </div>
                {j?.state === "done" && j.result?.file && <Result job={j} />}
                {j?.state === "failed" && <div className="err">{j.error}</div>}
              </div>
            ))}
          </div>
        </Panel>
      )}
    </>
  );
}

function Result({ job }: { job: Job }) {
  const file = String(job.result!.file);
  return (
    <div className="col" style={{ gap: 4 }}>
      <audio controls src={fileUrl(file)} style={{ width: "100%" }} />
      <div className="row">
        <span className="dim mono grow" style={{ fontSize: 11 }}>{job.result?.seconds ?? "?"}s of audio{job.result?.ms ? ` · made in ${Math.round(Number(job.result.ms) / 100) / 10}s` : ""}</span>
        <button className="btn sm" onClick={() => api.saveAs(file, { filters: [{ name: "WAV", extensions: ["wav"] }] })}>save as…</button>
        <button className="btn sm" onClick={() => api.reveal(file)}>reveal</button>
      </div>
    </div>
  );
}
