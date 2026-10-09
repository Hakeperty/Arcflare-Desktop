// The keyword planner and the validation every model-made plan goes through.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInstruction, validatePlan } from "../../src/three/plan";
import { sanitize, describe, needsSelection, type Op } from "../../src/three/edit";

const kinds = (ops: Op[]) => ops.map((o) => o.op);

test("named colours and hex codes become a paint op", () => {
  assert.deepEqual(parseInstruction("paint it red"), [{ op: "color", hex: "#cc2a22" }]);
  assert.deepEqual(parseInstruction("make it #00ff88"), [{ op: "color", hex: "#00ff88" }]);
});

test("size words scale, and 'a bit' / 'a lot' change the amount", () => {
  const [plain] = parseInstruction("make this bigger");
  const [bit] = parseInstruction("make this a bit bigger");
  const [lot] = parseInstruction("make this a lot bigger");
  assert.equal(plain.op, "scale");
  assert.ok(plain.op === "scale" && bit.op === "scale" && lot.op === "scale");
  assert.ok(bit.factor < plain.factor && plain.factor < lot.factor);
  const [smaller] = parseInstruction("smaller please");
  assert.ok(smaller.op === "scale" && smaller.factor < 1);
});

test("'whole model' targets everything, otherwise the selection", () => {
  const [sel] = parseInstruction("make it taller");
  const [all] = parseInstruction("make the whole model taller");
  assert.ok(sel.op === "stretch" && sel.target === "selection" && sel.axis === "y");
  assert.ok(all.op === "stretch" && all.target === "all");
  assert.equal(needsSelection(sel), true);
  assert.equal(needsSelection(all), false);
});

test("several requests in one sentence give several ops", () => {
  assert.deepEqual(kinds(parseInstruction("smooth it and paint it blue")), ["color", "smooth"]);
  assert.deepEqual(kinds(parseInstruction("remove this")), ["delete"]);
});

test("rotation reads the number of degrees", () => {
  const [r] = parseInstruction("rotate it 45 degrees");
  assert.ok(r.op === "rotate" && r.degrees === 45 && r.axis === "y");
});

test("'scale up' and 'clean up' don't also move the model up", () => {
  assert.deepEqual(kinds(parseInstruction("scale up")), ["scale"]);
  assert.deepEqual(kinds(parseInstruction("clean up the surface")), ["smooth"]);
});

test("'left ear' is a part, not a direction", () => {
  assert.deepEqual(kinds(parseInstruction("make the left ear bigger")), ["scale"]);
});

test("a sentence with nothing to do gives no ops", () => {
  assert.deepEqual(parseInstruction("hello there"), []);
});

test("sanitize clamps numbers and rejects junk", () => {
  assert.deepEqual(sanitize({ op: "scale", factor: 50 }), { op: "scale", factor: 4, target: "selection" });
  assert.deepEqual(sanitize({ op: "smooth", iterations: 999 }), { op: "smooth", iterations: 20 });
  assert.deepEqual(sanitize({ op: "move", dx: "far", dy: 9 }), { op: "move", dx: 0, dy: 1, dz: 0, target: "selection" });
  assert.deepEqual(sanitize({ op: "color", hex: "ff0000" }), { op: "color", hex: "#ff0000" });
  assert.equal(sanitize({ op: "color", hex: "red" }), null);
  assert.equal(sanitize({ op: "explode" }), null);
  assert.equal(sanitize(null), null);
  assert.equal(sanitize("scale"), null);
});

test("validatePlan keeps the real ops, in order, at most eight", () => {
  assert.deepEqual(validatePlan("not a list"), []);
  assert.deepEqual(validatePlan([{ op: "nope" }, { op: "delete" }]), [{ op: "delete" }]);
  const many = Array.from({ length: 20 }, () => ({ op: "smooth", iterations: 2 }));
  assert.equal(validatePlan(many).length, 8);
});

test("every op has a human description", () => {
  const ops: Op[] = [
    { op: "scale", factor: 1.5, target: "all" }, { op: "stretch", axis: "x", factor: 2 },
    { op: "move", dx: 0, dy: 0.1, dz: 0 }, { op: "inflate", amount: -0.02 }, { op: "smooth", iterations: 3 },
    { op: "flatten", strength: 0.5 }, { op: "color", hex: "#123456" }, { op: "rotate", axis: "z", degrees: 30 },
    { op: "delete" },
  ];
  for (const o of ops) assert.ok(describe(o).length > 0, o.op);
  assert.match(describe(ops[0]), /whole model/);
  assert.match(describe(ops[3]), /^thin/);
});
