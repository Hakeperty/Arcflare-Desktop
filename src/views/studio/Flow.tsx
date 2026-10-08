// Flow: chain the studio's tools as a graph — prompt → image → 3D, text →
// speech — and run it in one go. The graph logic lives in src/flow/graph.ts,
// running it in src/flow/runner.ts; this file is the canvas.

import { useEffect, useMemo, useRef, useState } from "react";
import { api, fileUrl, uid, type GenModel, type ImageModels, type LoadedModel } from "../../lib/api";
import { Progress } from "../../ui/kit";
import {
  PORTS, TEMPLATES, TYPE_COLOR, connect, parseGraph, portType, removeEdge, removeNode, serializeGraph,
  type FlowNode, type Graph, type NodeKind,
} from "../../flow/graph";
import { runGraph, type NodeState, type Value } from "../../flow/runner";
import type { Handoff } from "../Studio";

const STORE = "arcflare.flow";
const NODE_W = 240;

const TITLES: Record<NodeKind, string> = {
  prompt: "prompt", rewrite: "rewrite with chat", image: "image", loadImage: "load image",
  to3d: "image → 3d", tts: "text → speech", preview: "preview",
};

function initialGraph(): Graph {
  try {
    const saved = localStorage.getItem(STORE);
    if (saved) { const g = parseGraph(saved); if (g && g.nodes.length) return g; }
  } catch { /* storage blocked */ }
  return TEMPLATES[0].build(uid);
}

type Drag =
  | { kind: "pan"; sx: number; sy: number; ox: number; oy: number }
  | { kind: "node"; id: string; sx: number; sy: number; nx: number; ny: number }
  | { kind: "wire"; from: string; fromPort: string; x: number; y: number };

