// The ArcFlare coding agent on a folder, for people who'd rather not use a
// terminal. The session lives in the main process (see electron/agent.js);
// this screen shows its transcript, asks before commands run, and can stop it.

import { EmptyState } from "../ui/kit";
import { useEffect, useRef, useState } from "react";
import {
  agent, api, on,
  type AgentApproval, type AgentDecision, type AgentDeltaEvent, type AgentItem, type AgentItemEvent, type AgentPreview,
  type AgentSession, type AgentStatusEvent, type LoadedModel,
} from "../lib/api";
import { Markdown } from "../ui/md";
import type { View } from "../App";
import { baseName } from "../lib/path";

const FOLDER = "arcflare.agent.folder";
const MACHINE = "arcflare.agent.machine";
const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* blocked */ } };

export function Agent({ loaded, go }: { loaded: LoadedModel | null; go: (v: View) => void }) {
  const [session, setSession] = useState<AgentSession | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [err, setErr] = useState("");
  const [machine, setMachine] = useState(read(MACHINE) !== "0");
  const [showNotes, setShowNotes] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const sid = session?.sessionId;

  async function openFolder(folder: string, opts?: { machine?: boolean }) {
    setErr("");
    try {
      const s = await agent.open(folder, { machine: opts?.machine ?? machine });
      setSession(s);
      write(FOLDER, s.folder);
      agent.recent().then(setRecent).catch(() => {});
    } catch (e) { setErr((e as Error).message); }
  }

  // Reopen the last folder, and list the recent ones.
  useEffect(() => {
    agent.recent().then(setRecent).catch(() => {});
    const last = read(FOLDER);
    if (last) {
      agent.open(last, { machine }).then((s) => { setSession(s); agent.recent().then(setRecent).catch(() => {}); })
        .catch(() => write(FOLDER, ""));   // moved or deleted since: just start without it
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Live updates for the open session.
  useEffect(() => {
    if (!sid) return;
    const offs = [
      on("agent:item", (e: AgentItemEvent) => {
        if (e.sessionId !== sid) return;
        setSession((s) => {
          if (!s) return s;
          const i = s.items.findIndex((x) => x.id === e.item.id);
          const items = i >= 0 ? s.items.map((x, j) => (j === i ? e.item : x)) : [...s.items, e.item];
          return { ...s, items };
        });
      }),
      on("agent:delta", (e: AgentDeltaEvent) => {
        if (e.sessionId !== sid) return;
        setSession((s) => s && {
          ...s,
          items: s.items.map((x) => (x.id !== e.itemId || x.kind !== "assistant" ? x
            : e.kind === "content" ? { ...x, content: x.content + e.text } : { ...x, reasoning: x.reasoning + e.text })),
        });
      }),
      on("agent:status", (e: AgentStatusEvent) => {
        if (e.sessionId !== sid) return;
        setSession((s) => s && { ...s, busy: e.busy, stopping: e.stopping, auto: e.auto, stats: e.stats, model: e.model ?? s.model });
      }),
    ];
    return () => offs.forEach((f) => f());
  }, [sid]);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [session?.items]);

  async function pick() {
    const f = await api.pickFile({ directory: true, title: "Folder for the agent to work in" }).catch(() => null);
    if (f) openFolder(f);
  }

  async function send() {
    const t = input.trim();
    if (!t || !session || session.busy) return;
    setErr("");
    setInput("");
    stick.current = true;
    try { await agent.send(session.sessionId, t); } catch (e) { setErr((e as Error).message); }
  }

  async function toggleAuto() {
    if (!session) return;
    if (!session.auto && !window.confirm(
      "Auto mode runs every command the agent wants without asking, with your permissions, in this folder.\n\n"
      + "Only use it on code you trust. Turn it on?")) return;
    try { await agent.auto(session.sessionId, !session.auto); } catch (e) { setErr((e as Error).message); }
  }

  function toggleMachine() {
    const next = !machine;
    setMachine(next);
    write(MACHINE, next ? "1" : "0");
    if (session) openFolder(session.folder, { machine: next });
  }

  const busy = !!session?.busy;
  const name = session ? baseName(session.folder) : "";

  return (
    <div className="page flush" style={{ flexDirection: "column" }}>
      {/* folder + controls */}
      <div className="row" style={{ padding: "10px 16px", borderBottom: "1px solid var(--border)", gap: 8, flexWrap: "wrap" }}>
        {session
          ? <button className="btn sm" onClick={pick} title="Open another folder">folder…</button>
          : <span className="label"><span className="a">[ 03 ]</span> {"//"} agent · no folder open</span>}
        {recent.length > 1 && (
          <select className="select" style={{ maxWidth: 220 }} value={session?.folder ?? ""} onChange={(e) => e.target.value && openFolder(e.target.value)}>
            <option value="">recent folders</option>
            {recent.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        )}
        {session && (
          <span className="mono truncate" style={{ fontSize: 12, minWidth: 0 }} title={session.folder}>
            <b>{name}</b> <span className="dim">{session.folder}</span>
          </span>
        )}
        {session?.branch && <span className="chip">⎇ {session.branch}</span>}
        <span className="grow" />
        {session && (
          <>
            <button className={`btn sm${machine ? " on" : ""}`} onClick={toggleMachine} disabled={busy}
              title="ArcFlare's machine server: lets the agent open apps, see the screen and use the desktop. Changing it restarts the session.">
              machine tools {machine ? "on" : "off"}
            </button>
            <button className={`btn sm${session.auto ? " danger on" : ""}`} onClick={toggleAuto}
              title={session.auto ? "Commands run without asking" : "Every command asks first"}>
              {session.auto ? "⚠ auto mode" : "asks first"}
            </button>
            <button className="btn sm" onClick={() => agent.clear(session.sessionId).then(setSession).catch((e) => setErr((e as Error).message))} disabled={busy || session.items.length === 0}>clear</button>
          </>
        )}
      </div>

      {session && session.notes.length > 0 && (
        <div style={{ padding: "6px 16px", borderBottom: "1px solid var(--border)" }}>
          <button className="btn ghost sm" onClick={() => setShowNotes((v) => !v)}>{showNotes ? "▾" : "▸"} {session.notes.length} setup note{session.notes.length === 1 ? "" : "s"}</button>
          {showNotes && <div className="log" style={{ marginTop: 4 }}>{session.notes.join("\n")}</div>}
        </div>
      )}

      {/* transcript */}
      <div ref={scroller} className="selectable" style={{ flex: 1, overflowY: "auto", padding: "18px 0" }}
        onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
        <div style={{ maxWidth: 860, margin: "0 auto", padding: "0 24px" }} className="col">
          {!session && (
            <EmptyState seed="agent-folder" title="Point the agent at a folder"
              action={<>
                <button className="btn primary" onClick={pick}>open a folder</button>
                {recent.length > 0 && <button className="btn" onClick={() => openFolder(recent[0])}>reopen {baseName(recent[0])}</button>}
              </>}>
              The coding agent reads, edits and runs things in a folder you choose, using the model on this computer. It asks
              before running commands unless you switch on auto mode.
            </EmptyState>
          )}
          {session && !loaded && (
            <EmptyState seed="agent-model" title="Load a model first"
              action={<><button className="btn primary" onClick={() => go("models")}>models</button><button className="btn" onClick={() => go("chat")}>chat</button></>}>
              The agent uses the model loaded in this app. A 20–35B coding model works best.
            </EmptyState>
          )}
          {session && loaded && session.items.length === 0 && (
            <EmptyState seed={`agent-${name}`} title={`Ready in ${name}`}>
              Ask for something: &quot;explain this project&quot;, &quot;fix the failing test&quot;, &quot;add a README&quot;.
              It shows every file it reads and asks before running a command.
            </EmptyState>
          )}
          {session?.items.map((it, i) => (
            <ItemView key={it.id} it={it} live={busy && i === session.items.length - 1}
              onAnswer={(approvalId, d) => agent.answer(session.sessionId, approvalId, d).catch((e) => setErr((e as Error).message))} />
          ))}
          {err && <div className="err">{err}</div>}
        </div>
      </div>

      {/* input */}
      <div style={{ borderTop: "1px solid var(--border)", padding: "12px 16px" }}>
        <div style={{ maxWidth: 860, margin: "0 auto" }} className="row">
          <textarea className="textarea grow" rows={Math.min(8, Math.max(2, input.split("\n").length))} value={input}
            disabled={!session}
            placeholder={!session ? "Open a folder first" : loaded ? "What should the agent do? Enter to send, Shift+Enter for a new line" : "Load a model first"}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
          <div className="col" style={{ gap: 6, alignItems: "stretch" }}>
            {busy
              ? <button className="btn danger" onClick={() => session && agent.stop(session.sessionId)} disabled={session?.stopping}>{session?.stopping ? "stopping…" : "stop"}</button>
              : <button className="btn primary" onClick={send} disabled={!input.trim() || !session || !loaded}>send</button>}
          </div>
        </div>
        {session?.stats && (
          <div className="dim mono" style={{ maxWidth: 860, margin: "6px auto 0", fontSize: 11 }}>
            last turn · {session.stats.steps} steps · {session.stats.toolCalls} tool calls
            {session.stats.tokPerSec != null ? ` · ${session.stats.tokPerSec} tok/s` : ""} · {session.stats.seconds}s
            {session.model ? ` · ${session.model}` : ""}
          </div>
        )}
      </div>
    </div>
  );
}

type Answer = (approvalId: string, d: AgentDecision) => void;

const KIND_LABEL: Record<string, string> = { bash: "shell commands", write: "file changes", mcp: "MCP calls" };
const ASK_LABEL: Record<string, string> = { bash: "run this command", write: "make this change", mcp: "call this tool" };

/** The whole command, the diff of a write, or an MCP call, as on the card. */
function PreviewView({ p }: { p: AgentPreview }) {
  const box: React.CSSProperties = { marginTop: 8, maxHeight: 320, overflow: "auto", background: "var(--bg)", border: "1px solid var(--border)", padding: "8px 10px", font: "12px/1.5 var(--mono)" };
  switch (p.type) {
    case "command":
      return (
        <div style={box}>
          <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", color: "var(--fg)" }}>{p.text}</div>
          {p.more > 0 && <div className="dim">… {p.more} more characters</div>}
          {p.cwd && <div className="dim" style={{ marginTop: 4 }}>in {p.cwd}</div>}
        </div>
      );
    case "diff":
      return (
        <div style={box}>
          <div style={{ marginBottom: 4 }}>
            <b>{p.file}</b>{" "}
            {p.isNew
              ? <span className="dim">new file · {p.add} lines</span>
              : <span><span style={{ color: "#f87171" }}>-{p.del}</span> <span style={{ color: "var(--accent-2, #2dd4bf)" }}>+{p.add}</span></span>}
          </div>
          {p.rows.map((r, i) => (
            <div key={i} style={{
              whiteSpace: "pre-wrap", wordBreak: "break-all",
              color: r.sign === "-" ? "#f87171" : r.sign === "+" ? "var(--accent-2, #2dd4bf)" : "var(--muted)",
              background: r.sign === "-" ? "rgba(248,113,113,.08)" : r.sign === "+" ? "rgba(45,212,191,.08)" : "transparent",
            }}>{r.sign === "…" ? `… ${r.text}` : `${r.sign} ${r.text}`}</div>
          ))}
        </div>
      );
    case "call":
      return <div style={box}><b>{p.name}</b><div className="dim" style={{ whiteSpace: "pre-wrap" }}>{p.text}</div></div>;
    default:
      return <div style={{ ...box, whiteSpace: "pre-wrap" }}>{p.text}</div>;
  }
}

/** The question on a tool card: preview plus allow / allow kind / edit / skip / deny. */
function ApprovalPanel({ a, onAnswer }: { a: AgentApproval; onAnswer: Answer }) {
  const [editing, setEditing] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [cmd, setCmd] = useState(a.preview?.type === "command" ? a.preview.text : "");
  const [reason, setReason] = useState("");
  const pending = a.state === "pending";
  const kindLabel = KIND_LABEL[a.what] || a.what;
  const skip = () => onAnswer(a.id, { action: "skip", reason: reason.trim() || undefined });
  return (
    <div style={{ borderTop: "1px solid var(--border)", borderLeft: pending ? "2px solid var(--accent)" : "2px solid transparent", background: pending ? "var(--accent-soft)" : "transparent", padding: pending ? "10px 12px" : "6px 12px" }}>
      {pending && (
        <div className="row" style={{ gap: 8 }}>
          <span style={{ color: "var(--accent)" }} className="mono">?</span>
          <span>Allow the agent to {ASK_LABEL[a.what] || `run ${a.what}`}?</span>
        </div>
      )}
      {pending && !editing && a.preview && <PreviewView p={a.preview} />}
      {pending && editing && (
        <textarea className="textarea" style={{ width: "100%", marginTop: 8, font: "12px/1.5 var(--mono)" }}
          rows={Math.min(10, Math.max(3, cmd.split("\n").length + 1))} value={cmd} autoFocus
          onChange={(e) => setCmd(e.target.value)} />
      )}
      {pending && skipping && (
        <input className="input" style={{ width: "100%", marginTop: 8 }} placeholder="why skip it? (optional; the agent sees this)"
          value={reason} autoFocus onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") skip(); }} />
      )}
      {pending ? (
        <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          {editing ? (
            <>
              <button className="btn primary sm" disabled={!cmd.trim()} onClick={() => onAnswer(a.id, { action: "edit", command: cmd })}>run edited</button>
              <button className="btn sm" onClick={() => setEditing(false)}>cancel</button>
            </>
          ) : skipping ? (
            <>
              <button className="btn primary sm" onClick={skip}>skip it</button>
              <button className="btn sm" onClick={() => setSkipping(false)}>cancel</button>
            </>
          ) : (
            <>
              <button className="btn primary sm" onClick={() => onAnswer(a.id, { action: "allow" })}>allow</button>
              <button className="btn sm" onClick={() => onAnswer(a.id, { action: "allow", session: true })}>allow {kindLabel} this session</button>
              {a.canEdit && <button className="btn sm" onClick={() => setEditing(true)}>edit</button>}
              <button className="btn sm" title="Don't run it; the agent carries on without it" onClick={() => setSkipping(true)}>skip</button>
              <button className="btn danger sm" onClick={() => onAnswer(a.id, { action: "deny" })}>deny</button>
            </>
          )}
        </div>
      ) : (
        <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <span className={`chip ${a.state === "denied" ? "bad" : a.state === "skipped" ? "" : "ok"}`}>{a.state}</span>
          {a.ran && <span className="dim mono truncate" style={{ fontSize: 11 }}>ran: {a.ran}</span>}
          {a.reason && <span className="dim" style={{ fontSize: 11 }}>“{a.reason}”</span>}
        </div>
      )}
    </div>
  );
}

function ItemView({ it, live, onAnswer }: { it: AgentItem; live: boolean; onAnswer: Answer }) {
  const [open, setOpen] = useState(false);
  switch (it.kind) {
    case "user":
      return (
        <div style={{ alignSelf: "flex-end", maxWidth: "80%", background: "var(--surface-2)", border: "1px solid var(--border)", padding: "10px 14px", whiteSpace: "pre-wrap" }}>
          {it.text}
        </div>
      );
    case "assistant":
      return (
        <div>
          {it.reasoning && (
            <div style={{ marginBottom: 6 }}>
              <button className="btn ghost sm" onClick={() => setOpen((v) => !v)}>{open ? "▾" : "▸"} thinking{live && !it.content ? "…" : ""}</button>
              {open && <div className="log" style={{ maxHeight: 260, marginTop: 4 }}>{it.reasoning}</div>}
            </div>
          )}
          {it.content ? <Markdown text={it.content} /> : live && !it.reasoning ? <span className="led busy" /> : null}
        </div>
      );
    case "tool":
      return (
        <div className="agent-tool" style={it.approval?.state === "pending" ? { borderColor: "var(--accent)" } : undefined}>
          <button className="agent-tool-h" onClick={() => setOpen((v) => !v)}>
            <span className={`led ${it.state === "running" ? "busy" : it.state === "error" ? "err" : it.state === "skipped" ? "off" : "on"}`} />
            <span style={{ color: "var(--accent)" }}>{it.name}</span>
            <span className="dim truncate grow" style={{ textAlign: "left" }}>{it.detail}</span>
            <span className="dim">{open ? "▾" : "▸"}</span>
          </button>
          {it.approval && <ApprovalPanel a={it.approval} onAnswer={onAnswer} />}
          {open && (
            <div style={{ padding: "0 10px 10px" }}>
              {it.args && it.args !== "{}" && <div className="log" style={{ maxHeight: 160 }}>{it.args}</div>}
              {it.out != null && <div className="log" style={{ maxHeight: 300, marginTop: 6 }}>{it.out || "(no output)"}</div>}
            </div>
          )}
          {!open && it.out != null && (
            <div className="dim mono truncate" style={{ fontSize: 11, padding: "0 10px 8px 26px" }}>
              └ {it.out.split("\n")[0].slice(0, 140)}{it.out.includes("\n") ? `  (${it.out.split("\n").length} lines)` : ""}
            </div>
          )}
        </div>
      );
    case "approval":
      // A question with no tool card to sit on (older engines).
      return it.approval
        ? <div className="agent-tool" style={{ borderColor: "var(--accent)" }}><ApprovalPanel a={it.approval} onAnswer={onAnswer} /></div>
        : <div className="agent-approval"><div className="log">{it.detail}</div><div className="chip">{it.state}</div></div>;
    case "note":
      return <div className="dim mono" style={{ fontSize: 11, textAlign: "center" }}>— {it.text} —</div>;
    case "error":
      return <div className="err">✗ {it.text}</div>;
  }
}
