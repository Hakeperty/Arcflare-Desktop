// The ArcFlare coding agent on a folder, for people who'd rather not use a
// terminal. The session lives in the main process (see electron/agent.js);
// this screen shows its transcript, asks before commands run, and can stop it.

import { EmptyState } from "../ui/kit";
import { useEffect, useRef, useState } from "react";
import {
  agent, api, on,
  type AgentDeltaEvent, type AgentItem, type AgentItemEvent, type AgentSession, type AgentStatusEvent, type LoadedModel,
} from "../lib/api";
import { Markdown } from "../ui/md";
import type { View } from "../App";

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
  const name = session ? session.folder.split(/[\\/]/).filter(Boolean).pop() : "";

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
                {recent.length > 0 && <button className="btn" onClick={() => openFolder(recent[0])}>reopen {recent[0].split(/[\/]/).filter(Boolean).pop()}</button>}
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
              onAnswer={(allow, always) => agent.answer(session.sessionId, it.id, allow, always).catch((e) => setErr((e as Error).message))} />
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

function ItemView({ it, live, onAnswer }: { it: AgentItem; live: boolean; onAnswer: (allow: boolean, always?: boolean) => void }) {
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
        <div className="agent-tool">
          <button className="agent-tool-h" onClick={() => setOpen((v) => !v)}>
            <span className={`led ${it.state === "running" ? "busy" : it.state === "error" ? "err" : "on"}`} />
            <span style={{ color: "var(--accent)" }}>{it.name}</span>
            <span className="dim truncate grow" style={{ textAlign: "left" }}>{it.detail}</span>
            <span className="dim">{open ? "▾" : "▸"}</span>
          </button>
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
      return (
        <div className="agent-approval">
          <div className="row" style={{ gap: 8 }}>
            <span style={{ color: "var(--accent)" }} className="mono">?</span>
            <span>The agent wants to run <b>{it.what}</b>:</span>
          </div>
          <div className="log" style={{ marginTop: 8, maxHeight: 200, color: "var(--fg)" }}>{it.detail}</div>
          {it.state === "pending" ? (
            <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: "wrap" }}>
              <button className="btn primary sm" onClick={() => onAnswer(true)}>allow</button>
              <button className="btn sm" onClick={() => onAnswer(true, true)}>allow for this session</button>
              <button className="btn danger sm" onClick={() => onAnswer(false)}>deny</button>
            </div>
          ) : (
            <div className={`chip ${it.state === "denied" ? "bad" : "ok"}`} style={{ marginTop: 8 }}>{it.state}</div>
          )}
        </div>
      );
    case "note":
      return <div className="dim mono" style={{ fontSize: 11, textAlign: "center" }}>— {it.text} —</div>;
    case "error":
      return <div className="err">✗ {it.text}</div>;
  }
}
