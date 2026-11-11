import { test } from "node:test";
import assert from "node:assert/strict";
import { startersFor } from "../../src/lib/starters";

test("a coding model is offered coding questions, others everyday ones", () => {
  const code = startersFor("qwen3-coder-30b:q4_k_m");
  const chat = startersFor("gemma3-12b:q4_k_m");
  assert.notDeepEqual(code, chat);
  assert.deepEqual(startersFor("devstral2-small"), code);
  assert.deepEqual(startersFor("llama3.2"), chat);
  assert.equal(code.length, 4);
  assert.equal(chat.length, 4);
});
