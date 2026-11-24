// Running a flow: stop must be able to end a rewrite node's chat request, so
// the node reports its chat id while it runs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runGraph, type NodeState } from "../../src/flow/runner";
import type { Graph } from "../../src/flow/graph";

test("a running rewrite node exposes its chat id, and stopping that chat fails the node", async () => {
  const pending = new Map<string, (r: { ok: boolean; error?: string; value?: unknown }) => void>();
  (globalThis as any).window = {
    arc: {
      platform: "linux",
      on: () => () => {},
      invoke: (channel: string, id: string) => {
        if (channel === "chat:send") return new Promise((resolve) => pending.set(id, resolve));
        if (channel === "chat:stop") { pending.get(id)?.({ ok: false, error: "stopped" }); return Promise.resolve({ ok: true }); }
        throw new Error(`unexpected ${channel}`);
      },
    },
  };
  const g: Graph = {
    nodes: [
      { id: "p", kind: "prompt", x: 0, y: 0, data: { text: "a cat" } },
      { id: "r", kind: "rewrite", x: 0, y: 0, data: {} },
    ],
    edges: [{ id: "e", from: "p", fromPort: "text", to: "r", toPort: "text" }],
  };
  const states: Record<string, Partial<NodeState>> = {};
  const done = runGraph(g, {
    loaded: { id: "m", name: "m" } as any,
    stopped: () => false,
    setState: (id, s) => { states[id] = { ...states[id], ...s }; },
  }, new Map());
  for (let i = 0; i < 50 && !states.r?.chatId; i++) await new Promise((r) => setTimeout(r, 1));
  assert.ok(states.r?.chatId, "rewrite node did not report its chat id");
  await (globalThis as any).window.arc.invoke("chat:stop", states.r!.chatId);
  await done;
  assert.equal(states.r?.status, "failed");
  assert.equal(states.r?.error, "stopped");
});
