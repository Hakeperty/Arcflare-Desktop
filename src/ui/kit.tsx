// Small shared pieces. Plain components over the classes in styles.css.

import { useEffect, useState } from "react";
import { on, type Job } from "../lib/api";

export function Label({ index, children }: { index?: string; children: React.ReactNode }) {
  return (
    <div className="label">
      {index && <span className="a">[ {index} ] </span>}
      {index && "// "}
      {children}
    </div>
  );
}

export function Spec({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="spec">
      <dt>{k}</dt>
      <span className="lead" />
      <dd>{v}</dd>
    </div>
  );
}

export function Progress({ value }: { value: number | null | undefined }) {
  const indet = value == null;
  return (
    <div className={`progress${indet ? " indet" : ""}`}>
      <i style={{ width: indet ? undefined : `${Math.max(2, Math.min(100, value))}%` }} />
    </div>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function Panel({ title, right, children, className = "", bodyClass = "panel-b" }: {
  title?: React.ReactNode; right?: React.ReactNode; children: React.ReactNode; className?: string; bodyClass?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      {title && (
        <div className="panel-h">
          <span className="grow truncate">{title}</span>
          {right}
        </div>
      )}
      <div className={bodyClass}>{children}</div>
    </section>
  );
}

/** Live view of the job list. Every component that cares subscribes here. */
export function useJobs(): Job[] {
  const [jobs, setJobs] = useState<Map<string, Job>>(new Map());
  useEffect(() => on("job:update", (j: Job) => setJobs((m) => new Map(m).set(j.id, j))), []);
  return [...jobs.values()].sort((a, b) => b.started - a.started);
}

/** The latest state of one job, by id. */
export function useJob(id: string | null): Job | null {
  const [job, setJob] = useState<Job | null>(null);
  useEffect(() => {
    if (!id) { setJob(null); return; }
    return on("job:update", (j: Job) => { if (j.id === id) setJob(j); });
  }, [id]);
  return job;
}

export function JobStatus({ job }: { job: Job | null }) {
  if (!job) return null;
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row mono" style={{ fontSize: 12 }}>
        <span className={`led ${job.state === "running" ? "busy" : job.state === "done" ? "on" : job.state === "failed" ? "err" : "off"}`} />
        <span className="grow truncate">{job.title}</span>
        <span className="dim">{job.state === "running" ? job.stage : job.state}</span>
        <span className="dim">{fmtSecs(((job.state === "running" ? Date.now() : (job as any).ended || Date.now()) - job.started) / 1000)}</span>
      </div>
      {job.state === "running" && <Progress value={job.progress} />}
      {job.state === "failed" && (
        <>
          <div className="err">{job.error}</div>
          {job.stderr && job.stderr.length > 0 && <div className="log">{job.stderr.join("\n")}</div>}
        </>
      )}
    </div>
  );
}

export function fmtSecs(s: number) {
  if (s < 60) return `${Math.round(s)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export function fmtCtx(n: number | null | undefined) {
  if (!n) return "—";
  return n >= 1024 ? `${Math.round(n / 1024)}K` : String(n);
}
