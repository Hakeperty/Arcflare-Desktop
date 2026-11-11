// Streaming helpers for the chat views.
//
// A model sends a token at a time, a few hundred a second on a fast GPU. Putting
// each one into React state on arrival re-renders the conversation per token; the
// batcher collects what arrives and hands it over once per frame instead.

export type Batch = { reasoning: string; content: string };

type Schedule = (fn: () => void) => void;
const nextFrame: Schedule = (fn) => {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => fn());
  else setTimeout(fn, 16);
};

export function createBatcher(apply: (b: Batch) => void, schedule: Schedule = nextFrame) {
  let pending: Batch = { reasoning: "", content: "" };
  let queued = false;
  let epoch = 0;
  const take = () => { const b = pending; pending = { reasoning: "", content: "" }; return b; };
  const flush = () => {
    queued = false;
    const b = take();
    if (b.reasoning || b.content) apply(b);
  };
  return {
    push(kind: string, text: string) {
      if (!text) return;
      if (kind === "reasoning") pending.reasoning += text; else pending.content += text;
      if (queued) return;
      queued = true;
      const mine = epoch;
      schedule(() => { if (mine === epoch && queued) flush(); });
    },
    /** Hand over what is waiting now (a stopped reply keeps what had arrived). */
    flush,
    /** Drop what is waiting (the final text replaces it). */
    cancel() { epoch++; queued = false; take(); },
  };
}

/** Tokens per second over the last two seconds, from one tick per streamed piece. */
export function createSpeedMeter(now: () => number = Date.now) {
  let count = 0;
  let marks: [number, number][] = [];
  return {
    tick() {
      const t = now();
      count++;
      if (!marks.length || t - marks[marks.length - 1][0] >= 200) marks.push([t, count]);
      while (marks.length > 2 && t - marks[0][0] > 2000) marks.shift();
    },
    /** null until there is half a second to measure. */
    rate(): number | null {
      if (!marks.length) return null;
      const t = now();
      const [t0, n0] = marks[0];
      return t - t0 >= 500 && count > n0 ? Math.round(((count - n0) / ((t - t0) / 1000)) * 10) / 10 : null;
    },
    count: () => count,
    reset() { count = 0; marks = []; },
  };
}
