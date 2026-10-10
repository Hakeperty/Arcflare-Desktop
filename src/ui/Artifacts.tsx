// The artifact panel beside the chat: a live, sandboxed preview of what a
// reply made, its code, every version, and design tools — phone/tablet/desktop
// widths, light/dark, and "point and ask": click an element in the preview and
// say what to change.

import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { PREVIEWABLE, buildDocument, fileName, type Artifact, type ArtifactThread } from "../lib/artifacts";
import { Markdown } from "./md";

export type PanelOpen = { id: string; v: number | null }; // v: 1-based version, null = latest

type Picked = { selector: string; tag: string; text: string; html: string };
type Viewport = "fill" | "desktop" | "tablet" | "phone";
const WIDTHS: Record<Viewport, number | null> = { fill: null, desktop: 1280, tablet: 820, phone: 390 };
type Theme = "auto" | "light" | "dark";

const PREFS = "arcflare.artifacts.prefs";
function loadPrefs(): { viewport: Viewport; theme: Theme } {
  try { const v = JSON.parse(localStorage.getItem(PREFS) || "{}"); return { viewport: v.viewport || "fill", theme: v.theme || "auto" }; } catch { return { viewport: "fill", theme: "auto" }; }
}

const KIND_LABEL: Record<Artifact["kind"], string> = { html: "page", svg: "svg", react: "react", markdown: "document", code: "code" };

/** The card a reply shows where an artifact was written. */
export function ArtifactCard({ a, version, active, onOpen }: { a: Artifact; version: number; active: boolean; onOpen: () => void }) {
  const lines = a.content ? a.content.split("\n").length : 0;
  return (
    <button className={`art-card${active ? " on" : ""}`} onClick={onOpen} title="Open in the panel">
      <span className="art-card-ico">{a.kind === "code" ? "{ }" : a.kind === "markdown" ? "¶" : a.kind === "svg" ? "◇" : "▣"}</span>
      <span className="col grow" style={{ gap: 0, alignItems: "flex-start" }}>
        <span className="truncate" style={{ maxWidth: "100%", fontWeight: 600 }}>{a.title}</span>
        <span className="dim mono" style={{ fontSize: 11 }}>
          {KIND_LABEL[a.kind]}{a.kind === "code" && a.lang ? ` · ${a.lang}` : ""} · v{version}
          {a.closed ? ` · ${lines} line${lines === 1 ? "" : "s"}` : <> · writing… {lines} lines <span className="led busy" /></>}
        </span>
      </span>
      <span className="dim mono" style={{ fontSize: 11 }}>open →</span>
    </button>
  );
}

