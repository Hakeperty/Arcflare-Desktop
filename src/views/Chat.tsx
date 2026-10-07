// Chat with the model on your GPU. Conversations are kept in this window's
// storage; the model, the prompt and the replies never leave the machine.

import { useEffect, useMemo, useRef, useState } from "react";
import { api, on, uid, type ChatMessage, type LoadedModel, type LocalModel, type ModelProgress } from "../lib/api";
import { Markdown } from "../ui/md";
import { Progress, fmtCtx } from "../ui/kit";
import { progressText, type View } from "../App";

type Turn = ChatMessage & { id: string; reasoning?: string; tokPerSec?: number | null; error?: string };
type Convo = { id: string; title: string; system: string; turns: Turn[]; created: number };

const STORE = "arcflare.chats";
const DEFAULT_SYSTEM = "You are a helpful assistant running locally on the user's own computer. Be clear and concise.";

function loadConvos(): Convo[] {
  try { const v = JSON.parse(localStorage.getItem(STORE) || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}
function saveConvos(c: Convo[]) {
  try { localStorage.setItem(STORE, JSON.stringify(c.slice(0, 100))); } catch { /* storage full or blocked */ }
}
const newConvo = (): Convo => ({ id: uid(), title: "New chat", system: DEFAULT_SYSTEM, turns: [], created: Date.now() });

export function Chat({ loaded, progress, go }: { loaded: LoadedModel | null; progress: ModelProgress | null; go: (v: View) => void }) {
  const [convos, setConvos] = useState<Convo[]>(() => { const c = loadConvos(); return c.length ? c : [newConvo()]; });
  const [activeId, setActiveId] = useState(() => convos[0].id);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState<string | null>(null); // requestId while streaming
  const [models, setModels] = useState<LocalModel[]>([]);
  const [pick, setPick] = useState("");
  const [loadErr, setLoadErr] = useState("");
  const [showSystem, setShowSystem] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const convo = convos.find((c) => c.id === activeId) || convos[0];
  useEffect(() => saveConvos(convos), [convos]);
  useEffect(() => { api.models().then((m) => { setModels(m); if (!pick && m[0]) setPick(m[0].id); }).catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (loaded) setPick(loaded.id); }, [loaded]);

  const patch = (id: string, fn: (c: Convo) => Convo) => setConvos((cs) => cs.map((c) => (c.id === id ? fn(c) : c)));

  // Stream deltas into the last assistant turn of the conversation that asked.
  const streaming = useRef<{ requestId: string; convoId: string; turnId: string } | null>(null);
  useEffect(() => on("chat:delta", (d: { requestId: string; kind: string; text: string }) => {
    const s = streaming.current;
    if (!s || d.requestId !== s.requestId) return;
    patch(s.convoId, (c) => ({
      ...c,
      turns: c.turns.map((t) => (t.id !== s.turnId ? t : d.kind === "reasoning"
        ? { ...t, reasoning: (t.reasoning || "") + d.text }
        : { ...t, content: t.content + d.text })),
    }));
  }), []);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [convo.turns]);

  async function send(text: string, history?: Turn[]) {
    const body = text.trim();
    if (!body || busy) return;
    const base = history ?? convo.turns;
    const user: Turn = { id: uid(), role: "user", content: body };
    const reply: Turn = { id: uid(), role: "assistant", content: "" };
    const turns = [...base, user, reply];
    const title = convo.turns.length === 0 ? body.slice(0, 48) : convo.title;
    patch(convo.id, (c) => ({ ...c, title, turns }));
    setInput("");
    const requestId = uid();
    streaming.current = { requestId, convoId: convo.id, turnId: reply.id };
    stick.current = true;
    setBusy(requestId);
    const messages: ChatMessage[] = [
      ...(convo.system.trim() ? [{ role: "system" as const, content: convo.system }] : []),
      ...[...base, user].map(({ role, content }) => ({ role, content })),
    ];
    try {
      const r = await api.chat(requestId, { messages });
      patch(convo.id, (c) => ({ ...c, turns: c.turns.map((t) => (t.id === reply.id ? { ...t, content: r.text || t.content, tokPerSec: r.tokPerSec } : t)) }));
    } catch (e) {
      const msg = (e as Error).message;
      patch(convo.id, (c) => ({ ...c, turns: c.turns.map((t) => (t.id === reply.id ? { ...t, error: msg === "stopped" ? undefined : msg } : t)) }));
    } finally {
      streaming.current = null;
      setBusy(null);
    }
  }

  function regenerate() {
    const turns = convo.turns;
    const lastUser = [...turns].reverse().find((t) => t.role === "user");
    if (!lastUser) return;
    const idx = turns.lastIndexOf(lastUser);
    send(lastUser.content, turns.slice(0, idx));
  }

  async function loadPicked() {
    if (!pick) return;
    setLoadErr("");
    try { await api.loadModel(pick); } catch (e) { setLoadErr((e as Error).message); }
  }

  const loadingNow = progress && !["loaded", "failed"].includes(progress.stage);
  const picked = useMemo(() => models.find((m) => m.id === pick), [models, pick]);

  return (
    <div className="page flush" style={{ flexDirection: "row" }}>
      {/* conversations */}
      <aside style={{ width: 230, borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ padding: 10 }}>
          <button className="btn" style={{ width: "100%" }} onClick={() => { const c = newConvo(); setConvos((cs) => [c, ...cs]); setActiveId(c.id); }}>
            + new chat
          </button>
        </div>
        <div style={{ overflowY: "auto", flex: 1 }}>
          {convos.map((c) => (
            <div key={c.id} className={`nav${c.id === convo.id ? " on" : ""}`} style={{ fontFamily: "var(--sans)", fontSize: 13 }}
              onClick={() => setActiveId(c.id)}>
              <span className="grow truncate">{c.title}</span>
              <button className="btn ghost sm" title="Delete" onClick={(e) => {
                e.stopPropagation();
                setConvos((cs) => { const rest = cs.filter((x) => x.id !== c.id); if (!rest.length) rest.push(newConvo()); if (c.id === convo.id) setActiveId(rest[0].id); return rest; });
              }}>×</button>
            </div>
          ))}
        </div>
      </aside>

      {/* conversation */}
      <section style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <div className="row" style={{ padding: "10px 16px", borderBottom: "1px solid var(--border)", gap: 8 }}>
          <select className="select" style={{ maxWidth: 360 }} value={pick} onChange={(e) => setPick(e.target.value)} disabled={!!loadingNow}>
            {models.length === 0 && <option value="">no models found</option>}
            {models.map((m) => (
              <option key={m.id} value={m.id}>{m.id} · {m.sizeGb} GB{m.fits === false ? " · too big" : ""}</option>
            ))}
          </select>
          {loaded && loaded.id === pick
            ? <span className="chip ok"><span className="led on" /> loaded · {fmtCtx(loaded.ctx)} ctx</span>
            : <button className="btn primary sm" onClick={loadPicked} disabled={!pick || !!loadingNow}>{loadingNow ? "loading…" : "load"}</button>}
          {picked && picked.bestCtx && !(loaded && loaded.id === pick) && <span className="dim mono" style={{ fontSize: 11 }}>up to {fmtCtx(picked.bestCtx)} ctx fits</span>}
          <span className="grow" />
          <button className={`btn sm${showSystem ? " on" : ""}`} onClick={() => setShowSystem((v) => !v)}>system prompt</button>
          {models.length === 0 && <button className="btn sm" onClick={() => go("models")}>get a model</button>}
        </div>
        {loadingNow && progress && (
          <div style={{ padding: "8px 16px", borderBottom: "1px solid var(--border)" }}>
            <div className="mono dim" style={{ fontSize: 12, marginBottom: 6 }}>{progressText(progress)}</div>
            <Progress value={null} />
          </div>
        )}
        {loadErr && <div className="err" style={{ padding: "8px 16px" }}>{loadErr}</div>}
        {showSystem && (
          <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--border)" }}>
            <textarea className="textarea" rows={3} value={convo.system} onChange={(e) => patch(convo.id, (c) => ({ ...c, system: e.target.value }))} />
          </div>
        )}

        <div ref={scroller} className="selectable" style={{ flex: 1, overflowY: "auto", padding: "18px 0" }}
          onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
          <div style={{ maxWidth: 820, margin: "0 auto", padding: "0 24px" }} className="col">
            {convo.turns.length === 0 && (
              <div className="empty" style={{ marginTop: 40 }}>
                {loaded ? <>Ask anything. It runs on <b>{loaded.name}</b>, on this computer.</>
                  : models.length ? <>Pick a model above and press <b>load</b>.</>
                    : <>No models yet. Get one from <a href="#" onClick={(e) => { e.preventDefault(); go("models"); }}>Models</a>.</>}
              </div>
            )}
            {convo.turns.map((t) => <TurnView key={t.id} t={t} streaming={busy !== null && t === convo.turns[convo.turns.length - 1]} />)}
          </div>
        </div>

        <div style={{ borderTop: "1px solid var(--border)", padding: "12px 16px" }}>
          <div style={{ maxWidth: 820, margin: "0 auto" }} className="row">
            <textarea className="textarea grow" rows={Math.min(8, Math.max(2, input.split("\n").length))} value={input}
              placeholder={loaded ? "Message — Enter to send, Shift+Enter for a new line" : "Load a model to start"}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(input); } }} />
            <div className="col" style={{ gap: 6 }}>
              {busy
                ? <button className="btn danger" onClick={() => api.stopChat(busy)}>stop</button>
                : <button className="btn primary" onClick={() => send(input)} disabled={!input.trim()}>send</button>}
              <button className="btn sm ghost" onClick={regenerate} disabled={!!busy || convo.turns.length === 0}>retry</button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function TurnView({ t, streaming }: { t: Turn; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  if (t.role === "user") {
    return (
      <div style={{ alignSelf: "flex-end", maxWidth: "80%", background: "var(--surface-2)", border: "1px solid var(--border)", padding: "10px 14px", whiteSpace: "pre-wrap" }}>
        {t.content}
      </div>
    );
  }
  return (
    <div style={{ maxWidth: "100%" }}>
      {t.reasoning && (
        <div style={{ marginBottom: 6 }}>
          <button className="btn ghost sm" onClick={() => setOpen((v) => !v)}>{open ? "▾" : "▸"} thinking{streaming && !t.content ? "…" : ""}</button>
          {open && <div className="log" style={{ maxHeight: 260, marginTop: 4 }}>{t.reasoning}</div>}
        </div>
      )}
      {t.content ? <Markdown text={t.content} /> : streaming && !t.reasoning ? <span className="led busy" /> : null}
      {t.error && <div className="err">{t.error}</div>}
      {t.tokPerSec != null && <div className="dim mono" style={{ fontSize: 11, marginTop: 4 }}>{t.tokPerSec} tok/s</div>}
    </div>
  );
}
