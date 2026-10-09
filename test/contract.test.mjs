// The IPC contract, checked statically: the renderer can only reach the main
// process through channels preload.js whitelists, and only hears events it
// whitelists. A call added to src/ without its whitelist entry or its handler
// fails silently in the app ("unknown channel" in a catch somewhere), so it's
// caught here instead.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

function walk(dir, out = []) {
  for (const f of readdirSync(join(root, dir))) {
    const p = join(dir, f);
    if (statSync(join(root, p)).isDirectory()) walk(p, out);
    else if (/\.(tsx?|jsx?)$/.test(f)) out.push(p);
  }
  return out;
}

// Pull a `new Set([...])` of string literals out of preload.js by name.
function setLiteral(src, name) {
  const m = new RegExp(`const ${name}\\s*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`).exec(src);
  assert.ok(m, `preload.js has no ${name} set`);
  return new Set([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
}

const preload = read("electron/preload.js");
const CHANNELS = setLiteral(preload, "CHANNELS");
const EVENTS = setLiteral(preload, "EVENTS");

const rendererFiles = walk("src").map((p) => ({ p, src: read(p) }));
const mainFiles = readdirSync(join(root, "electron"))
  .filter((f) => f.endsWith(".js") && f !== "preload.js")
  .map((f) => ({ p: `electron/${f}`, src: read(`electron/${f}`) }));

// Every channel the renderer invokes: call<…>("x:y", …) or invoke("x:y").
const called = new Map();
for (const { p, src } of rendererFiles) {
  for (const m of src.matchAll(/\b(?:call|invoke)\s*(?:<[^>()]*(?:<[^>]*>[^>()]*)*>)?\s*\(\s*"([a-z0-9]+:[a-zA-Z0-9]+)"/g)) {
    if (!called.has(m[1])) called.set(m[1], p);
  }
}

// Every event the renderer subscribes to: on("x:y", …).
const subscribed = new Map();
for (const { p, src } of rendererFiles) {
  for (const m of src.matchAll(/\bon\s*\(\s*"([a-z0-9]+:[a-zA-Z0-9]+)"/g)) {
    if (!subscribed.has(m[1])) subscribed.set(m[1], p);
  }
}

// What the main process handles and sends.
const mainSrc = mainFiles.map((f) => f.src).join("\n");
const handled = new Set([...mainSrc.matchAll(/\bhandle\s*\(\s*"([^"]+)"/g)].map((m) => m[1]));
const sent = new Set([
  ...[...mainSrc.matchAll(/\b(?:send|emit)\s*\(\s*"([a-z0-9]+:[a-zA-Z0-9]+)"/g)].map((m) => m[1]),
  // main.js forwards engine bus events in a `for (const ev of [...])` list.
  ...[...mainSrc.matchAll(/for\s*\(\s*const\s+ev\s+of\s+\[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1])),
]);

test("the scan finds the renderer's calls and subscriptions", () => {
  // Guards the regexes: if these drop to zero the other tests would pass vacuously.
  assert.ok(called.size >= 30, `found only ${called.size} invoked channels`);
  assert.ok(subscribed.size >= 5, `found only ${subscribed.size} subscribed events`);
  assert.ok(handled.size >= 30, `found only ${handled.size} handlers`);
});

test("every channel the UI calls is whitelisted in preload.js", () => {
  const missing = [...called].filter(([c]) => !CHANNELS.has(c)).map(([c, p]) => `${c} (called in ${p})`);
  assert.deepEqual(missing, [], "add these to CHANNELS in electron/preload.js");
});

test("every whitelisted channel has a handler in the main process", () => {
  const missing = [...CHANNELS].filter((c) => !handled.has(c));
  assert.deepEqual(missing, [], "these are whitelisted but nothing handles them (handle(\"…\") in electron/)");
});

test("every channel the UI calls is handled", () => {
  const missing = [...called].filter(([c]) => !handled.has(c)).map(([c, p]) => `${c} (called in ${p})`);
  assert.deepEqual(missing, []);
});

test("every event the UI listens to is whitelisted and actually sent", () => {
  const notListed = [...subscribed].filter(([e]) => !EVENTS.has(e)).map(([e, p]) => `${e} (in ${p})`);
  assert.deepEqual(notListed, [], "add these to EVENTS in electron/preload.js");
  const neverSent = [...subscribed].filter(([e]) => !sent.has(e)).map(([e, p]) => `${e} (in ${p})`);
  assert.deepEqual(neverSent, [], "nothing in electron/ sends these");
});

test("whitelisted events are all sent by something", () => {
  const dead = [...EVENTS].filter((e) => !sent.has(e));
  assert.deepEqual(dead, [], "whitelisted but never sent");
});
