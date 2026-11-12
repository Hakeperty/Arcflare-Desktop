import { test } from "node:test";
import assert from "node:assert/strict";
import { filterPalette } from "../../src/lib/palette";

const items = [
  { id: "home", label: "Go to home" },
  { id: "chat", label: "Go to chat" },
  { id: "new", label: "New chat" },
  { id: "models", label: "Go to models" },
];

test("empty query keeps everything in order", () => {
  assert.deepEqual(filterPalette(items, "  ").map((i) => i.id), ["home", "chat", "new", "models"]);
});

test("every word must match, case-insensitive", () => {
  assert.deepEqual(filterPalette(items, "GO chat").map((i) => i.id), ["chat"]);
  assert.deepEqual(filterPalette(items, "zzz"), []);
});

test("label-start matches rank first", () => {
  const list = [{ id: "a", label: "Go to chat" }, { id: "b", label: "Chat now" }, { id: "c", label: "Rechat" }];
  assert.deepEqual(filterPalette(list, "chat").map((i) => i.id), ["b", "a", "c"]);
});
