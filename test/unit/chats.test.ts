import { test } from "node:test";
import assert from "node:assert/strict";
import { filterConvos, convoToMarkdown } from "../../src/lib/chats";

const cs = [
  { title: "Pasta ideas", turns: [{ role: "user", content: "What is carbonara?" }] },
  { title: "Taxes", turns: [{ role: "user", content: "hello" }] },
];

test("filterConvos matches title and message text", () => {
  assert.equal(filterConvos(cs, "").length, 2);
  assert.deepEqual(filterConvos(cs, "PASTA").map((c) => c.title), ["Pasta ideas"]);
  assert.deepEqual(filterConvos(cs, "hello").map((c) => c.title), ["Taxes"]);
  assert.equal(filterConvos(cs, "nothing").length, 0);
});

test("convoToMarkdown skips reasoning and names the model", () => {
  const md = convoToMarkdown({ title: "T", turns: [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello", reasoning: "secret" } as { role: string; content: string },
  ] }, "Qwen");
  assert.equal(md, "# T\n\n**You**\n\nhi\n\n**Qwen**\n\nhello\n");
  assert.ok(!md.includes("secret"));
  assert.ok(convoToMarkdown({ title: "T", turns: [{ role: "assistant", content: "x" }] }).includes("**Assistant**"));
});
