import { test } from "node:test";
import assert from "node:assert/strict";
import { ago, fmtCount, paramsFromName, recommendQuant, sortPicks, taskLabel, vramGb } from "../../src/lib/shop";
import type { Fit, HubModel, ShopQuant } from "../../src/lib/api";

const pick = (slug: string, vram: string, fit: Fit, extra: Partial<HubModel> = {}): HubModel => ({
  slug, name: slug, author: "x", description: "", category: "Chat", tags: [], license: "MIT", commercial: true,
  defaultSize: "", vram, run: "", runnable: true, featured: false, url: "", fit,
  plan: { kind: "pull", ref: `a/${slug}:Q4_K_M` }, ...extra,
});
const q = (tag: string, gb: number, fit: Fit): ShopQuant => ({ tag, gb, shards: 1, fit, downloaded: false });

test("vramGb reads '~6 GB' and says null when there is no number", () => {
  assert.equal(vramGb({ vram: "~6 GB" }), 6);
  assert.equal(vramGb({ vram: "~0.5 GB" }), 0.5);
  assert.equal(vramGb({ vram: "—" }), null);
});

test("'best' puts the biggest model that fits first, then tight, then too big (smallest first)", () => {
  const list = [
    pick("tiny", "~1 GB", "fits"), pick("big", "~10 GB", "fits"), pick("edge", "~15 GB", "tight"),
    pick("huge", "~200 GB", "no"), pick("large", "~40 GB", "no"),
  ];
  assert.deepEqual(sortPicks(list, "best").map((m) => m.slug), ["big", "tiny", "edge", "large", "huge"]);
});

test("things with no install command always come after things you can install", () => {
  const list = [
    pick("placeholder", "~1 GB", "fits", { plan: { kind: "none" } }),
    pick("real", "~9 GB", "fits"),
  ];
  for (const s of ["best", "small", "new", "name"] as const) {
    assert.deepEqual(sortPicks(list, s).map((m) => m.slug), ["real", "placeholder"], s);
  }
});

test("other sorts: smallest, newest, name; the input is not changed", () => {
  const list = [pick("b", "~5 GB", "fits", { updated: "2025-01-01" }), pick("a", "~9 GB", "fits", { updated: "2026-01-01" }), pick("c", "—", "unknown")];
  const before = list.map((m) => m.slug);
  assert.deepEqual(sortPicks(list, "small").map((m) => m.slug), ["b", "a", "c"]);
  assert.deepEqual(sortPicks(list, "new").map((m) => m.slug), ["a", "b", "c"]);
  assert.deepEqual(sortPicks(list, "name").map((m) => m.slug), ["a", "b", "c"]);
  assert.deepEqual(list.map((m) => m.slug), before);
});

test("recommendQuant prefers the usual sweet spot among what fits", () => {
  assert.equal(recommendQuant([q("Q8_0", 8, "fits"), q("Q4_K_M", 4.5, "fits"), q("Q2_K", 2.8, "fits")]), "Q4_K_M");
  assert.equal(recommendQuant([q("Q5_K_M", 5.5, "fits"), q("Q4_K_M", 4.5, "fits")]), "Q5_K_M");
  // The sweet spot doesn't fit: the best that does.
  assert.equal(recommendQuant([q("Q4_K_M", 20, "no"), q("IQ2_M", 7, "fits"), q("IQ1_S", 5, "fits")]), "IQ2_M");
});

test("recommendQuant always has an answer, even when nothing fits", () => {
  assert.equal(recommendQuant([q("Q4_K_M", 20, "tight"), q("Q2_K", 9, "tight")]), "Q4_K_M");
  assert.equal(recommendQuant([q("Q4_K_M", 40, "no"), q("Q2_K", 18, "no")]), "Q2_K");
  assert.equal(recommendQuant([]), null);
});

test("fmtCount keeps numbers short", () => {
  assert.deepEqual([0, 999, 1200, 15000, 1_500_000, 23_000_000, 4_100_000_000].map(fmtCount), ["0", "999", "1.2K", "15K", "1.5M", "23M", "4.1B"]);
  assert.equal(fmtCount(-1), "–");
});

test("ago says how long, and nothing for a missing date", () => {
  const now = Date.parse("2026-10-11T12:00:00Z");
  assert.equal(ago("2026-10-11T08:00:00Z", now), "today");
  assert.equal(ago("2026-10-10T08:00:00Z", now), "yesterday");
  assert.equal(ago("2026-10-01T00:00:00Z", now), "10 days ago");
  assert.equal(ago("2026-05-01T00:00:00Z", now), "5 mo ago");
  assert.equal(ago("2024-01-01T00:00:00Z", now), "2 y ago");
  assert.equal(ago(null, now), "");
  assert.equal(ago("not a date", now), "");
});

test("paramsFromName finds the size in a repo name, not a quant or active-parameter tag", () => {
  assert.equal(paramsFromName("Llama-3.1-8B-Instruct-GGUF"), "8B");
  assert.equal(paramsFromName("Mixtral-8x7B-Instruct-v0.1-GGUF"), "8x7B");
  assert.equal(paramsFromName("Qwen3-30B-A3B-GGUF"), "30B");
  assert.equal(paramsFromName("gemma-3-270m-it-GGUF"), "270M");
  assert.equal(paramsFromName("Llama-3.2-3B-Instruct-Q4_K_M-GGUF"), "3B");
  assert.equal(paramsFromName("Phi-4-mini-instruct-GGUF"), null);
});

test("taskLabel uses plain words", () => {
  assert.equal(taskLabel("text-generation"), "chat");
  assert.equal(taskLabel("image-text-to-text"), "vision");
  assert.equal(taskLabel("feature-extraction"), "embedding");
  assert.equal(taskLabel("some-new-task"), "some new task");
  assert.equal(taskLabel(null), null);
});
