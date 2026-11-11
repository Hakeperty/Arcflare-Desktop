// The all-sessions reader: listing across sources, and what it refuses.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const S = require("../electron/sessions.js");

const home = mkdtempSync(join(tmpdir(), "arcflare-sess-"));
const dir = join(home, "sessions");
mkdirSync(dir);
mkdirSync(join(home, "hub"));
after(() => rmSync(home, { recursive: true, force: true }));

const doc = (id, text, updated) => JSON.stringify({ id, cwd: "C:\\proj", model: "m", title: text, updated, messages: [{ role: "user", content: text }, { role: "assistant", content: "ok", tool_calls: [{ function: { name: "bash" } }] }] });
const CLI = "20261010-1000-aaaaaa", PHONE = "20261011-1000-bbbbbb", BAD = "20261012-1000-cccccc";
writeFileSync(join(dir, CLI + ".json"), doc(CLI, "from terminal", "2026-10-10T10:00:00Z"));
writeFileSync(join(dir, PHONE + ".json"), doc(PHONE, "from phone", "2026-10-11T10:00:00Z"));
writeFileSync(join(dir, BAD + ".json"), "{ not json");
writeFileSync(join(dir, "notes.json"), "{}");
writeFileSync(join(home, "hub", "agents.json"), JSON.stringify({ agents: [{ sessionId: PHONE, token: "secret" }] }));

test("lists command-line and phone sessions newest first, skipping a broken file", () => {
  const rows = S.list(home);
  assert.deepEqual(rows.map((r) => [r.source, r.id]), [["phone", PHONE], ["cli", CLI]]);
  assert.ok(!JSON.stringify(rows).includes("secret"));
});

test("reads a transcript as text and checks the source", () => {
  const t = S.read(home, "phone", PHONE);
  assert.equal(t.messages[1].text, "ok\n\n[tool: bash]");
  assert.throws(() => S.read(home, "cli", PHONE));
  assert.throws(() => S.read(home, "app", CLI));
  assert.throws(() => S.read(home, "cli", BAD));
});

test("ids with separators or ../ are refused", () => {
  for (const id of ["../hub/agents", "..\\x", `${CLI}/..`, "a/b", "", null, "20261010-1000-aaaaaa.json"]) assert.throws(() => S.read(home, "cli", id), `${id}`);
});

test("a link that points outside the sessions folder is refused", (t) => {
  const outside = join(home, "outside.json");
  writeFileSync(outside, doc("x", "secret", "2026-10-13T10:00:00Z"));
  const id = "20261013-1000-dddddd";
  try { symlinkSync(outside, join(dir, id + ".json")); }
  catch { try { symlinkSync(home, join(dir, id + ".json"), "junction"); } catch { return t.skip("cannot create a link here"); } }  // Windows without symlink rights
  assert.throws(() => S.read(home, "cli", id));
  assert.ok(!S.list(home).some((r) => r.id === id));
});
