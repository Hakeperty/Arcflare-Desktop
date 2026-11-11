// The Markdown renderer's fence pairing. A fence that pairs wrongly turns prose
// into a code box and the code into prose for the rest of the reply.

import { test } from "node:test";
import assert from "node:assert/strict";
import { splitFences } from "../../src/ui/md";

// "P" = prose chunk, "C" = code chunk, in order
const shape = (md: string) => splitFences(md.split("\n")).map((c) => (c.code ? "C" : "P")).join("");
const codes = (md: string) => splitFences(md.split("\n")).flatMap((c) => (c.code ? [c.text] : []));

test("a plain fence is one code chunk with its language", () => {
  const c = splitFences(["before", "```ts", "a", "b", "```", "after"]);
  assert.deepEqual(c, [
    { code: false, lines: ["before"] },
    { code: true, lang: "ts", text: "a\nb" },
    { code: false, lines: ["after"] },
  ]);
});

test("a fence opened and closed on one line is not a fence", () => {
  assert.equal(shape("see ```text``` here\n```text```\nmore prose\n```\ncode\n```\nend"), "PCP");
  assert.deepEqual(codes("```text```\nprose\n```\ncode\n```"), ["code"]);
});

test("a four-backtick fence holds a three-backtick fence", () => {
  const md = "````md\n```js\nx\n```\n````\nafter";
  assert.equal(shape(md), "CP");
  assert.deepEqual(codes(md), ["```js\nx\n```"]);
});

test("an indented fence inside a list item pairs normally", () => {
  const md = "- step one\n  ```sh\n  npm i\n  ```\n- step two\n\nprose";
  assert.equal(shape(md), "PCP");
  assert.deepEqual(codes(md), ["  npm i"]);
});

test("a line with text after the backticks does not close a fence", () => {
  const md = "```md\n```js trailing\nx\n```\nafter";
  assert.equal(shape(md), "CP");
  assert.deepEqual(codes(md), ["```js trailing\nx"]);
});

test("an unterminated final fence (still streaming) runs to the end", () => {
  assert.equal(shape("intro\n```py\nprint(1)"), "PC");
  assert.deepEqual(codes("intro\n```py\nprint(1)"), ["print(1)"]);
  assert.equal(shape("```"), "C");
});
