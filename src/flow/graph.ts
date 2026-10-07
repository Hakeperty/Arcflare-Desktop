// The pure part of the flow editor: what a graph is, which ports connect, the
// order nodes run in, and how a graph is saved. No React, no Electron — so it
// can be reasoned about (and tested) on its own.

export type PortType = "text" | "image" | "mesh" | "audio" | "any";

export type NodeKind = "prompt" | "rewrite" | "image" | "loadImage" | "to3d" | "tts" | "preview";

export type FlowNode = {
  id: string;
  kind: NodeKind;
  x: number;
  y: number;
  /** The node's own fields (prompt text, model, steps…), plain JSON. */
  data: Record<string, string | number | boolean>;
};

/** An edge runs from an output port of one node to an input port of another. */
export type FlowEdge = {
  id: string;
  from: string;
  fromPort: string;
  to: string;
  toPort: string;
};

export type Graph = { nodes: FlowNode[]; edges: FlowEdge[] };

export type PortSpec = { name: string; type: PortType };

/** Ports per node kind. Kept here (not with the UI) so the runner and the
 *  validator agree on them without importing React. */
export const PORTS: Record<NodeKind, { inputs: PortSpec[]; outputs: PortSpec[] }> = {
  prompt: { inputs: [], outputs: [{ name: "text", type: "text" }] },
  rewrite: { inputs: [{ name: "text", type: "text" }], outputs: [{ name: "text", type: "text" }] },
  image: { inputs: [{ name: "prompt", type: "text" }], outputs: [{ name: "image", type: "image" }] },
  loadImage: { inputs: [], outputs: [{ name: "image", type: "image" }] },
  to3d: { inputs: [{ name: "image", type: "image" }], outputs: [{ name: "mesh", type: "mesh" }] },
  tts: { inputs: [{ name: "text", type: "text" }], outputs: [{ name: "audio", type: "audio" }] },
  preview: { inputs: [{ name: "in", type: "any" }], outputs: [] },
};

export const TYPE_COLOR: Record<PortType, string> = {
  text: "#a09d93",
  image: "#ffb020",
  mesh: "#35e0d0",
  audio: "#c08cff",
  any: "#edeae2",
};

export function portType(kind: NodeKind, port: string, dir: "in" | "out"): PortType | null {
  const list = dir === "in" ? PORTS[kind].inputs : PORTS[kind].outputs;
  const p = list.find((x) => x.name === port);
  return p ? p.type : null;
}

/** An output can feed an input of the same type, or an "any" input. */
export function compatible(out: PortType, input: PortType): boolean {
  return input === "any" || out === input;
}

/**
 * Add an edge, enforcing types and one connection per input (the new edge
 * replaces the old). Returns the new graph, or an error message.
 */
export function connect(g: Graph, e: Omit<FlowEdge, "id">, id: string): Graph | string {
  if (e.from === e.to) return "a node cannot feed itself";
  const a = g.nodes.find((n) => n.id === e.from);
  const b = g.nodes.find((n) => n.id === e.to);
  if (!a || !b) return "missing node";
  const ot = portType(a.kind, e.fromPort, "out");
  const it = portType(b.kind, e.toPort, "in");
  if (!ot || !it) return "missing port";
  if (!compatible(ot, it)) return `a ${ot} output cannot go into a ${it} input`;
  const edges = g.edges.filter((x) => !(x.to === e.to && x.toPort === e.toPort));
  const next = { ...g, edges: [...edges, { ...e, id }] };
  if (hasCycle(next)) return "that connection would make a loop";
  return next;
}

export function removeNode(g: Graph, id: string): Graph {
  return { nodes: g.nodes.filter((n) => n.id !== id), edges: g.edges.filter((e) => e.from !== id && e.to !== id) };
}

export function removeEdge(g: Graph, id: string): Graph {
  return { ...g, edges: g.edges.filter((e) => e.id !== id) };
}

/** Kahn's algorithm. Returns node ids in run order, or null if there is a cycle. */
export function topoSort(g: Graph): string[] | null {
  const indeg = new Map<string, number>(g.nodes.map((n) => [n.id, 0]));
  for (const e of g.edges) if (indeg.has(e.to) && indeg.has(e.from)) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  // Stable: ready nodes in left-to-right, top-to-bottom order.
  const pos = new Map(g.nodes.map((n) => [n.id, n]));
  const byPos = (a: string, b: string) => {
    const na = pos.get(a)!, nb = pos.get(b)!;
    return na.x - nb.x || na.y - nb.y;
  };
  const ready = [...indeg].filter(([, d]) => d === 0).map(([id]) => id).sort(byPos);
  const out: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    out.push(id);
    for (const e of g.edges) {
      if (e.from !== id || !indeg.has(e.to)) continue;
      const d = (indeg.get(e.to) ?? 0) - 1;
      indeg.set(e.to, d);
      if (d === 0) { ready.push(e.to); ready.sort(byPos); }
    }
  }
  return out.length === g.nodes.length ? out : null;
}

