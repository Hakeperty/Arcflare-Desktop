// Opening meshes quickly: only the last open may report anything.

import test from "node:test";
import assert from "node:assert/strict";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { Viewer } from "../../src/three/viewer";

test("a load that a newer one replaced answers null even when it fails", async () => {
  const real = GLTFLoader.prototype.loadAsync;
  GLTFLoader.prototype.loadAsync = (url: string) => Promise.reject(new Error(`cannot read ${url}`));
  try {
    const v = { loads: 0 } as unknown as Viewer;   // load() only needs its counter before the file arrives
    const older = Viewer.prototype.load.call(v, "old.glb");
    const newer = Viewer.prototype.load.call(v, "new.glb");
    assert.equal(await older, null);
    await assert.rejects(newer, /new\.glb/);
  } finally { GLTFLoader.prototype.loadAsync = real; }
});
