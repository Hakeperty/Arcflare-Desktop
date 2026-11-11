// The ArcFlare Store: skills, MCP servers and models, in one place. Skills and
// servers come from the engine's store, the same catalogue and files as
// `arcflare store`, so what is added here is there for the command line too.
// Models are the hub and the Arcs, which already have their own screens.

import { useEffect, useState } from "react";
import { api, type LoadedModel, type StoreList, type StoreMcp, type StoreSkill } from "../lib/api";
import { EmptyState, ViewHead } from "../ui/kit";
import { Markdown } from "../ui/md";
import { Arcs, Hub } from "./Models";
import type { View } from "../App";

type Tab = "skills" | "mcp" | "models" | "arcs";

export function Store({ loaded, go }: { loaded: LoadedModel | null; go: (v: View) => void }) {
  const [tab, setTab] = useState<Tab>("skills");
  const [data, setData] = useState<StoreList | null>(null);
  const [err, setErr] = useState("");
  const load = (refresh?: boolean) => api.store(refresh).then(setData).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  const run = async (fn: () => Promise<StoreList>) => {
    setErr("");
    try { setData(await fn()); } catch (e) { setErr((e as Error).message); }
  };

  return (
    <div className="page flush">
      <div className="tabs">
        <button className={`tab${tab === "skills" ? " on" : ""}`} onClick={() => setTab("skills")}>skills{data?.available ? ` ${data.skills.length}` : ""}</button>
        <button className={`tab${tab === "mcp" ? " on" : ""}`} onClick={() => setTab("mcp")}>mcp servers{data?.available ? ` ${data.mcp.length}` : ""}</button>
        <button className={`tab${tab === "models" ? " on" : ""}`} onClick={() => setTab("models")}>models</button>
        <button className={`tab${tab === "arcs" ? " on" : ""}`} onClick={() => setTab("arcs")}>arcs</button>
      </div>
      <div className="page">
        {tab === "models" ? <Hub />
          : tab === "arcs" ? <Arcs loaded={loaded} go={go} />
          : !data ? <div className="muted">{err || "Opening the store…"}</div>
          : !data.available
            ? <EmptyState seed="no-store" title="The store needs a newer engine">Update ArcFlare, then come back: the store arrived in a later version of the engine than the one this app is running.</EmptyState>
            : tab === "skills"
              ? <Skills data={data} err={err} refresh={() => load(true)} add={(id) => run(() => api.storeSkillAdd(id))} remove={(id) => run(() => api.storeSkillRemove(id))} />
              : <Servers data={data} err={err} refresh={() => load(true)} add={(id, extra, accept) => run(() => api.storeMcpAdd(id, extra, accept))} remove={(id) => run(() => api.storeMcpRemove(id))} />}
      </div>
    </div>
  );
}

const sourceChip = (source: StoreList["source"]) =>
  <span className={`chip ${source === "live" ? "ok" : "warn"}`}>{source === "live" ? "live" : source === "cache" ? "offline · saved copy" : "offline · bundled copy"}</span>;

