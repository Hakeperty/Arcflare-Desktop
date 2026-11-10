import { test } from "node:test";
import assert from "node:assert/strict";
import { baseName } from "../../src/lib/path";

test("baseName reads Windows and POSIX paths", () => {
  assert.equal(baseName("C:\\Users\\me\\code\\my-app"), "my-app");
  assert.equal(baseName("C:\\Users\\me\\code\\my-app\\"), "my-app");
  assert.equal(baseName("/home/me/code/my-app"), "my-app");
  assert.equal(baseName("/home/me/code/my-app/"), "my-app");
  assert.equal(baseName("mesh.glb"), "mesh.glb");
  assert.equal(baseName(""), "");
});
