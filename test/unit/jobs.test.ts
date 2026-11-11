// Following a job from the renderer: a job that finished before anyone was
// listening must still be seen (it used to leave a flow "running" forever and
// a failed generation with no message).

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Job } from "../../src/lib/api";
import { waitForJob, watchJob } from "../../src/lib/jobs";

const job = (id: string, state: Job["state"], extra: Partial<Job> = {}): Job => ({
  id, kind: "image", title: "t", state, stage: "s", progress: null, log: [], result: null, error: null, started: 1, ...extra,
});

// A stand-in for preload.js: jobs:list answers from `current`, events go to listeners.
let current: Job[] = [];
let listeners = new Set<(j: Job) => void>();
let listCalls = 0;
const emit = (j: Job) => listeners.forEach((fn) => fn(j));

beforeEach(() => {
  current = []; listeners = new Set(); listCalls = 0;
  (globalThis as any).window = {
    arc: {
      platform: "linux",
      invoke: async (channel: string) => {
        assert.equal(channel, "jobs:list");
        listCalls++;
        return { ok: true, value: current };
      },
      on: (event: string, fn: (j: Job) => void) => {
        assert.equal(event, "job:update");
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    },
  };
});

test("a job that failed before anyone listened rejects instead of hanging", async () => {
  current = [job("job1", "failed", { error: "stable-diffusion.cpp not found" })];
  await assert.rejects(waitForJob("job1"), /stable-diffusion\.cpp not found/);
  assert.equal(listeners.size, 0, "the listener is removed once the job is settled");
});

test("a job that finished before anyone listened resolves with its result", async () => {
  current = [job("job1", "done", { result: { file: "/tmp/a.png" } })];
  const j = await waitForJob("job1");
  assert.equal(j.result?.file, "/tmp/a.png");
});

test("a cancelled job rejects as cancelled", async () => {
  current = [job("job1", "cancelled")];
  await assert.rejects(waitForJob("job1"), /^Error: cancelled$/);
});

test("a running job is followed through its events, ignoring other jobs", async () => {
  current = [job("job1", "running")];
  const seen: (number | null)[] = [];
  const p = waitForJob("job1", (j) => seen.push(j.progress));
  await new Promise((r) => setTimeout(r, 0));
  emit(job("job2", "failed", { error: "not this one" }));
  emit(job("job1", "running", { progress: 50 }));
  emit(job("job1", "done", { progress: 100, result: { file: "/tmp/b.png" } }));
  const j = await p;
  assert.equal(j.result?.file, "/tmp/b.png");
  assert.deepEqual(seen, [null, 50, 100]);
});

test("an event that arrives before the snapshot wins over it", async () => {
  current = [job("job1", "running")];
  const states: string[] = [];
  const off = watchJob("job1", (j) => states.push(j.state));
  emit(job("job1", "done"));           // before jobs:list has answered
  await new Promise((r) => setTimeout(r, 0));
  off();
  assert.deepEqual(states, ["done"]);
  assert.equal(listCalls, 1);
});

test("nothing is delivered after unsubscribing", async () => {
  current = [job("job1", "running")];
  const states: string[] = [];
  const off = watchJob("job1", (j) => states.push(j.state));
  off();
  await new Promise((r) => setTimeout(r, 0));
  emit(job("job1", "done"));
  assert.deepEqual(states, []);
});
