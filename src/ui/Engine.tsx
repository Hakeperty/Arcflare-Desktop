// Getting llama.cpp: one hook that runs the engine's installer as a job, and a
// banner for screens that can't do anything useful until it's there.

import { useEffect, useRef, useState } from "react";
import { api, type Job } from "../lib/api";
import { setup } from "../lib/setup";
import { Progress, useJob } from "./kit";

export const BUILDS: { id: string; label: string }[] = [
  { id: "", label: "automatic: the best build for this machine" },
  { id: "vulkan", label: "Vulkan: most graphics cards" },
  { id: "cuda", label: "CUDA: NVIDIA cards" },
  { id: "rocm", label: "ROCm: AMD cards with HIP drivers" },
  { id: "cpu", label: "CPU only: slow, works anywhere" },
];

/**
 * Download and install llama.cpp. `start()` is safe to call twice (the main
 * process runs one install at a time and hands back the running one), and an
 * install that was started elsewhere, by the setup wizard say, is picked up.
 */
export function useEngineInstall(onDone?: () => void) {
  const [id, setId] = useState<string | null>(null);
  const [first, setFirst] = useState<Job | null>(null);
  const [err, setErr] = useState("");
  const live = useJob(id);
  const job = live ?? first;
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    api.jobs().then((js) => {
      const j = js.find((x) => x.meta?.engine && x.state === "running");
      if (j) { setId(j.id); setFirst(j); }
    }).catch(() => {});
  }, []);
  useEffect(() => { if (job?.state === "done") done.current?.(); }, [job?.state]);

  async function start(want?: string) {
    setErr("");
    try {
      const j = await setup.installEngine(want || undefined);
      setId(j.id); setFirst(j);
    } catch (e) { setErr((e as Error).message); }
  }
  return {
    job, err, start,
    running: job?.state === "running",
    failed: job?.state === "failed" || job?.state === "cancelled",
    cancel: () => { if (job) api.cancelJob(job.id).catch(() => {}); },
  };
}

export type EngineInstall = ReturnType<typeof useEngineInstall>;

/** What the installer is doing now, with a bar; or why it stopped. */
export function EngineProgress({ install }: { install: EngineInstall }) {
  const { job } = install;
  if (!job) return null;
  const why = job.state === "failed"
    ? [...job.log].reverse().find((l) => /[a-z]/i.test(l) && !/^progress /.test(l)) || job.error
    : null;
  return (
    <div className="col" style={{ gap: 8 }}>
      {job.state === "running" && (
        <>
          <div className="row" style={{ gap: 8 }}><span className="led busy" /> <b>Installing llama.cpp</b></div>
          <Progress value={job.progress} />
          <div className="dim mono truncate" style={{ fontSize: 12 }} title={job.stage}>{job.stage}</div>
        </>
      )}
      {job.state === "failed" && <div className="err">{why}</div>}
      {job.state === "cancelled" && <div className="muted">Cancelled.</div>}
    </div>
  );
}

/** "llama.cpp isn't installed": say so, and offer the one click that fixes it. */
export function EngineBanner({ onDone }: { onDone: () => void }) {
  const install = useEngineInstall(onDone);
  const [build, setBuild] = useState("");
  const [more, setMore] = useState(false);
  return (
    <div className="panel" style={{ borderColor: "var(--accent)", background: "var(--accent-soft)", padding: 14, marginBottom: 16 }}>
      {install.running ? (
        <>
          <EngineProgress install={install} />
          <div className="row" style={{ marginTop: 10 }}><button className="btn sm" onClick={install.cancel}>cancel</button></div>
        </>
      ) : (
        <div className="col" style={{ gap: 10 }}>
          <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
            <span className="grow" style={{ minWidth: 260 }}>
              <b>llama.cpp isn&apos;t installed.</b> It&apos;s the free engine that runs language models on your GPU. One click downloads
              the build that fits this machine, and checks it before using it.
            </span>
            <button className="btn primary" onClick={() => install.start(build)}>install llama.cpp</button>
          </div>
          <EngineProgress install={install} />
          {install.err && <div className="err">{install.err}</div>}
          <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
            <button className="linkbtn" style={{ fontSize: 12 }} onClick={() => setMore(!more)}>{more ? "fewer options" : "other builds, or use my own"}</button>
          </div>
          {more && (
            <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
              <select className="select" style={{ maxWidth: 380 }} value={build} onChange={(e) => setBuild(e.target.value)}>
                {BUILDS.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
              </select>
              <span className="dim" style={{ fontSize: 12 }}>
                Already have one? Set its <code className="md-code">llama-server</code> in Settings.
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
