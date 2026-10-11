// The shop's decisions, kept apart from the screen so they can be tested:
// ordering the picks, choosing a quant to recommend, and short number text.

import type { Fit, HubModel, ShopQuant } from "./api";

/** "~6 GB" → 6; null when a card doesn't say. */
export function vramGb(m: Pick<HubModel, "vram">): number | null {
  const x = /([\d.]+)\s*GB/i.exec(m.vram);
  return x ? Number(x[1]) : null;
}

export type PickSort = "best" | "small" | "new" | "name";

const FIT_RANK: Record<Fit, number> = { fits: 0, tight: 1, unknown: 2, no: 3 };

/**
 * Order the curated picks. Things you can install come before things you can't;
 * then "best" puts what fits first and, within that, the biggest (the most
 * capable model this machine can run), "small" is the other way round.
 */
export function sortPicks(models: HubModel[], sort: PickSort): HubModel[] {
  const can = (m: HubModel) => (m.plan.kind === "none" ? 1 : 0);
  const size = (m: HubModel) => vramGb(m) ?? Number.POSITIVE_INFINITY;
  const by: Record<PickSort, (a: HubModel, b: HubModel) => number> = {
    best: (a, b) => FIT_RANK[a.fit] - FIT_RANK[b.fit] || (a.fit === "no" ? size(a) - size(b) : size(b) - size(a)),
    small: (a, b) => size(a) - size(b),
    new: (a, b) => String(b.updated || "").localeCompare(String(a.updated || "")),
    name: (a, b) => a.name.localeCompare(b.name),
  };
  return [...models].sort((a, b) => can(a) - can(b) || by[sort](a, b) || a.name.localeCompare(b.name));
}

// What people reach for, in order. Q4/Q5 K-quants are the usual balance of size and quality.
const SWEET_SPOT = ["Q5_K_M", "Q4_K_M", "UD-Q4_K_XL", "Q6_K", "Q4_K_S", "Q5_K_S", "UD-Q5_K_XL", "Q8_0", "IQ4_XS", "UD-Q4_K_M", "MXFP4_MOE", "MXFP4"];

/**
 * The quant to suggest: the best-liked one that fits with room to spare, else
 * the biggest that fits, else the smallest there is (so there is always a
 * suggestion, and its fit chip says it won't be comfortable).
 */
export function recommendQuant(quants: ShopQuant[]): string | null {
  if (!quants.length) return null;
  const fits = quants.filter((q) => q.fit === "fits");
  for (const tag of SWEET_SPOT) {
    const q = fits.find((x) => x.tag.toUpperCase() === tag);
    if (q) return q.tag;
  }
  if (fits.length) return [...fits].sort((a, b) => (b.gb ?? 0) - (a.gb ?? 0))[0].tag;
  const tight = quants.filter((q) => q.fit === "tight");
  if (tight.length) return [...tight].sort((a, b) => (b.gb ?? 0) - (a.gb ?? 0))[0].tag;
  return [...quants].sort((a, b) => (a.gb ?? Infinity) - (b.gb ?? Infinity))[0].tag;
}

/** 1234 → "1.2K", 1_500_000 → "1.5M". */
export function fmtCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "–";
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0).replace(/\.0$/, "")}K`;
  if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0).replace(/\.0$/, "")}M`;
  return `${(n / 1e9).toFixed(1).replace(/\.0$/, "")}B`;
}

/** "3 days ago" for an ISO date; "" when there isn't one. */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "";
  const d = Math.max(0, (now - t) / 86400000);
  if (d < 1) return "today";
  if (d < 2) return "yesterday";
  if (d < 30) return `${Math.floor(d)} days ago`;
  if (d < 365) return `${Math.floor(d / 30)} mo ago`;
  return `${Math.floor(d / 365)} y ago`;
}

/** The fit chip's words. */
export const FIT_TEXT: Record<Fit, string> = { fits: "fits", tight: "tight", no: "too big", unknown: "?" };

/**
 * The size a repo's name advertises: "Llama-3.1-8B-Instruct-GGUF" → "8B",
 * "Mixtral-8x7B-…" → "8x7B", "…-30B-A3B-…" → "30B". Active-parameter tags
 * (A3B) and quant tags (Q4_K_M) are not sizes. null when the name has none.
 */
export function paramsFromName(name: string): string | null {
  const m = /(?:^|[-_.\s])(\d+x)?(\d+(?:\.\d+)?)([BM])(?=$|[-_.\s])/i.exec(name);
  return m ? `${m[1] ?? ""}${m[2]}${m[3].toUpperCase()}` : null;
}

/** Hugging Face's task names in a word a person would use. */
export function taskLabel(task: string | null | undefined): string | null {
  if (!task) return null;
  const known: Record<string, string> = {
    "text-generation": "chat",
    "image-text-to-text": "vision",
    "any-to-any": "multimodal",
    "feature-extraction": "embedding",
    "sentence-similarity": "embedding",
    "text-to-speech": "speech",
    "automatic-speech-recognition": "speech to text",
    "text-ranking": "reranker",
  };
  return known[task] ?? task.replace(/-/g, " ");
}