export function ArtifactPanel({ threads, open, setOpen, onClose, onAsk, busy, style }: {
  threads: ArtifactThread[];
  open: PanelOpen;
  setOpen: (o: PanelOpen) => void;
  onClose: () => void;
  /** Send a message to the model (a change to a picked element, a fix for an error). */
  onAsk: ((text: string) => void) | null;
  /** True while the model can't take a request (answering, or none loaded). */
  busy: boolean;
  style?: React.CSSProperties;
}) {
  const thread = threads.find((t) => t.id === open.id) || threads[0];
  const vIdx = thread ? (open.v == null ? thread.versions.length - 1 : Math.min(Math.max(open.v - 1, 0), thread.versions.length - 1)) : 0;
  const a = thread?.versions[vIdx];
  const previewable = !!a && (PREVIEWABLE.has(a.kind) || a.kind === "markdown");
  const [tab, setTab] = useState<"preview" | "code">("preview");
  const [prefs, setPrefs] = useState(loadPrefs);
  const [net, setNet] = useState(false);
  const [pick, setPick] = useState(false);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [ask, setAsk] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [reload, setReload] = useState(0);
  const [url, setUrl] = useState<string | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => { try { localStorage.setItem(PREFS, JSON.stringify(prefs)); } catch { /* blocked */ } }, [prefs]);

  // Still streaming: there's nothing to run yet, so show the code as it arrives.
  const showing = !a ? "code" : !a.closed || !previewable ? "code" : tab;
  const doc = useMemo(() => (a && a.closed && PREVIEWABLE.has(a.kind) ? buildDocument(a) : null), [a?.kind, a?.content, a?.closed, a?.title]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setError(null); setPicked(null); setPick(false); setUrl(null);
    if (!doc || showing !== "preview") return;
    let alive = true;
    api.artifactView(doc, { net }).then((u) => { if (alive) setUrl(u); }).catch((e) => { if (alive) setError((e as Error).message); });
    return () => { alive = false; };
  }, [doc, net, reload, showing]);

  const post = (m: Record<string, unknown>) => frame.current?.contentWindow?.postMessage({ arc: 1, ...m }, "*");

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const d = e.data as { arc?: number; type?: string } & Partial<Picked> & { message?: string };
      if (!d || d.arc !== 1) return;
      if (d.type === "ready") { post({ type: "theme", theme: prefs.theme }); post({ type: "pick", on: pick }); }
      if (d.type === "error") setError(String(d.message || "error"));
      if (d.type === "picked") { setPicked({ selector: d.selector || "", tag: d.tag || "", text: d.text || "", html: d.html || "" }); setPick(false); }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [prefs.theme, pick]);

  useEffect(() => { post({ type: "theme", theme: prefs.theme }); }, [prefs.theme]);
  useEffect(() => { post({ type: "pick", on: pick }); }, [pick]);

  if (!thread || !a) {
    return (
      <aside className="art-panel" style={style}>
        <div className="art-head"><span className="grow dim mono">no artifacts</span><button className="btn ghost sm" onClick={onClose}>×</button></div>
      </aside>
    );
  }

  function copy() {
    navigator.clipboard.writeText(a!.content).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }).catch(() => {});
  }
  function save() {
    const name = fileName(a!);
    const ext = name.split(".").pop() || "txt";
    api.saveText(name, a!.content, { filters: [{ name: ext.toUpperCase(), extensions: [ext] }] }).catch(() => {});
  }
  function sendAsk() {
    if (!onAsk || !picked || !ask.trim()) return;
    onAsk([
      `In the artifact "${thread!.title}" (id ${thread!.id}), change this element (${picked.selector}):`,
      "```html", picked.html, "```",
      ask.trim(),
      `Reply with the full updated artifact, same id "${thread!.id}".`,
    ].join("\n"));
    setAsk(""); setPicked(null);
  }
  function askFix() {
    if (!onAsk || !error) return;
    onAsk(`The artifact "${thread!.title}" (id ${thread!.id}) shows this error in the preview:\n\`\`\`\n${error.slice(0, 1200)}\n\`\`\`\nFix it and reply with the full updated artifact, same id "${thread!.id}".`);
    setError(null);
  }

  const width = WIDTHS[prefs.viewport];
  const live = PREVIEWABLE.has(a.kind) && showing === "preview";

  return (
    <aside className="art-panel" style={style}>
      <div className="art-head">
        {threads.length > 1
          ? <select className="select" style={{ maxWidth: 260 }} value={thread.id} onChange={(e) => setOpen({ id: e.target.value, v: null })}>
              {threads.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
            </select>
          : <span className="truncate" style={{ fontWeight: 600 }}>{thread.title}</span>}
        <span className="row" style={{ gap: 2 }}>
          <button className="btn ghost sm" disabled={vIdx === 0} onClick={() => setOpen({ id: thread.id, v: vIdx })} title="Previous version">‹</button>
          <span className="mono dim" style={{ fontSize: 11 }}>v{vIdx + 1}/{thread.versions.length}</span>
          <button className="btn ghost sm" disabled={vIdx >= thread.versions.length - 1} onClick={() => setOpen({ id: thread.id, v: vIdx + 2 === thread.versions.length ? null : vIdx + 2 })} title="Next version">›</button>
        </span>
        <span className="grow" />
        <button className="btn ghost sm" onClick={copy}>{copied ? "copied" : "copy"}</button>
        <button className="btn ghost sm" onClick={save} disabled={!a.closed}>save</button>
        <button className="btn ghost sm" onClick={onClose} title="Close the panel">×</button>
      </div>

      <div className="art-tools">
        {previewable && (
          <span className="seg">
            <button className={showing === "preview" ? "on" : ""} disabled={!a.closed} onClick={() => setTab("preview")}>preview</button>
            <button className={showing === "code" ? "on" : ""} onClick={() => setTab("code")}>code</button>
          </span>
        )}
        {!a.closed && <span className="mono dim" style={{ fontSize: 11 }}><span className="led busy" /> writing…</span>}
        {live && (
          <>
            <span className="seg" title="Preview width">
              {(["fill", "desktop", "tablet", "phone"] as Viewport[]).map((v) => (
                <button key={v} className={prefs.viewport === v ? "on" : ""} onClick={() => setPrefs((p) => ({ ...p, viewport: v }))}>{v}</button>
              ))}
            </span>
            <span className="seg" title="Color scheme the preview sees">
              {(["auto", "light", "dark"] as Theme[]).map((t) => (
                <button key={t} className={prefs.theme === t ? "on" : ""} onClick={() => setPrefs((p) => ({ ...p, theme: t }))}>{t}</button>
              ))}
            </span>
            <span className="grow" />
            <button className={`btn sm${pick ? " on" : ""}`} onClick={() => { setPick((v) => !v); setPicked(null); }} disabled={!onAsk}
              title="Click an element in the preview, then say what to change">point &amp; ask</button>
            <button className={`btn sm${net ? " on" : ""}`} onClick={() => setNet((v) => !v)}
              title="Let this preview load scripts, styles and fonts from public CDNs. Off: it runs fully offline.">cdn</button>
            <button className="btn ghost sm" onClick={() => setReload((n) => n + 1)} title="Run it again">↻</button>
          </>
        )}
      </div>

      <div className="art-body">
        {showing === "code" && <pre className="art-code selectable">{a.content}</pre>}
        {showing === "preview" && a.kind === "markdown" && <div className="art-doc"><Markdown text={a.content} /></div>}
        {live && (
          <div className="art-stage">
            {url && (
              <iframe key={url} ref={frame} src={url} title={a.title}
                // Scripts run; same-origin, top navigation and popups don't. The
                // page is served with its own CSP (see arcview in electron/main.js).
                sandbox="allow-scripts allow-modals allow-forms allow-pointer-lock"
                style={{ width: width ? `${width}px` : "100%", maxWidth: width ? "none" : "100%", height: "100%", border: 0, background: "#fff", display: "block", margin: "0 auto", boxShadow: width ? "0 0 0 1px var(--border)" : undefined }} />
            )}
          </div>
        )}
      </div>

      {error && (
        <div className="art-foot">
          <span className="err grow truncate" title={error}>⚠ {error.split("\n")[0]}</span>
          {onAsk && <button className="btn sm" onClick={askFix} disabled={busy}>ask to fix</button>}
          <button className="btn ghost sm" onClick={() => setError(null)}>×</button>
        </div>
      )}
      {pick && !picked && <div className="art-foot dim mono" style={{ fontSize: 11 }}>click an element in the preview · press point &amp; ask again to cancel</div>}
      {picked && (
        <div className="art-foot col" style={{ alignItems: "stretch", gap: 6 }}>
          <div className="row" style={{ gap: 6 }}>
            <span className="chip warn mono truncate" style={{ maxWidth: "100%" }} title={picked.selector}>{picked.selector || picked.tag}</span>
            {picked.text && <span className="dim truncate grow" style={{ fontSize: 12 }}>“{picked.text}”</span>}
            <button className="btn ghost sm" onClick={() => setPicked(null)}>×</button>
          </div>
          <div className="row">
            <input className="input grow" autoFocus value={ask} placeholder="What should change? e.g. make it bigger and use the accent color"
              onChange={(e) => setAsk(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") sendAsk(); if (e.key === "Escape") setPicked(null); }} />
            <button className="btn primary sm" onClick={sendAsk} disabled={!ask.trim() || busy} title={busy ? "Wait for the model (or load one)" : undefined}>ask</button>
          </div>
        </div>
      )}
    </aside>
  );
}