export function hasCycle(g: Graph): boolean {
  return topoSort(g) === null;
}

/** A node and everything downstream of it, in run order. */
export function downstream(g: Graph, start: string): string[] {
  const order = topoSort(g) ?? [];
  const keep = new Set([start]);
  for (const id of order) {
    if (keep.has(id)) for (const e of g.edges) if (e.from === id) keep.add(e.to);
  }
  return order.filter((id) => keep.has(id));
}

/** The edge feeding an input port, if any. */
export function inputEdge(g: Graph, nodeId: string, port: string): FlowEdge | undefined {
  return g.edges.find((e) => e.to === nodeId && e.toPort === port);
}

// ------------------------------------------------------------ persistence ----

const KINDS = Object.keys(PORTS) as NodeKind[];

/** Parse a saved graph, dropping anything malformed rather than failing. */
export function parseGraph(text: string): Graph | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { nodes?: unknown; edges?: unknown };
  if (!Array.isArray(r.nodes) || !Array.isArray(r.edges)) return null;
  const nodes: FlowNode[] = [];
  for (const n of r.nodes as Record<string, unknown>[]) {
    if (!n || typeof n.id !== "string" || !KINDS.includes(n.kind as NodeKind)) continue;
    const data: FlowNode["data"] = {};
    if (n.data && typeof n.data === "object") {
      for (const [k, v] of Object.entries(n.data as Record<string, unknown>)) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") data[k] = v;
      }
    }
    nodes.push({ id: n.id, kind: n.kind as NodeKind, x: Number(n.x) || 0, y: Number(n.y) || 0, data });
  }
  const ids = new Set(nodes.map((n) => n.id));
  let g: Graph = { nodes, edges: [] };
  for (const e of r.edges as Record<string, unknown>[]) {
    if (!e || typeof e.id !== "string" || !ids.has(e.from as string) || !ids.has(e.to as string)) continue;
    const next = connect(g, { from: e.from as string, fromPort: String(e.fromPort), to: e.to as string, toPort: String(e.toPort) }, e.id);
    if (typeof next !== "string") g = next;
  }
  return g;
}

export function serializeGraph(g: Graph): string {
  return JSON.stringify({ version: 1, nodes: g.nodes, edges: g.edges }, null, 2);
}

// -------------------------------------------------------------- templates ----

type T = { name: string; build: (id: () => string) => Graph };

function chain(id: () => string, specs: { kind: NodeKind; data?: FlowNode["data"] }[]): Graph {
  const nodes: FlowNode[] = specs.map((s, i) => ({ id: id(), kind: s.kind, x: 40 + i * 300, y: 80 + (i % 2) * 40, data: s.data ?? {} }));
  let g: Graph = { nodes, edges: [] };
  for (let i = 0; i < nodes.length - 1; i++) {
    const out = PORTS[nodes[i].kind].outputs[0];
    const inp = PORTS[nodes[i + 1].kind].inputs[0];
    const next = connect(g, { from: nodes[i].id, fromPort: out.name, to: nodes[i + 1].id, toPort: inp.name }, id());
    if (typeof next !== "string") g = next;
  }
  return g;
}

export const TEMPLATES: T[] = [
  {
    name: "Text → 3D model",
    build: (id) => chain(id, [
      { kind: "prompt", data: { text: "a small wooden treasure chest with brass corners" } },
      { kind: "rewrite", data: { instruction: "Rewrite this as an image prompt for a single object, centred, three-quarter view, plain white background, flat even lighting. Reply with the prompt only." } },
      { kind: "image", data: { width: 512, height: 512, steps: 20, seed: -1 } },
      { kind: "to3d", data: { steps: 30, octree: 256 } },
      { kind: "preview" },
    ]),
  },
  {
    name: "Photo → 3D",
    build: (id) => chain(id, [
      { kind: "loadImage" },
      { kind: "to3d", data: { steps: 30, octree: 256 } },
      { kind: "preview" },
    ]),
  },
  {
    name: "Narrate",
    build: (id) => chain(id, [
      { kind: "prompt", data: { text: "Explain in three sentences why the sky is blue." } },
      { kind: "rewrite", data: { instruction: "Answer this as a short, friendly spoken narration. Plain sentences, no lists or markdown." } },
      { kind: "tts", data: {} },
      { kind: "preview" },
    ]),
  },
];
