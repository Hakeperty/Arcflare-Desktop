// Editing a generated mesh: soft selection, and operations that respect it.
//
// Generated meshes (Hunyuan3D, TripoSR) arrive as triangle soup or with seams
// split by normals, so neighbouring triangles often don't share vertices. That
// breaks smoothing and makes a "selected region" a scatter of disconnected
// faces. So each part is welded once on load (mergeVertices after dropping
// normals), normals are recomputed, and everything below works on the welded,
// indexed geometry.
//
// Selection is a weight per vertex in [0,1], not a set: a brush sets full
// weight at its centre and fades to zero at its rim, and every operation is
// scaled by the weight — so edits blend into the surrounding surface instead
// of tearing a step into it.

import * as THREE from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";

export type Part = {
  mesh: THREE.Mesh;
  geom: THREE.BufferGeometry;
  /** True colours (what gets exported). */
  paint: Float32Array;
  /** Selection weight per vertex. */
  weight: Float32Array;
  /** Vertex neighbours, for smoothing and growing the selection. */
  neighbours: Uint32Array[];
};

export type Snapshot = { positions: Float32Array; paint: Float32Array; index: Uint32Array | null }[];

const HIGHLIGHT = new THREE.Color("#ffb020");

/** Prepare every mesh under `root` for editing. */
export function prepareParts(root: THREE.Object3D): Part[] {
  const parts: Part[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    let g = mesh.geometry.clone();
    // Per-face normals keep coincident vertices apart; drop them before welding.
    g.deleteAttribute("normal");
    g = mergeVertices(g, 1e-5);
    if (!g.index) {
      const n = g.getAttribute("position").count;
      g.setIndex(Array.from({ length: n }, (_, i) => i));
    }
    g.computeVertexNormals();
    const count = g.getAttribute("position").count;

    // Start the paint from the mesh's own colours: vertex colours if it has
    // them, else its material colour. The material then shows vertex colours
    // over white, so paint and highlight are what you see.
    const paint = new Float32Array(count * 3);
    const existing = g.getAttribute("color") as THREE.BufferAttribute | undefined;
    const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
    const base = mat && mat.color ? mat.color.clone() : new THREE.Color("#cfcac0");
    for (let i = 0; i < count; i++) {
      if (existing) {
        paint[i * 3] = existing.getX(i); paint[i * 3 + 1] = existing.getY(i); paint[i * 3 + 2] = existing.getZ(i);
      } else {
        paint[i * 3] = base.r; paint[i * 3 + 1] = base.g; paint[i * 3 + 2] = base.b;
      }
    }
    g.setAttribute("color", new THREE.BufferAttribute(paint.slice(), 3));
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      color: 0xffffff,
      roughness: 0.75,
      metalness: 0.05,
      map: mat && mat.map ? mat.map : null,
      side: THREE.DoubleSide,
    });
    mesh.geometry.dispose();
    mesh.geometry = g;
    mesh.material = material;
    parts.push({ mesh, geom: g, paint, weight: new Float32Array(count), neighbours: buildNeighbours(g) });
  });
  return parts;
}

function buildNeighbours(g: THREE.BufferGeometry): Uint32Array[] {
  const count = g.getAttribute("position").count;
  const sets: Set<number>[] = Array.from({ length: count }, () => new Set<number>());
  const idx = g.index!.array;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    sets[a].add(b); sets[a].add(c); sets[b].add(a); sets[b].add(c); sets[c].add(a); sets[c].add(b);
  }
  return sets.map((s) => Uint32Array.from(s));
}

// ---------------------------------------------------------------- display ----

