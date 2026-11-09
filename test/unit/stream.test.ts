import { test } from "node:test";
import assert from "node:assert/strict";
import { createBatcher, createSpeedMeter } from "../../src/lib/stream";

test("batcher: many deltas become one hand-over per frame, in order, split by kind", () => {
  const frames: (() => void)[] = [];
  const got: { reasoning: string; content: string }[] = [];
  const b = createBatcher((x) => got.push(x), (fn) => frames.push(fn));
  b.push("reasoning", "hm ");
  b.push("content", "Hel");
  b.push("content", "lo");
  assert.equal(frames.length, 1, "one frame asked for");
  assert.equal(got.length, 0, "nothing applied before the frame");
  frames.shift()!();
  assert.deepEqual(got, [{ reasoning: "hm ", content: "Hello" }]);
  b.push("content", "!");
  frames.shift()!();
  assert.deepEqual(got[1], { reasoning: "", content: "!" });
});

test("batcher: flush hands over at once; cancel drops what waits and the late frame does nothing", () => {
  const frames: (() => void)[] = [];
  const got: string[] = [];
  const b = createBatcher((x) => got.push(x.content), (fn) => frames.push(fn));
  b.push("content", "kept");
  b.flush();
  assert.deepEqual(got, ["kept"]);
  frames.shift()!(); // the frame that was already asked for
  assert.deepEqual(got, ["kept"], "not applied twice");
  b.push("content", "dropped");
  b.cancel();
  b.push("content", "next");
  frames.shift()!(); // the cancelled frame
  assert.deepEqual(got, ["kept"], "a cancelled frame must not flush the next reply early");
  frames.shift()!();
  assert.deepEqual(got, ["kept", "next"]);
});

test("speed meter: the pace of the last two seconds", () => {
  let t = 0;
  const m = createSpeedMeter(() => t);
  assert.equal(m.rate(), null);
  for (let i = 0; i < 100; i++) { t += 20; m.tick(); } // 50 tok/s for 2 s
  assert.equal(m.rate(), 50);
  for (let i = 0; i < 20; i++) { t += 100; m.tick(); } // slows to 10 tok/s for 2 s
  const r = m.rate()!;
  assert.ok(r >= 9 && r <= 12, "follows the slowdown, got " + r);
  assert.equal(m.count(), 120);
});
