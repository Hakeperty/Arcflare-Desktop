// The macOS afterSign hook: ad-hoc signs only when no real certificate is set,
// only on macOS, and never fails the build.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const hook = createRequire(import.meta.url)(join(dirname(fileURLToPath(import.meta.url)), "..", "build", "adhoc-sign.js"));
const ctx = (platform) => ({ electronPlatformName: platform, appOutDir: "/out/mac-arm64", packager: { appInfo: { productFilename: "ArcFlare" } } });
const quiet = { log() {}, warn() {} };

let saved;
beforeEach(() => { saved = { l: process.env.CSC_LINK, n: process.env.CSC_NAME }; delete process.env.CSC_LINK; delete process.env.CSC_NAME; });
afterEach(() => {
  for (const [k, v] of [["CSC_LINK", saved.l], ["CSC_NAME", saved.n]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

test("with no certificate, the mac app gets an ad-hoc signature", async () => {
  const calls = [];
  await hook(ctx("darwin"), (...a) => calls.push(a), quiet);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), ["codesign", ["--force", "--deep", "--sign", "-", "/out/mac-arm64/ArcFlare.app"]]);
});

test("with a real certificate configured, it leaves electron-builder's signature alone", async () => {
  process.env.CSC_LINK = "base64-of-a-p12";
  const calls = [];
  await hook(ctx("darwin"), (...a) => calls.push(a), quiet);
  assert.equal(calls.length, 0);
});

test("it does nothing for Windows and Linux builds", async () => {
  const calls = [];
  await hook(ctx("win32"), (...a) => calls.push(a), quiet);
  await hook(ctx("linux"), (...a) => calls.push(a), quiet);
  assert.equal(calls.length, 0);
});

test("a codesign failure is a warning, not a failed build", async () => {
  const warned = [];
  await hook(ctx("darwin"), () => { throw new Error("codesign: not found"); }, { log() {}, warn: (m) => warned.push(m) });
  assert.match(warned[0], /could not ad-hoc sign ArcFlare\.app: codesign: not found/);
});
