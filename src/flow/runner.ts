// Running a flow: each node in topological order, outputs passed along edges,
// slow work done as engine jobs and waited on through "job:update" events.

import { api, on, uid, type Job, type LoadedModel } from "../lib/api";
import { downstream, inputEdge, PORTS, topoSort, type FlowNode, type Graph, type PortType } from "./graph";

/** What travels along an edge: text, or the path of a file the engine wrote. */
export type Value = { type: PortType; value: string };

export type NodeState = {
  status: "idle" | "running" | "done" | "failed" | "skipped";
  progress: number | null;
  stage?: string;
  output?: Value;
  error?: string;
  jobId?: string;
};

export type RunHooks = {
  loaded: LoadedModel | null;
  setState: (id: string, s: Partial<NodeState>) => void;
  /** The stop button: true once the person asked to stop. */
  stopped: () => boolean;
};

/** Resolve with the job's result file once it is done; reject on failure. */
export function waitForJob(jobId: string, onUpdate?: (j: Job) => void): Promise<Job> {
  return new Promise((resolve, reject) => {
    const off = on("job:update", (j: Job) => {
      if (j.id !== jobId) return;
      if (onUpdate) onUpdate(j);
      if (j.state === "done") { off(); resolve(j); }
      else if (j.state === "failed" || j.state === "cancelled") {
        off();
        reject(new Error(j.state === "cancelled" ? "cancelled" : j.error || "the job failed"));
      }
    });
  });
}

function num(v: unknown, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function str(v: unknown): string {
  return v == null ? "" : String(v);
}

async function runJob(node: FlowNode, start: Promise<Job>, hooks: RunHooks): Promise<string> {
  const job = await start;
  hooks.setState(node.id, { jobId: job.id, stage: job.stage });
  const done = await waitForJob(job.id, (j) => hooks.setState(node.id, { progress: j.progress, stage: j.stage }));
  const file = done.result && typeof done.result.file === "string" ? done.result.file : null;
  if (!file) throw new Error("the job finished without a file");
  return file;
}

/** Run one node given its inputs. Throws with a message meant for the person. */
async function runNode(node: FlowNode, inputs: Record<string, Value>, hooks: RunHooks): Promise<Value | undefined> {
  const d = node.data;
  const input = (name: string) => {
    const v = inputs[name];
    if (!v) throw new Error(`nothing connected to "${name}"`);
    return v.value;
  };
  switch (node.kind) {
    case "prompt": {
      const text = str(d.text).trim();
      if (!text) throw new Error("the prompt is empty");
      return { type: "text", value: text };
    }
    case "rewrite": {
      if (!hooks.loaded) throw new Error("load a chat model first (Models, or the Chat tab)");
      const text = input("text");
      const r = await api.chat(`flow-${uid()}`, {
        messages: [
          { role: "system", content: str(d.instruction) || "Rewrite the user's text." },
          { role: "user", content: text },
        ],
        temperature: 0.4,
        maxTokens: 600,
      });
      // Thinking models can wrap the answer; keep what follows a closing think tag.
      const out = r.text.replace(/^[\s\S]*<\/think>/, "").trim();
      if (!out) throw new Error("the chat model returned nothing");
      return { type: "text", value: out };
    }
    case "image": {
      const model = str(d.model);
      if (!model) throw new Error("pick an image model in this node");
      const seed = num(d.seed, -1);
      const file = await runJob(node, api.generateImage({
        backend: "sdcpp",
        model,
        prompt: input("prompt"),
        negative: str(d.negative) || undefined,
        width: num(d.width, 512),
        height: num(d.height, 512),
        steps: num(d.steps, 20),
        seed: seed < 0 ? undefined : seed,
        lowVram: !!d.lowVram,
      }), hooks);
      return { type: "image", value: file };
    }
    case "loadImage": {
      const p = str(d.path);
      if (!p) throw new Error("choose an image file in this node");
      return { type: "image", value: p };
    }
    case "to3d": {
      const model = str(d.model);
      if (!model) throw new Error("pick a 3D model in this node (only installed ones are listed)");
      const file = await runJob(node, api.gen3d({
        model,
        image: input("image"),
        steps: num(d.steps, 30),
        octree: num(d.octree, 256),
      }), hooks);
      return { type: "mesh", value: file };
    }
    case "tts": {
      const model = str(d.model);
      if (!model) throw new Error("pick a speech model in this node (only installed ones are listed)");
      const file = await runJob(node, api.tts({
        model,
        text: input("text"),
        voice: str(d.voice) || undefined,
        lang: str(d.lang) || undefined,
        instruct: str(d.instruct) || undefined,
      }), hooks);
      return { type: "audio", value: file };
    }
    case "preview": {
      const v = inputs.in;
      if (!v) throw new Error("connect something to preview");
      return v;
    }
  }
}

/**
 * Run the whole graph, or (with `from`) one node and everything downstream,
 * reusing `cache` for upstream outputs. A failure marks downstream nodes
 * skipped. Returns the outputs produced, merged into the cache.
 */
export async function runGraph(g: Graph, hooks: RunHooks, cache: Map<string, Value>, from?: string): Promise<Map<string, Value>> {
  const order = topoSort(g);
  if (!order) throw new Error("the flow has a loop; remove a connection to break it");
  const todo = from ? downstream(g, from) : order;
  const outputs = new Map(cache);
  const failed = new Set<string>();

  for (const id of todo) {
    hooks.setState(id, { status: "idle", progress: null, error: undefined, stage: undefined });
  }

  for (const id of todo) {
    const node = g.nodes.find((n) => n.id === id);
    if (!node) continue;
    if (hooks.stopped()) {
      hooks.setState(id, { status: "skipped", error: "stopped" });
      continue;
    }
    // Inputs from upstream outputs; a missing or failed upstream skips this node.
    const inputs: Record<string, Value> = {};
    let blocked: string | null = null;
    for (const p of PORTS[node.kind].inputs) {
      const e = inputEdge(g, id, p.name);
      if (!e) continue;
      if (failed.has(e.from)) { blocked = "an earlier node failed"; break; }
      const v = outputs.get(e.from);
      if (!v) { blocked = "an earlier node has not run — run the whole flow"; break; }
      inputs[p.name] = v;
    }
    if (blocked) {
      failed.add(id);
      hooks.setState(id, { status: "skipped", error: blocked });
      continue;
    }
    hooks.setState(id, { status: "running", progress: null });
    try {
      const out = await runNode(node, inputs, hooks);
      if (out) outputs.set(id, out);
      hooks.setState(id, { status: "done", progress: 100, output: out });
    } catch (e) {
      failed.add(id);
      hooks.setState(id, { status: "failed", error: (e as Error).message });
    }
  }
  return outputs;
}