export function FlowTab({ handoff, loaded }: { handoff: Handoff; loaded: LoadedModel | null }) {
  const [graph, setGraph] = useState<Graph>(initialGraph);
  const [view, setView] = useState({ x: 0, y: 0, z: 1 });
  const [states, setStates] = useState<Record<string, NodeState>>({});
  const [selected, setSelected] = useState<{ node?: string; edge?: string }>({});
  const [drag, setDrag] = useState<Drag | null>(null);
  const [msg, setMsg] = useState("");
  const [running, setRunning] = useState(false);
  const stopped = useRef(false);
  const cache = useRef(new Map<string, Value>());
  const canvas = useRef<HTMLDivElement>(null);
  const [imgModels, setImgModels] = useState<ImageModels | null>(null);
  const [gen, setGen] = useState<GenModel[]>([]);

  useEffect(() => {
    api.imageModels().then(setImgModels).catch(() => {});
    api.genStatus().then(setGen).catch(() => {});
  }, []);
  useEffect(() => { try { localStorage.setItem(STORE, serializeGraph(graph)); } catch { /* full */ } }, [graph]);

  // Delete removes the selected node or wire (not while typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      if (typing || (e.key !== "Delete" && e.key !== "Backspace")) return;
      if (selected.node) setGraph((g) => removeNode(g, selected.node!));
      else if (selected.edge) setGraph((g) => removeEdge(g, selected.edge!));
      setSelected({});
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  const setNodeData = (id: string, k: string, v: string | number | boolean) =>
    setGraph((g) => ({ ...g, nodes: g.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, [k]: v } } : n)) }));

  const toWorld = (cx: number, cy: number) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: (cx - r.left - view.x) / view.z, y: (cy - r.top - view.y) / view.z };
  };

  // Port positions, measured from the DOM so wires follow real layout.
  const portEls = useRef(new Map<string, HTMLElement>());
  const portPos = (nodeId: string, port: string, dir: "in" | "out") => {
    const el = portEls.current.get(`${nodeId}:${dir}:${port}`);
    if (!el || !canvas.current) return null;
    const r = el.getBoundingClientRect();
    return toWorld(r.left + r.width / 2, r.top + r.height / 2);
  };
  const [, force] = useState(0);
  useEffect(() => { force((n) => n + 1); }, [graph, view]);
  // Measure again when the canvas appears or resizes: a tab that mounted while
  // hidden measured every port at 0,0, which drew all the wires as dots.
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const ro = new ResizeObserver(() => force((n) => n + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  function onWheel(e: React.WheelEvent) {
    const r = canvas.current!.getBoundingClientRect();
    const z = Math.min(2, Math.max(0.35, view.z * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    // Zoom around the cursor.
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    setView({ z, x: mx - ((mx - view.x) / view.z) * z, y: my - ((my - view.y) / view.z) * z });
  }

  function onMove(e: React.PointerEvent) {
    if (!drag) return;
    if (drag.kind === "pan") setView((v) => ({ ...v, x: drag.ox + e.clientX - drag.sx, y: drag.oy + e.clientY - drag.sy }));
    else if (drag.kind === "node") {
      const dx = (e.clientX - drag.sx) / view.z, dy = (e.clientY - drag.sy) / view.z;
      setGraph((g) => ({ ...g, nodes: g.nodes.map((n) => (n.id === drag.id ? { ...n, x: drag.nx + dx, y: drag.ny + dy } : n)) }));
    } else {
      const p = toWorld(e.clientX, e.clientY);
      setDrag({ ...drag, x: p.x, y: p.y });
    }
  }

  function dropWire(toNode: string, toPort: string) {
    if (drag?.kind !== "wire") return;
    const next = connect(graph, { from: drag.from, fromPort: drag.fromPort, to: toNode, toPort }, uid());
    if (typeof next === "string") setMsg(next);
    else { setGraph(next); setMsg(""); }
    setDrag(null);
  }

  function addNode(kind: NodeKind) {
    const r = canvas.current!.getBoundingClientRect();
    const c = toWorld(r.left + r.width / 2 - NODE_W / 2, r.top + r.height / 3);
    const node: FlowNode = { id: uid(), kind, x: c.x, y: c.y, data: defaults(kind, imgModels, gen) };
    setGraph((g) => ({ ...g, nodes: [...g.nodes, node] }));
    setSelected({ node: node.id });
  }

  async function run(from?: string) {
    setMsg("");
    stopped.current = false;
    setRunning(true);
    try {
      cache.current = await runGraph(graph, {
        loaded,
        stopped: () => stopped.current,
        setState: (id, s) => setStates((m) => ({ ...m, [id]: { ...(m[id] || { status: "idle", progress: null }), ...s } })),
      }, cache.current, from);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  function stop() {
    stopped.current = true;
    for (const s of Object.values(states)) if (s.status === "running" && s.jobId) api.cancelJob(s.jobId);
  }

  function loadTemplate(i: number) {
    setGraph(TEMPLATES[i].build(uid));
    setStates({});
    cache.current = new Map();
    setView({ x: 0, y: 0, z: 1 });
  }

  const nodeById = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "190px 1fr", flex: 1, minHeight: 0 }}>
      {/* palette */}
      <div style={{ borderRight: "1px solid var(--border)", padding: 10, overflowY: "auto" }} className="col">
        <div className="label"><span className="a">[ add ]</span> // nodes</div>
        {(Object.keys(PORTS) as NodeKind[]).map((k) => (
          <button key={k} className="btn sm" style={{ justifyContent: "flex-start" }} onClick={() => addNode(k)}>+ {TITLES[k]}</button>
        ))}
        <div className="label" style={{ marginTop: 10 }}>templates</div>
        {TEMPLATES.map((t, i) => <button key={t.name} className="btn ghost sm" style={{ justifyContent: "flex-start" }} onClick={() => loadTemplate(i)}>{t.name}</button>)}
        <div className="label" style={{ marginTop: 10 }}>file</div>
        <button className="btn ghost sm" style={{ justifyContent: "flex-start" }} onClick={() => {
          const blob = new Blob([serializeGraph(graph)], { type: "application/json" });
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob); a.download = "arcflare-flow.json"; a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        }}>save as json</button>
        <label className="btn ghost sm" style={{ justifyContent: "flex-start" }}>
          load json
          <input type="file" accept=".json" style={{ display: "none" }} onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            const g = parseGraph(await f.text());
            if (g) { setGraph(g); setStates({}); cache.current = new Map(); } else setMsg("that file isn't a flow");
          }} />
        </label>
        <div className="dim" style={{ fontSize: 11, marginTop: 10, lineHeight: 1.5 }}>
          Drag from an output (right) to an input (left). Wheel zooms, drag the background to pan, Delete removes.
        </div>
      </div>

      {/* canvas */}
      <div style={{ position: "relative", display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div className="row" style={{ padding: "6px 10px", borderBottom: "1px solid var(--border)" }}>
          {running
            ? <button className="btn danger sm" onClick={stop}>stop</button>
            : <button className="btn primary sm" onClick={() => run()}>run flow</button>}
          <button className="btn sm" onClick={() => setView({ x: 0, y: 0, z: 1 })}>reset view</button>
          {msg && <span className="err" style={{ fontSize: 12 }}>{msg}</span>}
          <span className="grow" />
          <span className="dim mono" style={{ fontSize: 11 }}>{graph.nodes.length} nodes · {Math.round(view.z * 100)}%</span>
        </div>
        <div ref={canvas} className="gridbg" style={{ flex: 1, position: "relative", overflow: "hidden", cursor: drag?.kind === "pan" ? "grabbing" : "default" }}
          onWheel={onWheel}
          onPointerDown={(e) => {
            if (e.target !== e.currentTarget) return;
            setSelected({});
            (e.target as Element).setPointerCapture(e.pointerId);
            setDrag({ kind: "pan", sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y });
          }}
          onPointerMove={onMove}
          onPointerUp={() => { if (drag?.kind !== "wire") setDrag(null); else setDrag(null); }}>
          <div style={{ position: "absolute", left: 0, top: 0, transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})`, transformOrigin: "0 0" }}>
            {/* wires */}
            <svg style={{ position: "absolute", left: 0, top: 0, overflow: "visible", width: 1, height: 1, pointerEvents: "none" }}>
              {graph.edges.map((e) => {
                const a = portPos(e.from, e.fromPort, "out");
                const b = portPos(e.to, e.toPort, "in");
                const from = nodeById.get(e.from);
                if (!a || !b || !from) return null;
                const t = portType(from.kind, e.fromPort, "out") || "any";
                const on = selected.edge === e.id;
                return (
                  <path key={e.id} d={curve(a, b)} fill="none" stroke={TYPE_COLOR[t]} strokeWidth={on ? 3 : 2} opacity={on ? 1 : 0.85}
                    style={{ pointerEvents: "stroke", cursor: "pointer" }}
                    onPointerDown={(ev) => { ev.stopPropagation(); setSelected({ edge: e.id }); }} />
                );
              })}
              {drag?.kind === "wire" && (() => {
                const a = portPos(drag.from, drag.fromPort, "out");
                return a ? <path d={curve(a, { x: drag.x, y: drag.y })} fill="none" stroke="var(--accent)" strokeWidth={2} strokeDasharray="6 4" /> : null;
              })()}
            </svg>

            {graph.nodes.map((n) => (
              <NodeBox key={n.id} node={n} state={states[n.id]} selected={selected.node === n.id}
                portEls={portEls.current} imgModels={imgModels} gen={gen} loaded={loaded} running={running}
                onSelect={() => setSelected({ node: n.id })}
                onDragStart={(e) => {
                  setSelected({ node: n.id });
                  (e.target as Element).setPointerCapture(e.pointerId);
                  setDrag({ kind: "node", id: n.id, sx: e.clientX, sy: e.clientY, nx: n.x, ny: n.y });
                }}
                onWireStart={(port, e) => {
                  e.stopPropagation();
                  const p = toWorld(e.clientX, e.clientY);
                  setDrag({ kind: "wire", from: n.id, fromPort: port, x: p.x, y: p.y });
                }}
                onWireDrop={(port) => dropWire(n.id, port)}
                onData={(k, v) => setNodeData(n.id, k, v)}
                onRunFrom={() => run(n.id)}
                handoff={handoff} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function curve(a: { x: number; y: number }, b: { x: number; y: number }) {
  const dx = Math.max(60, Math.abs(b.x - a.x) * 0.5);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

function defaults(kind: NodeKind, img: ImageModels | null, gen: GenModel[]): FlowNode["data"] {
  const first3d = gen.find((m) => m.kind === "3d" && m.installed)?.id || "";
  const firstTts = gen.find((m) => m.kind === "tts" && m.installed)?.id || "";
  switch (kind) {
    case "prompt": return { text: "" };
    case "rewrite": return { instruction: "Rewrite this as a detailed image prompt. Reply with the prompt only." };
    case "image": return { model: img?.models[0]?.path || "", width: 512, height: 512, steps: 20, seed: -1 };
    case "to3d": return { model: first3d, steps: 30, octree: 256 };
    case "tts": return { model: firstTts };
    default: return {};
  }
}

// ---------------------------------------------------------------- one node --

function NodeBox(p: {
  node: FlowNode; state?: NodeState; selected: boolean; portEls: Map<string, HTMLElement>;
  imgModels: ImageModels | null; gen: GenModel[]; loaded: LoadedModel | null; running: boolean;
  onSelect: () => void; onDragStart: (e: React.PointerEvent) => void;
  onWireStart: (port: string, e: React.PointerEvent) => void; onWireDrop: (port: string) => void;
  onData: (k: string, v: string | number | boolean) => void; onRunFrom: () => void; handoff: Handoff;
}) {
  const { node: n, state: s } = p;
  const spec = PORTS[n.kind];
  const d = n.data;
  const led = !s ? "off" : s.status === "running" ? "busy" : s.status === "done" ? "on" : s.status === "failed" ? "err" : "off";
  const reg = (key: string) => (el: HTMLElement | null) => { if (el) p.portEls.set(key, el); else p.portEls.delete(key); };
  const field = (k: string, label: string, el: React.ReactNode) => (
    <label className="field" key={k}><span>{label}</span>{el}</label>
  );
  const installed = (kind: "3d" | "tts") => p.gen.filter((m) => m.kind === kind && m.installed);

  return (
    <div className="panel" onPointerDown={(e) => { e.stopPropagation(); p.onSelect(); }}
      style={{ position: "absolute", left: n.x, top: n.y, width: NODE_W, borderColor: p.selected ? "var(--accent)" : undefined, boxShadow: "0 6px 24px rgba(0,0,0,.35)" }}>
      <div className="panel-h" style={{ cursor: "move" }} onPointerDown={(e) => { e.stopPropagation(); p.onDragStart(e); }}>
        <span className={`led ${led}`} />
        <span className="grow truncate">{TITLES[n.kind]}</span>
        <button className="btn ghost sm" style={{ height: 20, padding: "0 6px" }} title="run from here" disabled={p.running}
          onPointerDown={(e) => e.stopPropagation()} onClick={p.onRunFrom}>▶</button>
      </div>

      {/* ports */}
      <div style={{ position: "relative", minHeight: 8 }}>
        {spec.inputs.map((port, i) => (
          <div key={port.name} ref={reg(`${n.id}:in:${port.name}`)} title={`${port.name} (${port.type})`}
            onPointerUp={() => p.onWireDrop(port.name)}
            style={{ position: "absolute", left: -7, top: 6 + i * 18, width: 12, height: 12, background: TYPE_COLOR[port.type], border: "2px solid var(--bg)", cursor: "crosshair" }} />
        ))}
        {spec.outputs.map((port, i) => (
          <div key={port.name} ref={reg(`${n.id}:out:${port.name}`)} title={`${port.name} (${port.type})`}
            onPointerDown={(e) => p.onWireStart(port.name, e)}
            style={{ position: "absolute", right: -7, top: 6 + i * 18, width: 12, height: 12, background: TYPE_COLOR[port.type], border: "2px solid var(--bg)", cursor: "crosshair" }} />
        ))}
      </div>

      <div className="col" style={{ padding: 10, gap: 8 }} onPointerDown={(e) => e.stopPropagation()}>
        {n.kind === "prompt" && field("text", "text", <textarea className="textarea" rows={3} value={String(d.text ?? "")} onChange={(e) => p.onData("text", e.target.value)} />)}
        {n.kind === "rewrite" && (
          <>
            {field("instruction", "instruction", <textarea className="textarea" rows={3} value={String(d.instruction ?? "")} onChange={(e) => p.onData("instruction", e.target.value)} />)}
            {!p.loaded && <span className="dim" style={{ fontSize: 11 }}>needs a loaded chat model</span>}
          </>
        )}
        {n.kind === "image" && (
          <>
            {field("model", "model", (
              <select className="select" value={String(d.model ?? "")} onChange={(e) => p.onData("model", e.target.value)}>
                <option value="">{p.imgModels?.models.length ? "choose…" : "no image models"}</option>
                {p.imgModels?.models.map((m) => <option key={m.path} value={m.path}>{m.name}</option>)}
              </select>
            ))}
            <div className="grid2" style={{ gap: 6 }}>
              {field("steps", "steps", <input className="input" type="number" value={Number(d.steps ?? 20)} onChange={(e) => p.onData("steps", Number(e.target.value))} />)}
              {field("seed", "seed (-1 random)", <input className="input" type="number" value={Number(d.seed ?? -1)} onChange={(e) => p.onData("seed", Number(e.target.value))} />)}
            </div>
          </>
        )}
        {n.kind === "loadImage" && (
          <>
            {d.path ? <img src={fileUrl(String(d.path))} style={{ width: "100%", maxHeight: 120, objectFit: "contain" }} /> : null}
            <button className="btn sm" onClick={async () => { const f = await api.pickFile({ filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp"] }] }); if (f) p.onData("path", f); }}>choose image…</button>
          </>
        )}
        {n.kind === "to3d" && field("model", "3d model", (
          <select className="select" value={String(d.model ?? "")} onChange={(e) => p.onData("model", e.target.value)}>
            <option value="">{installed("3d").length ? "choose…" : "none set up"}</option>
            {installed("3d").map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        ))}
        {n.kind === "tts" && (
          <>
            {field("model", "speech model", (
              <select className="select" value={String(d.model ?? "")} onChange={(e) => p.onData("model", e.target.value)}>
                <option value="">{installed("tts").length ? "choose…" : "none set up"}</option>
                {installed("tts").map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            ))}
            {field("voice", "voice", <input className="input" value={String(d.voice ?? "")} placeholder="default" onChange={(e) => p.onData("voice", e.target.value)} />)}
          </>
        )}

        {s?.status === "running" && <Progress value={s.progress} />}
        {s?.stage && s.status === "running" && <span className="dim mono" style={{ fontSize: 11 }}>{s.stage}</span>}
        {s?.error && <span className="err" style={{ fontSize: 12 }}>{s.error}</span>}
        {s?.output && <Output v={s.output} handoff={p.handoff} big={n.kind === "preview"} />}
      </div>
    </div>
  );
}

function Output({ v, handoff, big }: { v: Value; handoff: Handoff; big: boolean }) {
  if (v.type === "text") return <div className="log selectable" style={{ maxHeight: big ? 220 : 90 }}>{v.value}</div>;
  if (v.type === "image") return <img src={fileUrl(v.value)} style={{ width: "100%", maxHeight: big ? 220 : 110, objectFit: "contain", border: "1px solid var(--border)" }} />;
  if (v.type === "audio") return <audio controls src={fileUrl(v.value)} style={{ width: "100%", height: 32 }} />;
  if (v.type === "mesh") return (
    <div className="col" style={{ gap: 6 }}>
      <span className="chip ok truncate">{v.value.split(/[\\/]/).pop()}</span>
      <button className="btn primary sm" onClick={() => handoff.openMesh(v.value)}>open in 3d editor</button>
    </div>
  );
  return null;
}
