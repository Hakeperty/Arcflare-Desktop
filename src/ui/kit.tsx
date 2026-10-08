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

/**
 * The top of a page: [ 03 ] // label, a title, one line of what it is for,
 * and optional controls on the right. Every full page starts with one.
 */
export function ViewHead({ index, label, title, children, right }: {
  index: string; label: string; title: React.ReactNode; children?: React.ReactNode; right?: React.ReactNode;
}) {
  return (
    <header className="view-head">
      <div className="grow" style={{ minWidth: 0 }}>
        <Label index={index}>{label}</Label>
        <div className="h1">{title}</div>
        {children && <p className="view-head-p">{children}</p>}
      </div>
      {right && <div className="row" style={{ gap: 8, alignSelf: "flex-end" }}>{right}</div>}
    </header>
  );
}

/** A small, stable hash: the same text always gives the same picture. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * A dot-matrix field drawn from a seed (the website's covers, in miniature).
 * Pure SVG and cheap: used for empty states and the home banner.
 */
export function DotArt({ seed, cols = 36, rows = 10, color = "var(--accent)", className = "", style }: {
  seed: string; cols?: number; rows?: number; color?: string; className?: string; style?: React.CSSProperties;
}) {
  const h = hash(seed);
  const kind = h % 3;
  const fx = 0.18 + ((h >> 3) % 100) / 400, fy = 0.25 + ((h >> 9) % 100) / 300, ph = ((h >> 15) % 628) / 100;
  const cx = cols * (0.3 + ((h >> 5) % 40) / 100), cy = rows * 0.5;
  const cells: React.ReactNode[] = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let v = kind === 0 ? Math.sin(x * fx + ph) + Math.sin(y * fy * 1.6 + x * 0.05)
        : kind === 1 ? Math.sin(Math.hypot(x - cx, (y - cy) * 2) * fx * 1.6 + ph) * 1.6
        : Math.sin((x + y * 2.2) * fx + ph) + Math.cos(y * fy) * 0.6;
      v = (v + 2) / 4;
      if (v < 0.45) continue;
      const s = 0.3 + v * 0.5;
      cells.push(<rect key={`${x}.${y}`} x={x + (1 - s) / 2} y={y + (1 - s) / 2} width={s} height={s} fill={color} opacity={Math.min(1, (v - 0.4) * 1.7)} />);
    }
  }
  return (
    <svg viewBox={`0 0 ${cols} ${rows}`} preserveAspectRatio="xMidYMid slice" className={className} style={style} aria-hidden>
      {cells}
    </svg>
  );
}

/** An empty screen that says what goes here and offers the next step. */
export function EmptyState({ seed, title, children, action }: {
  seed: string; title: string; children?: React.ReactNode; action?: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <DotArt seed={seed} className="empty-art" />
      <div className="empty-title">{title}</div>
      {children && <div className="empty-body">{children}</div>}
      {action && <div className="row" style={{ justifyContent: "center", gap: 8, marginTop: 14 }}>{action}</div>}
    </div>
  );
}

/**
 * How much of something is used: teal with room to spare, amber when tight,
 * red when it doesn't fit. `need` against `of`, both in the same unit.
 */
export function Meter({ need, of, label }: { need: number; of: number; label?: React.ReactNode }) {
  const share = of > 0 ? need / of : 1;
  const tone = share <= 0.7 ? "ok" : share <= 1 ? "warn" : "bad";
  return (
    <div className="meter-wrap" title={typeof label === "string" ? label : undefined}>
      <div className={`meter ${tone}`}><i style={{ width: `${Math.max(3, Math.min(100, share * 100))}%` }} /></div>
      {label && <div className="meter-label">{label}</div>}
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