/** Push paint (+ the selection highlight, if shown) into the visible colours. */
export function refreshColours(parts: Part[], showSelection: boolean) {
  for (const p of parts) {
    const col = p.geom.getAttribute("color") as THREE.BufferAttribute;
    const arr = col.array as Float32Array;
    for (let i = 0; i < p.weight.length; i++) {
      const w = showSelection ? p.weight[i] * 0.7 : 0;
      arr[i * 3] = p.paint[i * 3] * (1 - w) + HIGHLIGHT.r * w;
      arr[i * 3 + 1] = p.paint[i * 3 + 1] * (1 - w) + HIGHLIGHT.g * w;
      arr[i * 3 + 2] = p.paint[i * 3 + 2] * (1 - w) + HIGHLIGHT.b * w;
    }
    col.needsUpdate = true;
  }
}

// -------------------------------------------------------------- selection ----

const smoothstep = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/**
 * Brush at a point in world space. `mode` add raises weights, subtract lowers
 * them. Radius is in world units.
 */
export function brush(parts: Part[], worldPoint: THREE.Vector3, radius: number, mode: "add" | "subtract") {
  const local = new THREE.Vector3();
  const v = new THREE.Vector3();
  for (const p of parts) {
    p.mesh.updateWorldMatrix(true, false);
    local.copy(worldPoint).applyMatrix4(new THREE.Matrix4().copy(p.mesh.matrixWorld).invert());
    // Radius in the part's local units (meshes can be scaled).
    const scale = new THREE.Vector3().setFromMatrixScale(p.mesh.matrixWorld);
    const r = radius / Math.max(1e-9, (scale.x + scale.y + scale.z) / 3);
    const pos = p.geom.getAttribute("position");
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const d = v.distanceTo(local);
      if (d >= r) continue;
      const w = smoothstep(1 - d / r);
      p.weight[i] = mode === "add" ? Math.max(p.weight[i], w) : Math.min(p.weight[i], 1 - w);
    }
  }
}

export function selectAll(parts: Part[]) { parts.forEach((p) => p.weight.fill(1)); }
export function clearSelection(parts: Part[]) { parts.forEach((p) => p.weight.fill(0)); }

/** Grow the selection by one ring of neighbours, at a little under their weight. */
export function growSelection(parts: Part[]) {
  for (const p of parts) {
    const next = p.weight.slice();
    for (let i = 0; i < p.weight.length; i++) {
      if (p.weight[i] <= 0) continue;
      for (const n of p.neighbours[i]) next[n] = Math.max(next[n], p.weight[i] * 0.85);
    }
    p.weight.set(next);
  }
}

export type SelectionSummary = {
  count: number;
  centroid: [number, number, number];
  size: [number, number, number];
  avgNormal: [number, number, number];
  modelSize: number;
};

/** What is selected, in world space, for the instruction planner and the UI. */
export function summarize(parts: Part[], modelSize: number): SelectionSummary {
  const c = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  let total = 0;
  let count = 0;
  for (const p of parts) {
    const pos = p.geom.getAttribute("position");
    const nor = p.geom.getAttribute("normal");
    for (let i = 0; i < pos.count; i++) {
      const w = p.weight[i];
      if (w <= 0.05) continue;
      v.fromBufferAttribute(pos, i).applyMatrix4(p.mesh.matrixWorld);
      c.addScaledVector(v, w);
      box.expandByPoint(v);
      if (nor) nrm.addScaledVector(new THREE.Vector3().fromBufferAttribute(nor, i), w);
      total += w;
      if (w > 0.5) count++;
    }
  }
  if (total > 0) c.divideScalar(total);
  const size = box.isEmpty() ? new THREE.Vector3() : box.getSize(new THREE.Vector3());
  if (nrm.lengthSq() > 0) nrm.normalize();
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return {
    count,
    centroid: [r(c.x), r(c.y), r(c.z)],
    size: [r(size.x), r(size.y), r(size.z)],
    avgNormal: [r(nrm.x), r(nrm.y), r(nrm.z)],
    modelSize: r(modelSize),
  };
}

export function hasSelection(parts: Part[]) {
  return parts.some((p) => p.weight.some((w) => w > 0.05));
}

// ------------------------------------------------------------------- undo ----

