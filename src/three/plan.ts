// From words to operations. The chat model does it when one is loaded (it
// understands "make the left ear a bit pointier"); this keyword parser is the
// floor when none is, and handles the plain requests people type most.

import { sanitize, type Op } from "./edit";

const COLOURS: Record<string, string> = {
  red: "#cc2a22", green: "#2f9e44", blue: "#2563eb", yellow: "#f2c200", orange: "#f08c00", purple: "#7c3aed",
  pink: "#e64980", black: "#151515", white: "#f2f2f2", grey: "#8a8a8a", gray: "#8a8a8a", brown: "#7a4a24",
  gold: "#c9a227", silver: "#b8bcc2", cyan: "#22b8cf", teal: "#0f9488", beige: "#d8c8a8", wood: "#8b5a2b",
};

/** Keyword fallback. Returns [] when nothing in the sentence maps to an op. */
export function parseInstruction(text: string): Op[] {
  const s = ` ${text.toLowerCase()} `;
  const all = /\b(whole|entire|everything|all of it|the model|whole model)\b/.test(s) ? "all" as const : "selection" as const;
  // "a bit" halves the amount, "a lot" doubles it.
  const k = /\b(a bit|slightly|a little|tiny|subtle|subtly)\b/.test(s) ? 0.5 : /\b(a lot|much|way|very|really|huge|massively)\b/.test(s) ? 2 : 1;
  const ops: unknown[] = [];

  const hex = /#([0-9a-f]{6})\b/i.exec(s);
  const named = Object.keys(COLOURS).find((c) => new RegExp(`\\b${c}\\b`).test(s));
  if (/\b(paint|colou?r|make it|turn it)\b/.test(s) && (hex || named)) ops.push({ op: "color", hex: hex ? `#${hex[1]}` : COLOURS[named!] });
  else if (hex || (named && /\b(paint|colou?r)\b/.test(s))) ops.push({ op: "color", hex: hex ? `#${hex[1]}` : COLOURS[named!] });

  if (/\b(remove|delete|cut off|get rid of|erase)\b/.test(s)) ops.push({ op: "delete" });
  if (/\b(smooth|soften|clean up|less bumpy|polish)\b/.test(s)) ops.push({ op: "smooth", iterations: Math.round(3 * k) || 1 });
  if (/\b(flatten|flat|level)\b/.test(s)) ops.push({ op: "flatten", strength: Math.min(1, 0.7 * k) });
  if (/\b(puff|inflate|fatter|thicker|rounder|chunkier)\b/.test(s)) ops.push({ op: "inflate", amount: 0.02 * k });
  if (/\b(thinner|slimmer|deflate|skinnier)\b/.test(s)) ops.push({ op: "inflate", amount: -0.015 * k });

  if (/\b(taller|longer|stretch|lengthen|extend)\b/.test(s)) {
    const axis = /\b(wider|sideways|horizontal)\b/.test(s) ? "x" : /\b(deeper|forward)\b/.test(s) ? "z" : "y";
    ops.push({ op: "stretch", axis, factor: 1 + 0.3 * k, target: all });
  } else if (/\b(shorter)\b/.test(s)) {
    ops.push({ op: "stretch", axis: "y", factor: 1 / (1 + 0.25 * k), target: all });
  } else if (/\b(wider|broader)\b/.test(s)) {
    ops.push({ op: "stretch", axis: "x", factor: 1 + 0.3 * k, target: all });
  } else if (/\b(narrower)\b/.test(s)) {
    ops.push({ op: "stretch", axis: "x", factor: 1 / (1 + 0.25 * k), target: all });
  } else if (/\b(bigger|larger|enlarge|grow|scale up|increase)\b/.test(s)) {
    ops.push({ op: "scale", factor: 1 + 0.25 * k, target: all });
  } else if (/\b(smaller|shrink|reduce|scale down|tinier)\b/.test(s)) {
    ops.push({ op: "scale", factor: 1 / (1 + 0.25 * k), target: all });
  }

  const step = 0.05 * k;
  if (/\b(up|raise|lift|higher)\b/.test(s) && !/\b(clean up|scale up)\b/.test(s)) ops.push({ op: "move", dx: 0, dy: step, dz: 0, target: all });
  if (/\b(down|lower|drop)\b/.test(s) && !/\bscale down\b/.test(s)) ops.push({ op: "move", dx: 0, dy: -step, dz: 0, target: all });
  if (/\bleft\b/.test(s) && !/\bleft (ear|arm|leg|eye|hand|side)\b/.test(s)) ops.push({ op: "move", dx: -step, dy: 0, dz: 0, target: all });
  if (/\bright\b/.test(s) && !/\bright (ear|arm|leg|eye|hand|side)\b/.test(s)) ops.push({ op: "move", dx: step, dy: 0, dz: 0, target: all });
  if (/\b(forward|towards me|toward me)\b/.test(s)) ops.push({ op: "move", dx: 0, dy: 0, dz: step, target: all });
  if (/\b(back|backward|away)\b/.test(s)) ops.push({ op: "move", dx: 0, dy: 0, dz: -step, target: all });

  const rot = /\b(rotate|turn|spin)\b.*?(-?\d+)\s*(°|deg|degrees)?/.exec(s);
  if (rot) ops.push({ op: "rotate", axis: /\b(tilt|pitch)\b/.test(s) ? "x" : "y", degrees: Number(rot[2]), target: all });
  else if (/\b(rotate|turn|spin)\b/.test(s)) ops.push({ op: "rotate", axis: "y", degrees: 15 * k, target: all });

  return ops.map(sanitize).filter((o): o is Op => o !== null);
}

/** Validate a model's plan: keep the ops that are real and in range. */
export function validatePlan(raw: unknown): Op[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(sanitize).filter((o): o is Op => o !== null).slice(0, 8);
}
