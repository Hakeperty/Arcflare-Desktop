// Mesh editing on a real (tiny) three.js mesh: welding, selection, ops, undo.
// No WebGL needed: everything here is geometry and typed arrays.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  prepareParts, apply, selectAll, clearSelection, growSelection, hasSelection,
  snapshot, restore, stats, type Part,
} from "../../src/three/edit";

// A cube as the generators deliver it untextured: split per-face corners and
// normals, no UVs.
function box(withUv = false): { root: THREE.Group; parts: Part[] } {
  const root = new THREE.Group();
  const g = new THREE.BoxGeometry(1, 1, 1);
  if (!withUv) g.deleteAttribute("uv");
  root.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: "#808080" })));
  root.updateMatrixWorld(true);
  return { root, parts: prepareParts(root) };
}

const bounds = (p: Part) => { p.geom.computeBoundingBox(); return p.geom.boundingBox!.clone(); };

test("prepareParts welds a box's split corners into 8 shared vertices", () => {
  const { parts } = box();
  assert.equal(parts.length, 1);
  assert.equal(parts[0].geom.getAttribute("position").count, 8);
  assert.deepEqual(stats(parts), { faces: 12, verts: 8 });
  // Every corner of a cube touches the others through faces.
  for (const nb of parts[0].neighbours) assert.ok(nb.length >= 3);
  // Paint starts from the material colour.
  assert.ok(Math.abs(parts[0].paint[0] - new THREE.Color("#808080").r) < 1e-6);
});

test("with UVs, welding stops at UV seams (known limit: textured meshes keep seam splits)", () => {
  // mergeVertices compares every attribute, so corners whose UVs differ stay
  // separate. Recorded here so a change to this behaviour is noticed.
  const { parts } = box(true);
  assert.ok(parts[0].geom.getAttribute("position").count > 8);
});

test("selection: all, clear, grow", () => {
  const { parts } = box();
  assert.equal(hasSelection(parts), false);
  selectAll(parts);
  assert.equal(hasSelection(parts), true);
  clearSelection(parts);
  assert.equal(hasSelection(parts), false);
  parts[0].weight[0] = 1;
  growSelection(parts);
  const selected = Array.from(parts[0].weight).filter((w) => w > 0).length;
  assert.ok(selected > 1, "growing reaches the neighbours");
});

test("scale ×2 on the whole model doubles it about its centre", () => {
  const { parts } = box();
  const before = bounds(parts[0]);
  apply(parts, { op: "scale", factor: 2, target: "all" }, 1);
  const after = bounds(parts[0]);
  const size = (b: THREE.Box3) => b.getSize(new THREE.Vector3());
  assert.ok(size(after).distanceTo(size(before).multiplyScalar(2)) < 1e-5);
  assert.ok(after.getCenter(new THREE.Vector3()).length() < 1e-5, "centre stays put");
});

test("move shifts by a fraction of the model size, upwards in world terms", () => {
  const { parts } = box();
  const y0 = bounds(parts[0]).min.y;
  apply(parts, { op: "move", dx: 0, dy: 0.5, dz: 0, target: "all" }, 2);
  assert.ok(Math.abs(bounds(parts[0]).min.y - (y0 + 1)) < 1e-5);
});

test("ops on an empty selection change nothing", () => {
  const { parts } = box();
  const before = Float32Array.from(parts[0].geom.getAttribute("position").array as Float32Array);
  apply(parts, { op: "scale", factor: 3 }, 1);
  assert.deepEqual(Float32Array.from(parts[0].geom.getAttribute("position").array as Float32Array), before);
});

test("paint blends by selection weight", () => {
  const { parts } = box();
  selectAll(parts);
  apply(parts, { op: "color", hex: "#ff0000" }, 1);
  assert.ok(Math.abs(parts[0].paint[0] - 1) < 1e-6 && parts[0].paint[1] < 1e-6);
});

test("delete removes fully selected faces and clears the selection", () => {
  const { parts } = box();
  selectAll(parts);
  apply(parts, { op: "delete" }, 1);
  assert.equal(stats(parts).faces, 0);
  assert.equal(hasSelection(parts), false);
});

test("snapshot and restore undo an edit exactly", () => {
  const { parts } = box();
  const snap = snapshot(parts);
  const before = Float32Array.from(parts[0].geom.getAttribute("position").array as Float32Array);
  selectAll(parts);
  apply(parts, { op: "inflate", amount: 0.1 }, 1);
  apply(parts, { op: "delete" }, 1);
  restore(parts, snap);
  assert.deepEqual(Float32Array.from(parts[0].geom.getAttribute("position").array as Float32Array), before);
  assert.equal(stats(parts).faces, 12);
});

test("smooth and flatten keep every vertex finite", () => {
  const { parts } = box();
  selectAll(parts);
  apply(parts, { op: "smooth", iterations: 5 }, 1);
  apply(parts, { op: "flatten", strength: 1 }, 1);
  apply(parts, { op: "rotate", axis: "y", degrees: 90, target: "all" }, 1);
  for (const v of parts[0].geom.getAttribute("position").array as Float32Array) assert.ok(Number.isFinite(v));
});