export function snapshot(parts: Part[]): Snapshot {
  return parts.map((p) => ({
    positions: (p.geom.getAttribute("position").array as Float32Array).slice(),
    paint: p.paint.slice(),
    index: p.geom.index ? Uint32Array.from(p.geom.index.array) : null,
  }));
}

export function restore(parts: Part[], s: Snapshot) {
  parts.forEach((p, i) => {
    const snap = s[i];
    if (!snap) return;
    const pos = p.geom.getAttribute("position") as THREE.BufferAttribute;
    (pos.array as Float32Array).set(snap.positions);
    pos.needsUpdate = true;
    p.paint.set(snap.paint);
    if (snap.index) p.geom.setIndex(new THREE.BufferAttribute(snap.index.slice(), 1));
    finishGeometry(p);
  });
}

// ------------------------------------------------------------- operations ----

export type Op =
  | { op: "scale"; factor: number; target?: "selection" | "all" }
  | { op: "stretch"; axis: "x" | "y" | "z"; factor: number; target?: "selection" | "all" }
  | { op: "move"; dx: number; dy: number; dz: number; target?: "selection" | "all" }
  | { op: "inflate"; amount: number }
  | { op: "smooth"; iterations: number }
  | { op: "flatten"; strength: number }
  | { op: "color"; hex: string }
  | { op: "rotate"; axis: "x" | "y" | "z"; degrees: number; target?: "selection" | "all" }
  | { op: "delete" };

/** One line per op, for the planner prompt and the UI. */
export const OP_SIGNATURES = [
  'scale    {"op":"scale","factor":1.2}            grow (>1) or shrink (<1) about the selection centre',
  'stretch  {"op":"stretch","axis":"y","factor":1.3} longer/taller along one axis (y is up)',
  'move     {"op":"move","dx":0,"dy":0.05,"dz":0}  move by a fraction of the model size (y is up)',
  'inflate  {"op":"inflate","amount":0.02}          puff out along the surface (negative = thinner)',
  'smooth   {"op":"smooth","iterations":3}           soften bumps',
  'flatten  {"op":"flatten","strength":0.7}          press toward a flat plane',
  'color    {"op":"color","hex":"#cc2222"}           paint',
  'rotate   {"op":"rotate","axis":"y","degrees":15}  turn about the selection centre',
  'delete   {"op":"delete"}                          remove the selected faces',
  'Add "target":"all" to scale/stretch/move/rotate to act on the whole model.',
];

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Validate an op from an untrusted source (a model's JSON). Null if unusable. */
export function sanitize(raw: unknown): Op | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const n = (k: string, d: number) => (typeof o[k] === "number" && Number.isFinite(o[k] as number) ? (o[k] as number) : d);
  const target = o.target === "all" ? "all" : "selection";
  const axis = o.axis === "x" || o.axis === "z" ? o.axis : "y";
  switch (o.op) {
    case "scale": return { op: "scale", factor: clamp(n("factor", 1), 0.2, 4), target };
    case "stretch": return { op: "stretch", axis, factor: clamp(n("factor", 1), 0.2, 4), target };
    case "move": return { op: "move", dx: clamp(n("dx", 0), -1, 1), dy: clamp(n("dy", 0), -1, 1), dz: clamp(n("dz", 0), -1, 1), target };
    case "inflate": return { op: "inflate", amount: clamp(n("amount", 0.02), -0.2, 0.2) };
    case "smooth": return { op: "smooth", iterations: Math.round(clamp(n("iterations", 3), 1, 20)) };
    case "flatten": return { op: "flatten", strength: clamp(n("strength", 0.7), 0, 1) };
    case "color": return typeof o.hex === "string" && /^#?[0-9a-f]{6}$/i.test(o.hex) ? { op: "color", hex: o.hex.startsWith("#") ? o.hex : `#${o.hex}` } : null;
    case "rotate": return { op: "rotate", axis, degrees: clamp(n("degrees", 0), -180, 180), target };
    case "delete": return { op: "delete" };
    default: return null;
  }
}

