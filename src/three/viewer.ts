// The 3D view. Renders on demand — when the camera moves, an edit lands or
// the window resizes — and not otherwise: the GPU it would spin on is the one
// generating the next model.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";

export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
  readonly controls: OrbitControls;
  root: THREE.Group | null = null;
  modelSize = 1;
  private grid: THREE.GridHelper;
  private raf = 0;
  private dirty = false;
  private active = true;
  private resize: ResizeObserver;
  private raycaster = new THREE.Raycaster();

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = "block";

    this.scene.add(new THREE.HemisphereLight(0xfff4e0, 0x202024, 1.4));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(3, 5, 4);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x9fe8ff, 0.5);
    rim.position.set(-4, 2, -3);
    this.scene.add(rim);

    this.grid = new THREE.GridHelper(4, 16, 0x5a4a26, 0x2a2a27);
    this.scene.add(this.grid);

    this.camera.position.set(1.6, 1.2, 2.2);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.addEventListener("change", () => this.requestRender());

    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(host);
    this.fit();
  }

  /** Ask for a frame. Frames continue only while damping is still settling. */
  requestRender() {
    this.dirty = true;
    if (this.raf || !this.active) return;
    const frame = () => {
      this.raf = 0;
      const moving = this.controls.update();
      this.renderer.render(this.scene, this.camera);
      if (moving || this.dirty) {
        this.dirty = false;
        this.raf = requestAnimationFrame(frame);
      }
    };
    this.raf = requestAnimationFrame(frame);
  }

  setActive(on: boolean) {
    this.active = on;
    if (on) { this.fit(); this.requestRender(); }
  }

  private fit() {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  /** Load a .glb, replacing what was shown, and frame it. */
  async load(url: string): Promise<THREE.Group> {
    const gltf = await new GLTFLoader().loadAsync(url);
    this.clear();
    const root = new THREE.Group();
    root.add(gltf.scene);
    // Stand it on the grid, centred, at a size the grid suits.
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    const longest = Math.max(size.x, size.y, size.z) || 1;
    const s = 1.6 / longest;
    gltf.scene.position.sub(new THREE.Vector3(centre.x, box.min.y, centre.z));
    root.scale.setScalar(s);
    this.scene.add(root);
    this.root = root;
    this.modelSize = 1.6;
    this.frame();
    return root;
  }

  frame() {
    if (!this.root) return;
    const box = new THREE.Box3().setFromObject(this.root);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const d = sphere.radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 1.15;
    const dir = new THREE.Vector3(0.65, 0.45, 1).normalize();
    this.controls.target.copy(sphere.center);
    this.camera.position.copy(sphere.center).addScaledVector(dir, d);
    this.camera.near = d / 100;
    this.camera.far = d * 100;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  setWireframe(on: boolean) {
    this.root?.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => { (x as THREE.MeshStandardMaterial).wireframe = on; });
    });
    this.requestRender();
  }

  setGrid(on: boolean) { this.grid.visible = on; this.requestRender(); }

  /** The surface point under the cursor, in world space. */
  pick(clientX: number, clientY: number): { point: THREE.Vector3; normal: THREE.Vector3 } | null {
    if (!this.root) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.root, true)[0];
    if (!hit) return null;
    const normal = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
    return { point: hit.point.clone(), normal };
  }

  /** The current model as a binary glTF. */
  async exportGlb(): Promise<ArrayBuffer> {
    if (!this.root) throw new Error("nothing loaded");
    const out = await new GLTFExporter().parseAsync(this.root, { binary: true });
    return out as ArrayBuffer;
  }

  private clear() {
    if (!this.root) return;
    this.scene.remove(this.root);
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.geometry.dispose();
      (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose());
    });
    this.root = null;
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.resize.disconnect();
    this.controls.dispose();
    this.clear();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