/** The SKILL.md without its frontmatter and title: what the agent reads. */
const body = (text: string) => text.replace(/^---\n[\s\S]*?\n---\n?/, "").replace(/^\s*# .*\n+/, "").trim();

function Skills({ data, err, refresh, add, remove }: {
  data: StoreList; err: string; refresh: () => void; add: (id: string) => void; remove: (id: string) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const missing = data.skills.filter((s) => !s.installed);
  const state = (s: StoreSkill) => !s.installed ? null : !s.fromStore ? "yours" : s.current ? "added" : "update";
  return (
    <>
      <ViewHead index="store" label="skills" title="Skills" right={<>
        {sourceChip(data.source)}
        {missing.length > 0 && <button className="btn sm" onClick={() => missing.forEach((s) => add(s.id))}>add all</button>}
        <button className="btn sm" onClick={refresh}>refresh</button>
      </>}>
        A skill is a page of instructions for one kind of task. The agent sees one line per skill and loads a whole one only
        when a task calls for it. Adding one copies it to <span className="mono">~/.arcflare/skills</span>, for the command line too.
      </ViewHead>
      {err && <div className="err" style={{ marginBottom: 10 }}>{err}</div>}
      <div className="grid3">
        {data.skills.map((s) => {
          const st = state(s);
          return (
            <div key={s.id} className={`card col${st === "added" ? " loaded" : ""}`} style={{ gap: 8 }}>
              <div className="row">
                <span className="mono grow truncate" style={{ fontWeight: 600 }}>{s.id}</span>
                <span className="chip">{s.category}</span>
              </div>
              <div className="muted" style={{ fontSize: 13, lineHeight: 1.45, flex: 1 }}>{s.description}.</div>
              <div className="row wrap" style={{ gap: 6 }}>
                {st && <span className={`chip ${st === "added" ? "ok" : st === "update" ? "warn" : ""}`}>{st === "yours" ? "your own" : st === "update" ? "changed since" : "added"}</span>}
                {s.uses.map((u) => <span key={u} className="chip" title={`Written around ArcFlare's ${u} tools: switch them on in the Agent view`}>uses {u}</span>)}
              </div>
              <div className="row">
                {st === "yours"
                  ? <span className="dim mono" style={{ fontSize: 11 }}>you have your own skill by this name</span>
                  : st === "added"
                    ? <button className="btn sm" onClick={() => remove(s.id)}>remove</button>
                    : <button className="btn primary sm" onClick={() => add(s.id)}>{st === "update" ? "restore" : "add"}</button>}
                <button className={`btn ghost sm${open === s.id ? " on" : ""}`} onClick={() => setOpen(open === s.id ? null : s.id)}>read it</button>
              </div>
              {open === s.id && <div className="selectable" style={{ borderTop: "1px solid var(--border)", paddingTop: 10, fontSize: 13 }}><Markdown text={body(s.text)} /></div>}
            </div>
          );
        })}
      </div>
    </>
  );
}

function Servers({ data, err, refresh, add, remove }: {
  data: StoreList; err: string; refresh: () => void; add: (id: string, extra: string[], accept: boolean) => void; remove: (id: string) => void;
}) {
  const [extra, setExtra] = useState<Record<string, string>>({});
  const ours = data.mcp.filter((m) => m.ours);
  const others = data.mcp.filter((m) => !m.ours);

  function addOne(m: StoreMcp) {
    const arg = (extra[m.id] || "").trim();
    if (m.ours) return add(m.id, [], true);
    if (m.argument?.required && !arg) return;
    // Someone else's program: who makes it and exactly what will run, before anything is written.
    const ok = window.confirm(
      `${m.name} is made by ${m.by}, not by ArcFlare.\n\n`
      + `Adding it means the agent runs this program each time it starts, downloading it first if needed:\n\n`
      + `${m.runs}${arg ? " " + arg : ""}\n\nAdd it?`);
    if (ok) add(m.id, arg ? [arg] : [], true);
  }

  const card = (m: StoreMcp) => (
    <div key={m.id} className={`card col${m.installed ? " loaded" : ""}`} style={{ gap: 8 }}>
      <div className="row">
        <span className="mono grow truncate" style={{ fontWeight: 600 }}>{m.ours ? m.id : m.name}</span>
        <span className={`chip${m.ours ? " warn" : ""}`}>{m.ours ? "arcflare" : m.by}</span>
      </div>
      <div className="muted" style={{ fontSize: 13, lineHeight: 1.45, flex: 1 }}>{m.description}</div>
      {m.runs && <div className="dim mono selectable" style={{ fontSize: 11, wordBreak: "break-all" }}>runs: <span style={{ color: "var(--fg)" }}>{m.runs}{m.argument ? ` <${m.argument.name}>` : ""}</span></div>}
      <div className="row wrap" style={{ gap: 6 }}>
        {m.installed && <span className="chip ok">added</span>}
        {!m.hasNeeds && m.needs && <span className="chip bad" title={`${m.needs} is not on this computer yet, so this server will not start until it is`}>needs {m.needs}</span>}
      </div>
      {!m.ours && m.argument && !m.installed && (
        <input className="input" placeholder={`${m.argument.name}: ${m.argument.about}`} value={extra[m.id] || ""} onChange={(e) => setExtra((x) => ({ ...x, [m.id]: e.target.value }))} />
      )}
      <div className="row">
        {m.installed
          ? <button className="btn sm" onClick={() => remove(m.id)}>remove</button>
          : <button className="btn primary sm" disabled={!m.ours && !!m.argument?.required && !(extra[m.id] || "").trim()} onClick={() => addOne(m)}>add</button>}
        {m.homepage && <button className="btn ghost sm" onClick={() => api.openExternal(m.homepage!)}>source</button>}
      </div>
    </div>
  );

  return (
    <>
      <ViewHead index="store" label="mcp servers" title="MCP servers" right={<>{sourceChip(data.source)}<button className="btn sm" onClick={refresh}>refresh</button></>}>
        An MCP server gives the agent tools. Adding one writes its start command into <span className="mono">~/.arcflare/mcp.json</span>,
        where the agent here, the command line and the phone all look. It is used from the agent&apos;s next session.
      </ViewHead>
      {err && <div className="err" style={{ marginBottom: 10 }}>{err}</div>}
      <div className="label" style={{ marginBottom: 8 }}>{"//"} arcflare&apos;s own · part of the app, nothing to download</div>
      <div className="grid3" style={{ marginBottom: 18 }}>{ours.map(card)}</div>
      <div className="dim" style={{ fontSize: 12, marginBottom: 10 }}>
        The agent in this app already has these behind its switches (machine tools, desktop, web). Adding one here is for the phone&apos;s Tools screen and for other programs that read the same file.
      </div>
      <div className="label" style={{ marginBottom: 8 }}>{"//"} made by others · run with npx or uvx</div>
      <div className="err" style={{ marginBottom: 10, lineHeight: 1.5, color: "var(--muted)" }}>
        These are not made or reviewed by ArcFlare. Adding one means the agent runs that program each time it starts. Each card shows the exact command, and adding asks first.
      </div>
      <div className="grid3">{others.map(card)}</div>
    </>
  );
}