export function describe(op: Op): string {
  switch (op.op) {
    case "scale": return `scale ×${op.factor.toFixed(2)}${op.target === "all" ? " (whole model)" : ""}`;
    case "stretch": return `stretch ${op.axis} ×${op.factor.toFixed(2)}${op.target === "all" ? " (whole model)" : ""}`;
    case "move": return `move (${op.dx}, ${op.dy}, ${op.dz})${op.target === "all" ? " (whole model)" : ""}`;
    case "inflate": return op.amount >= 0 ? `inflate ${op.amount}` : `thin ${-op.amount}`;
    case "smooth": return `smooth ×${op.iterations}`;
    case "flatten": return `flatten ${op.strength}`;
    case "color": return `paint ${op.hex}`;
    case "rotate": return `rotate ${op.degrees}° about ${op.axis}${op.target === "all" ? " (whole model)" : ""}`;
    case "delete": return "delete selected faces";
  }
}

/** Does this op act on the selection (and therefore need one)? */
export function needsSelection(op: Op): boolean {
  return !("target" in op && op.target === "all");
}

/**
 * Apply one op. Positions are edited in each part's local space; directions
 * given in world terms (up is +y) are converted, so a scaled or rotated part
 * still moves "up".
 */
export function apply(parts: Part[], op: Op, modelSize: number) {
  const all = !needsSelection(op);
  const w = (p: Part, i: number) => (all ? 1 : p.weight[i]);

  // The weighted centre of what is being edited, in world space.
  const centre = new THREE.Vector3();
  let tw = 0;
  const v = new THREE.Vector3();
  for (const p of parts) {
    const pos = p.geom.getAttribute("position");
    for (let i = 0; i < pos.count; i++) {
      const wi = w(p, i);
      if (wi <= 0) continue;
      v.fromBufferAttribute(pos, i).applyMatrix4(p.mesh.matrixWorld);
      centre.addScaledVector(v, wi);
      tw += wi;
    }
  }
  if (tw === 0) return;
  centre.divideScalar(tw);

  for (const p of parts) {
    const pos = p.geom.getAttribute("position") as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const toLocal = new THREE.Matrix4().copy(p.mesh.matrixWorld).invert();
    const toWorld = p.mesh.matrixWorld;
    const nor = p.geom.getAttribute("normal") as THREE.BufferAttribute;

    const editWorld = (fn: (world: THREE.Vector3, wi: number, i: number) => void) => {
      for (let i = 0; i < pos.count; i++) {
        const wi = w(p, i);
        if (wi <= 0) continue;
        v.fromBufferAttribute(pos, i).applyMatrix4(toWorld);
        fn(v, wi, i);
        v.applyMatrix4(toLocal);
        arr[i * 3] = v.x; arr[i * 3 + 1] = v.y; arr[i * 3 + 2] = v.z;
      }
    };

    switch (op.op) {
      case "scale":
        editWorld((world, wi) => {
          const target = centre.clone().add(world.clone().sub(centre).multiplyScalar(op.factor));
          world.lerp(target, wi);
        });
        break;
      case "stretch":
        editWorld((world, wi) => {
          const target = world.clone();
          target[op.axis] = centre[op.axis] + (world[op.axis] - centre[op.axis]) * op.factor;
          world.lerp(target, wi);
        });
        break;
      case "move": {
        const d = new THREE.Vector3(op.dx, op.dy, op.dz).multiplyScalar(modelSize);
        editWorld((world, wi) => world.addScaledVector(d, wi));
        break;
      }
      case "rotate": {
        const q = new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(op.axis === "x" ? 1 : 0, op.axis === "y" ? 1 : 0, op.axis === "z" ? 1 : 0),
          THREE.MathUtils.degToRad(op.degrees));
        editWorld((world, wi) => {
          const target = world.clone().sub(centre).applyQuaternion(q).add(centre);
          world.lerp(target, wi);
        });
        break;
      }
      case "inflate": {
        const a = op.amount * modelSize;
        const n = new THREE.Vector3();
        for (let i = 0; i < pos.count; i++) {
          const wi = w(p, i);
          if (wi <= 0 || !nor) continue;
          n.fromBufferAttribute(nor, i);
          arr[i * 3] += n.x * a * wi; arr[i * 3 + 1] += n.y * a * wi; arr[i * 3 + 2] += n.z * a * wi;
        }
        break;
      }
      case "smooth":
        for (let it = 0; it < op.iterations; it++) {
          const src = arr.slice();
          for (let i = 0; i < pos.count; i++) {
            const wi = w(p, i);
            const nb = p.neighbours[i];
            if (wi <= 0 || !nb.length) continue;
            let sx = 0, sy = 0, sz = 0;
            for (const j of nb) { sx += src[j * 3]; sy += src[j * 3 + 1]; sz += src[j * 3 + 2]; }
            const k = 0.5 * wi;
            arr[i * 3] += (sx / nb.length - src[i * 3]) * k;
            arr[i * 3 + 1] += (sy / nb.length - src[i * 3 + 1]) * k;
            arr[i * 3 + 2] += (sz / nb.length - src[i * 3 + 2]) * k;
          }
        }
        break;
      case "flatten": {
        // Plane through the centre, facing the selection's average normal.
        const pn = new THREE.Vector3();
        for (const q of parts) {
          const qn = q.geom.getAttribute("normal");
          if (!qn) continue;
          for (let i = 0; i < qn.count; i++) {
            if (q.weight[i] > 0) pn.addScaledVector(new THREE.Vector3().fromBufferAttribute(qn, i).transformDirection(q.mesh.matrixWorld), q.weight[i]);
          }
        }
        if (pn.lengthSq() === 0) break;
        pn.normalize();
        editWorld((world, wi) => {
          const dist = world.clone().sub(centre).dot(pn);
          world.addScaledVector(pn, -dist * op.strength * wi);
        });
        break;
      }
      case "color": {
        const c = new THREE.Color(op.hex);
        for (let i = 0; i < pos.count; i++) {
          const wi = w(p, i);
          if (wi <= 0) continue;
          p.paint[i * 3] += (c.r - p.paint[i * 3]) * wi;
          p.paint[i * 3 + 1] += (c.g - p.paint[i * 3 + 1]) * wi;
          p.paint[i * 3 + 2] += (c.b - p.paint[i * 3 + 2]) * wi;
        }
        break;
      }
      case "delete": {
        const idx = p.geom.index!.array;
        const keep: number[] = [];
        for (let t = 0; t < idx.length; t += 3) {
          const a = idx[t], b = idx[t + 1], c2 = idx[t + 2];
          if (p.weight[a] > 0.5 && p.weight[b] > 0.5 && p.weight[c2] > 0.5) continue;
          keep.push(a, b, c2);
        }
        p.geom.setIndex(keep);
        // Deleted faces leave the selection empty-handed; clear it.
        p.weight.fill(0);
        break;
      }
    }
    pos.needsUpdate = true;
    if (op.op !== "color") finishGeometry(p);
  }
}

function finishGeometry(p: Part) {
  p.geom.computeVertexNormals();
  p.geom.computeBoundingSphere();
  p.geom.computeBoundingBox();
  if (p.geom.index) p.neighbours = buildNeighbours(p.geom);
}

/** Total faces and vertices, for the stats line. */
export function stats(parts: Part[]) {
  let faces = 0, verts = 0;
  for (const p of parts) {
    verts += p.geom.getAttribute("position").count;
    faces += p.geom.index ? p.geom.index.count / 3 : p.geom.getAttribute("position").count / 3;
  }
  return { faces: Math.round(faces), verts };
}
