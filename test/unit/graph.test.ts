// The flow graph: typed connections, loops, run order, saving and loading.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  connect, removeNode, removeEdge, topoSort, hasCycle, downstream, inputEdge,
  parseGraph, serializeGraph, compatible, portType, TEMPLATES, PORTS,
  type Graph, type FlowNode,
} from "../../src/flow/graph";
import { fileUrl, uid } from "../../src/lib/api";

const node = (id: string, kind: FlowNode["kind"], x = 0, y = 0): FlowNode => ({ id, kind, x, y, data: {} });

function chain(): Graph {
  let g: Graph = { nodes: [node("p", "prompt", 0), node("r", "rewrite", 300), node("i", "image", 600), node("v", "preview", 900)], edges: [] };
  for (const [from, fromPort, to, toPort, id] of [
    ["p", "text", "r", "text", "e1"], ["r", "text", "i", "prompt", "e2"], ["i", "image", "v", "in", "e3"],
  ] as const) {
    const next = connect(g, { from, fromPort, to, toPort }, id);
    assert.equal(typeof next, "object", `connect ${id}`);
    g = next as Graph;
  }
  return g;
}

test("ports: same types connect, 'any' accepts everything", () => {
  assert.equal(compatible("text", "text"), true);
  assert.equal(compatible("image", "any"), true);
  assert.equal(compatible("text", "image"), false);
  assert.equal(portType("to3d", "image", "in"), "image");
  assert.equal(portType("to3d", "nope", "in"), null);
});

test("connect rejects wrong types, missing ports and self-loops", () => {
  const g: Graph = { nodes: [node("p", "prompt"), node("t", "to3d")], edges: [] };
  assert.match(connect(g, { from: "p", fromPort: "text", to: "t", toPort: "image" }, "x") as string, /text output cannot go into a image/);
  assert.equal(connect(g, { from: "p", fromPort: "zzz", to: "t", toPort: "image" }, "x"), "missing port");
  assert.equal(connect(g, { from: "p", fromPort: "text", to: "p", toPort: "text" }, "x"), "a node cannot feed itself");
  assert.equal(connect(g, { from: "p", fromPort: "text", to: "ghost", toPort: "in" }, "x"), "missing node");
});

test("a new edge into an input replaces the old one", () => {
  let g = chain();
  g = { ...g, nodes: [...g.nodes, node("p2", "prompt", 0, 200)] };
  const next = connect(g, { from: "p2", fromPort: "text", to: "r", toPort: "text" }, "e9") as Graph;
  assert.equal(next.edges.filter((e) => e.to === "r").length, 1);
  assert.equal(inputEdge(next, "r", "text")?.from, "p2");
});

test("loops are refused", () => {
  // rewrite -> rewrite chain, then try to close it.
  let g: Graph = { nodes: [node("a", "rewrite"), node("b", "rewrite", 300)], edges: [] };
  g = connect(g, { from: "a", fromPort: "text", to: "b", toPort: "text" }, "e1") as Graph;
  assert.equal(connect(g, { from: "b", fromPort: "text", to: "a", toPort: "text" }, "e2"), "that connection would make a loop");
  assert.equal(hasCycle(g), false);
  assert.equal(topoSort({ ...g, edges: [...g.edges, { id: "e2", from: "b", fromPort: "text", to: "a", toPort: "text" }] }), null);
});

test("run order follows the edges, ties broken left to right", () => {
  const g = chain();
  assert.deepEqual(topoSort(g), ["p", "r", "i", "v"]);
  const free: Graph = { nodes: [node("b", "prompt", 500), node("a", "prompt", 100)], edges: [] };
  assert.deepEqual(topoSort(free), ["a", "b"]);
});

test("downstream is a node and everything after it", () => {
  const g = chain();
  assert.deepEqual(downstream(g, "r"), ["r", "i", "v"]);
  assert.deepEqual(downstream(g, "v"), ["v"]);
});

test("removing a node takes its edges with it", () => {
  const g = removeNode(chain(), "r");
  assert.equal(g.nodes.length, 3);
  assert.ok(g.edges.every((e) => e.from !== "r" && e.to !== "r"));
  assert.equal(removeEdge(chain(), "e3").edges.length, 2);
});

test("save and load round-trip", () => {
  const g = chain();
  g.nodes[0].data = { text: "a chest", steps: 20, fast: true };
  const back = parseGraph(serializeGraph(g))!;
  assert.deepEqual(back.nodes, g.nodes);
  assert.deepEqual(back.edges.map((e) => e.id).sort(), g.edges.map((e) => e.id).sort());
});

test("loading drops malformed parts instead of failing", () => {
  assert.equal(parseGraph("{not json"), null);
  assert.equal(parseGraph("[]"), null);
  const g = parseGraph(JSON.stringify({
    nodes: [
      { id: "p", kind: "prompt", x: "12", data: { text: "hi", bad: { nested: 1 } } },
      { id: "x", kind: "rocket" },
      { kind: "prompt" },
      { id: "i", kind: "image" },
    ],
    edges: [
      { id: "ok", from: "p", fromPort: "text", to: "i", toPort: "prompt" },
      { id: "ghost", from: "x", fromPort: "text", to: "i", toPort: "prompt" },
      { id: "badtype", from: "i", fromPort: "image", to: "p", toPort: "text" },
    ],
  }))!;
  assert.deepEqual(g.nodes.map((n) => n.id), ["p", "i"]);
  assert.equal(g.nodes[0].x, 12);
  assert.deepEqual(g.nodes[0].data, { text: "hi" });
  assert.deepEqual(g.edges.map((e) => e.id), ["ok"]);
});

test("every template builds a connected graph with no loops", () => {
  let n = 0;
  const id = () => `n${n++}`;
  for (const t of TEMPLATES) {
    const g = t.build(id);
    assert.ok(g.nodes.length >= 2, t.name);
    assert.equal(g.edges.length, g.nodes.length - 1, `${t.name}: a chain`);
    assert.equal(hasCycle(g), false, t.name);
    for (const nd of g.nodes) assert.ok(PORTS[nd.kind], nd.kind);
  }
});

test("api helpers: arcfile URLs encode the path; ids are short and distinct", () => {
  assert.equal(fileUrl("C:\\a b\\x.png"), "arcfile://local/?p=C%3A%5Ca%20b%5Cx.png");
  assert.equal(fileUrl("/tmp/x.glb", 7), "arcfile://local/?p=%2Ftmp%2Fx.glb&v=7");
  const ids = new Set(Array.from({ length: 200 }, uid));
  assert.ok(ids.size > 195);
  for (const i of ids) assert.match(i, /^[a-z0-9]{1,8}$/);
});
