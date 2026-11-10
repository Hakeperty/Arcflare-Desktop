import test from "node:test";
import assert from "node:assert/strict";
import { nextStep } from "../../src/lib/nextStep";

const info = { gpu: { freeGb: 16, totalGb: 24 }, llamaServer: "/bin/llama-server" } as any;
const loaded = { id: "qwen3", name: "Qwen3", servedId: "q", port: 1, ctx: 8192 };
const job = (state: string, extra = {}) => ({ id: "j", kind: "pull", title: "Download gemma3", state, stage: "downloading", progress: null, error: null, started: 0, ...extra }) as any;
const base = { info, loaded: null, jobs: [], setupDone: true, ready: true };

test("says nothing until the machine is known and setup is out of the way", () => {
  assert.equal(nextStep({ ...base, info: null }), null);
  assert.equal(nextStep({ ...base, ready: false }), null);
  assert.equal(nextStep({ ...base, setupDone: false }), null);
});

test("no model loaded: points at models, with the free memory when it is known", () => {
  const s = nextStep(base)!;
  assert.equal(s.view, "models");
  assert.match(s.text, /16 GB/);
  assert.equal(nextStep({ ...base, info: { ...info, gpu: { freeGb: null, totalGb: null } } })!.view, "models");
});

test("a loaded model: go and chat", () => {
  const s = nextStep({ ...base, loaded })!;
  assert.equal(s.view, "chat");
  assert.match(s.text, /Qwen3/);
});

test("a running job comes first, with its progress as a percentage", () => {
  const s = nextStep({ ...base, loaded, jobs: [job("done"), job("running", { progress: 62 })] })!;
  assert.equal(s.view, "jobs");
  assert.match(s.text, /Download gemma3 62%/);
});

test("only the newest job's failure is news", () => {
  assert.equal(nextStep({ ...base, loaded, jobs: [job("failed"), job("done")] })!.view, "jobs");
  assert.equal(nextStep({ ...base, loaded, jobs: [job("done"), job("failed")] })!.view, "chat");
});
