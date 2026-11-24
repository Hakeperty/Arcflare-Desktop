// Replies and events that land out of order must not put older state on screen.

import test from "node:test";
import assert from "node:assert/strict";
import { follow, tickets } from "../../src/lib/order";

function source<T>() {
  let fn: ((x: T) => void) | null = null;
  let answer!: (x: T | undefined) => void;
  const read = () => new Promise<T | undefined>((r) => { answer = r; });
  const subscribe = (f: (x: T) => void) => { fn = f; return () => { fn = null; }; };
  return { read, subscribe, emit: (x: T) => fn?.(x), answer: (x: T | undefined) => answer(x) };
}
const tick = () => new Promise((r) => setImmediate(r));

test("follow: the first read shows when no event came first", async () => {
  const s = source<number>(); const got: number[] = [];
  follow(s.subscribe, s.read, (x) => got.push(x));
  s.answer(1); await tick();
  s.emit(2);
  assert.deepEqual(got, [1, 2]);
});

test("follow: a read that lands after an event is dropped", async () => {
  const s = source<number>(); const got: number[] = [];
  follow(s.subscribe, s.read, (x) => got.push(x));
  s.emit(2);
  s.answer(1); await tick();
  assert.deepEqual(got, [2]);
});

test("follow: nothing applies after unsubscribing, and a missing read is skipped", async () => {
  const a = source<number>(); const got: number[] = [];
  follow(a.subscribe, a.read, (x) => got.push(x))();
  a.answer(1); a.emit(2); await tick();
  const b = source<number>();
  follow(b.subscribe, b.read, (x) => got.push(x));
  b.answer(undefined); await tick();
  assert.deepEqual(got, []);
});

test("tickets: a slow older read is dropped once a newer one was started", () => {
  const take = tickets();
  const older = take();
  assert.equal(older(), true);
  const newer = take();
  assert.equal(older(), false);   // lands late: must not replace what the newer read shows
  assert.equal(newer(), true);
});

test("tickets, as the Store uses them: a refresh is shown during a hung add, dropped once an add lands", () => {
  const shown = tickets();
  const refreshDuringHungAdd = shown();
  assert.equal(refreshDuringHungAdd(), true);
  const refresh = shown();
  shown();                         // the add lands with the list after it
  assert.equal(refresh(), false);  // the refresh's older list must not undo the add
});
