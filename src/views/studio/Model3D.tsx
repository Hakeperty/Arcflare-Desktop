// 3D: generate a mesh from an image or words, then point at part of it and
// say what to change.

import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { api, fileUrl, type GenModel, type ImageModels, type LoadedModel, type StudioFile } from "../../lib/api";
import { Field, JobStatus, useJob } from "../../ui/kit";
import { Viewer } from "../../three/viewer";
import {
  OP_SIGNATURES, apply, brush, clearSelection, describe, growSelection, hasSelection, needsSelection,
  prepareParts, refreshColours, restore, selectAll, snapshot, stats, summarize, type Op, type Part, type Snapshot,
} from "../../three/edit";
import { parseInstruction, validatePlan } from "../../three/plan";
import type { Handoff } from "../Studio";

type Props = {
  handoff: Handoff;
  openMesh: { path: string; at: number } | null;
  inputImage: { path: string; at: number } | null;
  loaded: LoadedModel | null;
  active: boolean;
};

export function Model3DTab({ openMesh, inputImage, loaded, active }: Props) {
  // ---------------------------------------------------------------- viewer
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer | null>(null);
  const parts = useRef<Part[]>([]);
  const [meshPath, setMeshPath] = useState<string | null>(null);
  const [meshStats, setMeshStats] = useState<{ faces: number; verts: number } | null>(null);
  const [wire, setWire] = useState(false);
  const [showSel, setShowSel] = useState(true);
  const [loadErr, setLoadErr] = useState("");

  useEffect(() => {
    const v = new Viewer(host.current!);
    viewer.current = v;
    return () => { v.dispose(); viewer.current = null; };
  }, []);
  useEffect(() => { viewer.current?.setActive(active); }, [active]);

  const openFile = useCallback(async (path: string) => {
    const v = viewer.current;
    if (!v) return;
    setLoadErr("");
    try {
      const root = await v.load(fileUrl(path, Date.now()));
      parts.current = prepareParts(root);
      refreshColours(parts.current, showSel);
      setMeshPath(path);
      setMeshStats(stats(parts.current));
      undo.current = []; redo.current = [];
      setSelCount(0); setLog([]);
      v.setWireframe(wire);
      v.requestRender();
    } catch (e) {
      setLoadErr(`could not open ${path.split(/[\\/]/).pop()}: ${(e as Error).message}`);
    }
  }, [showSel, wire]);

  useEffect(() => { if (openMesh) openFile(openMesh.path); }, [openMesh]); // eslint-disable-line react-hooks/exhaustive-deps

  // -------------------------------------------------------------- generate
  const [models, setModels] = useState<GenModel[]>([]);
  const [modelId, setModelId] = useState("");
  const [source, setSource] = useState<"image" | "text">("image");
  const [image, setImage] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("a cute ceramic owl figurine");
  const [steps, setSteps] = useState(30);
  const [octree, setOctree] = useState(256);
  const [texture, setTexture] = useState(false);
  const [imgModels, setImgModels] = useState<ImageModels | null>(null);
  const [imgModel, setImgModel] = useState("");
  const [recentImages, setRecentImages] = useState<StudioFile[]>([]);
  const [recentMeshes, setRecentMeshes] = useState<StudioFile[]>([]);
  const [genErr, setGenErr] = useState("");
  const [imgJobId, setImgJobId] = useState<string | null>(null);
  const [meshJobId, setMeshJobId] = useState<string | null>(null);
  const [setupId, setSetupId] = useState<string | null>(null);
  const imgJob = useJob(imgJobId);
  const meshJob = useJob(meshJobId);
  const setupJob = useJob(setupId);

  const refreshLists = () => {
    api.genStatus().then((all) => {
      const m3 = all.filter((m) => m.kind === "3d");
      setModels(m3);
      setModelId((cur) => cur || (m3.find((m) => m.installed) || m3[0])?.id || "");
    }).catch(() => {});
    api.imageModels().then((m) => { setImgModels(m); setImgModel((c) => c || m.models[0]?.path || ""); }).catch(() => {});
    api.studioFiles("image").then(setRecentImages).catch(() => {});
    api.studioFiles("mesh").then(setRecentMeshes).catch(() => {});
  };
  useEffect(refreshLists, []);
  useEffect(() => { if (inputImage) { setImage(inputImage.path); setSource("image"); } }, [inputImage]);
  useEffect(() => { if (setupJob?.state === "done") refreshLists(); }, [setupJob?.state]);

  const model = models.find((m) => m.id === modelId);

  // text → image (sd.cpp) → mesh: when the image job lands, start the mesh.
  useEffect(() => {
    if (imgJob?.state !== "done" || !imgJob.result?.file) return;
    const file = String(imgJob.result.file);
    setImage(file);
    startMesh(file);
  }, [imgJob?.state]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (meshJob?.state === "done" && meshJob.result?.file) { openFile(String(meshJob.result.file)); refreshLists(); }
  }, [meshJob?.state]); // eslint-disable-line react-hooks/exhaustive-deps

  async function startMesh(img?: string) {
    setGenErr("");
    try {
      const j = await api.gen3d({ model: modelId, image: img, steps, octree, texture: texture && !!model?.texture });
      setMeshJobId(j.id);
    } catch (e) { setGenErr((e as Error).message); }
  }

  async function generate() {
    setGenErr("");
    if (source === "image") {
      if (!image) { setGenErr("choose an image first"); return; }
      return startMesh(image);
    }
    // Text: draw it first when an image model exists — a picture you can see
    // before meshing — otherwise Hunyuan's own text-to-image path.
    if (imgModels?.sd && imgModel) {
      try {
        const j = await api.generateImage({
          backend: "sdcpp", model: imgModel, width: 512, height: 512, steps: 20,
          prompt: `${prompt}, single object, centred, three-quarter view, plain white background, soft even studio lighting`,
          negative: "multiple objects, cropped, text, watermark, busy background",
        });
        setImgJobId(j.id);
      } catch (e) { setGenErr((e as Error).message); }
    } else if (model?.text) {
      try { const j = await api.gen3d({ model: modelId, prompt, steps, octree }); setMeshJobId(j.id); }
      catch (e) { setGenErr((e as Error).message); }
    } else {
      setGenErr("text → 3D needs an image model (Image tab) or a hunyuan3d-2 model");
    }
  }

  // ----------------------------------------------------------- select & edit
  const [tool, setTool] = useState<"orbit" | "select">("select");
  const [radius, setRadius] = useState(8); // % of model size
  const [selCount, setSelCount] = useState(0);
  const [instruction, setInstruction] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const [planning, setPlanning] = useState(false);
  const undo = useRef<Snapshot[]>([]);
  const redo = useRef<Snapshot[]>([]);
  const painting = useRef<"add" | "subtract" | null>(null);

  // Left button selects in select mode; the right button always orbits.
  useEffect(() => {
    const v = viewer.current;
    if (!v) return;
    v.controls.mouseButtons = tool === "select"
      ? { LEFT: null as unknown as THREE.MOUSE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE }
      : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  }, [tool]);

  const afterSelection = () => {
    refreshColours(parts.current, showSel);
    setSelCount(summarize(parts.current, viewer.current?.modelSize || 1).count);
    viewer.current?.requestRender();
  };

  const stroke = (e: React.PointerEvent) => {
    const v = viewer.current;
    if (!v || !painting.current) return;
    const hit = v.pick(e.clientX, e.clientY);
    if (!hit) return;
    brush(parts.current, hit.point, (radius / 100) * v.modelSize, painting.current);
    afterSelection();
  };

  function onPointerDown(e: React.PointerEvent) {
    if (tool !== "select" || e.button !== 0 || !parts.current.length) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    painting.current = e.altKey ? "subtract" : "add";
    // A plain click starts a new selection; Shift adds, Alt removes.
    if (!e.shiftKey && !e.altKey) clearSelection(parts.current);
    stroke(e);
  }

  function pushUndo() {
    undo.current.push(snapshot(parts.current));
    if (undo.current.length > 30) undo.current.shift();
    redo.current = [];
  }

  function doUndo() {
    const s = undo.current.pop();
    if (!s) return;
    redo.current.push(snapshot(parts.current));
    restore(parts.current, s);
    finishEdit();
  }
  function doRedo() {
    const s = redo.current.pop();
    if (!s) return;
    undo.current.push(snapshot(parts.current));
    restore(parts.current, s);
    finishEdit();
  }

  function finishEdit() {
    refreshColours(parts.current, showSel);
    setMeshStats(stats(parts.current));
    setSelCount(summarize(parts.current, viewer.current?.modelSize || 1).count);
    viewer.current?.requestRender();
  }

  function runOps(ops: Op[], via: string) {
    const v = viewer.current;
    if (!v || !ops.length) return;
    const selected = hasSelection(parts.current);
    const usable = ops.filter((o) => !needsSelection(o) || selected);
    if (!usable.length) {
      setLog((l) => [`select a part first (click it), or say "whole model"`, ...l].slice(0, 30));
      return;
    }
    pushUndo();
    for (const op of usable) apply(parts.current, op, v.modelSize);
    finishEdit();
    const count = summarize(parts.current, v.modelSize).count;
    setLog((l) => [`${usable.map(describe).join(" · ")} — ${count ? `${count} vertices` : "whole model"} · ${via}`, ...l].slice(0, 30));
  }

  async function submitInstruction() {
    const text = instruction.trim();
    if (!text || !parts.current.length) return;
    setPlanning(true);
    let ops: Op[] = [];
    let via = "keyword parser";
    try {
      if (loaded) {
        const sel = summarize(parts.current, viewer.current?.modelSize || 1);
        const raw = await api.planEdit({ instruction: text, selection: sel, ops: OP_SIGNATURES });
        ops = validatePlan(raw);
        if (ops.length) via = `planned by ${loaded.name}`;
      }
    } catch { /* fall through to the parser */ }
    if (!ops.length) ops = parseInstruction(text);
    setPlanning(false);
    if (!ops.length) {
      setLog((l) => [`didn't understand "${text}" — try bigger, smaller, taller, smooth, flatten, up, paint red, remove`, ...l].slice(0, 30));
      return;
    }
    runOps(ops, via);
    setInstruction("");
  }

  // Keyboard: Ctrl+Z / Ctrl+Y (or Shift+Ctrl+Z), S toggles select, F frames.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      if (typing) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); doRedo(); }
      else if (e.key === "s") setTool((t) => (t === "select" ? "orbit" : "select"));
      else if (e.key === "f") viewer.current?.frame();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { refreshColours(parts.current, showSel); viewer.current?.requestRender(); }, [showSel]);

  async function saveGlb() {
    const v = viewer.current;
    if (!v || !meshPath) return;
    // Export the paint, not the orange selection overlay.
    refreshColours(parts.current, false);
    try {
      const bytes = await v.exportGlb();
      const base = (meshPath.split(/[\\/]/).pop() || "mesh.glb").replace(/(-edited)?\.glb$/i, "");
      const out = await api.writeBytes(`${base}-edited.glb`, bytes);
      await api.saveAs(out, { filters: [{ name: "glTF binary", extensions: ["glb"] }] });
      setLog((l) => [`saved ${out.split(/[\\/]/).pop()}`, ...l]);
    } finally {
      refreshColours(parts.current, showSel);
      v.requestRender();
    }
  }

  const running = imgJob?.state === "running" || meshJob?.state === "running";

  return (
    <div style={{ display: "grid", gridTemplateColumns: "300px 1fr 300px", flex: 1, minHeight: 0 }}>
      {/* ------------------------------------------------------- generate */}
      <div style={{ borderRight: "1px solid var(--border)", overflowY: "auto", padding: 12 }} className="col">
        <div className="label"><span className="a">[ gen ]</span> // make a model</div>
        <Field label="3d model">
          <select className="select" value={modelId} onChange={(e) => setModelId(e.target.value)}>
            {models.map((m) => <option key={m.id} value={m.id}>{m.label} · ~{m.vram} GB{m.installed ? "" : " · not set up"}</option>)}
          </select>
        </Field>
        {model && !model.installed && (
          <div className="panel" style={{ padding: 10, borderColor: "var(--accent)" }}>
            <div style={{ fontSize: 13, marginBottom: 8 }}>Not set up yet. Setup installs its code and packages.</div>
            <div className="row wrap">
              <button className="btn primary sm" onClick={async () => setSetupId((await api.genSetup(model.id, { torch: "cuda" })).id)}>set up (NVIDIA)</button>
              <button className="btn sm" onClick={async () => setSetupId((await api.genSetup(model.id, { torch: "cpu" })).id)}>CPU / Mac</button>
            </div>
            {setupJob && <div style={{ marginTop: 8 }}><JobStatus job={setupJob} /></div>}
          </div>
        )}
        <div className="row">
          <button className={`btn sm${source === "image" ? " on" : ""}`} onClick={() => setSource("image")}>from image</button>
          <button className={`btn sm${source === "text" ? " on" : ""}`} onClick={() => setSource("text")}>from text</button>
        </div>
        {source === "image" ? (
          <>
            <div className="gridbg" style={{ border: "1px solid var(--border)", height: 150, display: "flex", alignItems: "center", justifyContent: "center" }}>
              {image ? <img src={fileUrl(image)} style={{ maxWidth: "100%", maxHeight: 146 }} /> : <span className="dim" style={{ fontSize: 12 }}>one object, plain background</span>}
            </div>
            <button className="btn sm" onClick={async () => { const p = await api.pickFile({ filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp"] }] }); if (p) setImage(p); }}>choose image…</button>
            {recentImages.length > 0 && (
              <div className="row" style={{ overflowX: "auto", gap: 6 }}>
                {recentImages.slice(0, 12).map((f) => (
                  <img key={f.path} src={fileUrl(f.path)} onClick={() => setImage(f.path)} title={f.name}
                    style={{ width: 46, height: 46, objectFit: "cover", cursor: "pointer", border: `1px solid ${f.path === image ? "var(--accent)" : "var(--border)"}` }} />
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            <Field label="describe it"><textarea className="textarea" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} /></Field>
            {imgModels?.sd && imgModels.models.length > 0 ? (
              <Field label="drawn first with">
                <select className="select" value={imgModel} onChange={(e) => setImgModel(e.target.value)}>
                  {imgModels.models.map((m) => <option key={m.path} value={m.path}>{m.name}</option>)}
                </select>
              </Field>
            ) : <span className="dim" style={{ fontSize: 12 }}>No image model: uses the 3D model's own text path (hunyuan3d-2 family).</span>}
          </>
        )}
        <div className="grid2">
          <Field label={`steps · ${steps}`}><input type="range" min={5} max={50} value={steps} onChange={(e) => setSteps(Number(e.target.value))} /></Field>
          <Field label="detail">
            <select className="select" value={octree} onChange={(e) => setOctree(Number(e.target.value))}>
              <option value={196}>fast</option><option value={256}>normal</option><option value={380}>fine</option>
            </select>
          </Field>
        </div>
        {model?.texture && <label className="row" style={{ gap: 8, fontSize: 13 }}><input type="checkbox" checked={texture} onChange={(e) => setTexture(e.target.checked)} /> texture (NVIDIA)</label>}
        <button className="btn primary" disabled={running || !model?.installed} onClick={generate}>{running ? "working…" : "generate"}</button>
        {genErr && <div className="err">{genErr}</div>}
        {imgJob && imgJob.state !== "done" && <JobStatus job={imgJob} />}
        {meshJob && <JobStatus job={meshJob} />}
        {recentMeshes.length > 0 && (
          <>
            <div className="label" style={{ marginTop: 6 }}>recent meshes</div>
            {recentMeshes.slice(0, 10).map((f) => (
              <button key={f.path} className={`nav${f.path === meshPath ? " on" : ""}`} style={{ fontSize: 12 }} onClick={() => openFile(f.path)}>
                <span className="truncate">{f.name}</span>
              </button>
            ))}
          </>
        )}
        <button className="btn ghost sm" onClick={async () => { const p = await api.pickFile({ filters: [{ name: "glTF binary", extensions: ["glb"] }] }); if (p) openFile(p); }}>open .glb…</button>
      </div>

      {/* --------------------------------------------------------- viewer */}
      <div style={{ position: "relative", minWidth: 0, display: "flex", flexDirection: "column" }}>
        <div className="row" style={{ padding: "6px 10px", borderBottom: "1px solid var(--border)", gap: 6 }}>
          <button className={`btn sm${tool === "select" ? " on" : ""}`} onClick={() => setTool("select")} title="S">select</button>
          <button className={`btn sm${tool === "orbit" ? " on" : ""}`} onClick={() => setTool("orbit")} title="S">orbit</button>
          <span className="dim mono" style={{ fontSize: 11 }}>{tool === "select" ? "left-drag paints · shift adds · alt removes · right-drag orbits" : "drag to orbit · right-drag pans"}</span>
          <span className="grow" />
          <button className={`btn sm${wire ? " on" : ""}`} onClick={() => { setWire(!wire); viewer.current?.setWireframe(!wire); }}>wire</button>
          <button className="btn sm" onClick={() => viewer.current?.frame()} title="F">frame</button>
        </div>
        <div ref={host} className="gridbg" style={{ flex: 1, minHeight: 0, cursor: tool === "select" ? "crosshair" : "grab" }}
          onPointerDown={onPointerDown}
          onPointerMove={stroke}
          onPointerUp={() => { painting.current = null; }}
          onPointerLeave={() => { painting.current = null; }}
          onContextMenu={(e) => e.preventDefault()} />
        {!meshPath && (
          <div style={{ position: "absolute", inset: "40px 0 0 0", display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
            <div className="empty" style={{ background: "var(--bg)" }}>Generate a model, or open a .glb, to start.</div>
          </div>
        )}
        <div className="row mono dim" style={{ padding: "4px 10px", borderTop: "1px solid var(--border)", fontSize: 11 }}>
          <span className="truncate grow">{meshPath ? meshPath.split(/[\\/]/).pop() : "—"}</span>
          {meshStats && <span>{meshStats.faces.toLocaleString()} faces · {meshStats.verts.toLocaleString()} vertices</span>}
        </div>
        {loadErr && <div className="err" style={{ padding: 8 }}>{loadErr}</div>}
      </div>

      {/* ---------------------------------------------------- select & edit */}
      <div style={{ borderLeft: "1px solid var(--border)", overflowY: "auto", padding: 12 }} className="col">
        <div className="label"><span className="a">[ edit ]</span> // point, then ask</div>
        <div className="row mono" style={{ fontSize: 12 }}>
          <span className={`led ${selCount ? "on" : "off"}`} />
          <span className="grow">{selCount ? `${selCount.toLocaleString()} vertices selected` : "nothing selected"}</span>
        </div>
        <Field label={`brush size · ${radius}%`}><input type="range" min={1} max={40} value={radius} onChange={(e) => setRadius(Number(e.target.value))} /></Field>
        <div className="row wrap" style={{ gap: 6 }}>
          <button className="btn sm" onClick={() => { selectAll(parts.current); afterSelection(); }}>all</button>
          <button className="btn sm" onClick={() => { growSelection(parts.current); afterSelection(); }}>grow</button>
          <button className="btn sm" onClick={() => { clearSelection(parts.current); afterSelection(); }}>clear</button>
          <button className={`btn sm${showSel ? " on" : ""}`} onClick={() => setShowSel(!showSel)}>show</button>
        </div>

        <Field label="what should change?">
          <textarea className="textarea" rows={3} value={instruction} disabled={!meshPath}
            placeholder={'"make this bigger", "smooth it", "paint it red", "pull it up a bit", "remove this"'}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitInstruction(); } }} />
        </Field>
        <button className="btn primary" disabled={!meshPath || planning || !instruction.trim()} onClick={submitInstruction}>
          {planning ? "thinking…" : "apply"}
        </button>
        <div className="dim" style={{ fontSize: 12 }}>
          {loaded ? <>Instructions are planned by <b>{loaded.name}</b>.</> : <>No chat model loaded: simple keywords only. Load one for richer edits.</>}
        </div>

        <div className="label" style={{ marginTop: 6 }}>quick edits</div>
        <div className="grid2" style={{ gap: 6 }}>
          <button className="btn sm" onClick={() => runOps([{ op: "scale", factor: 1.15 }], "button")}>bigger</button>
          <button className="btn sm" onClick={() => runOps([{ op: "scale", factor: 0.87 }], "button")}>smaller</button>
          <button className="btn sm" onClick={() => runOps([{ op: "inflate", amount: 0.015 }], "button")}>puff</button>
          <button className="btn sm" onClick={() => runOps([{ op: "inflate", amount: -0.012 }], "button")}>thin</button>
          <button className="btn sm" onClick={() => runOps([{ op: "smooth", iterations: 3 }], "button")}>smooth</button>
          <button className="btn sm" onClick={() => runOps([{ op: "flatten", strength: 0.6 }], "button")}>flatten</button>
          <button className="btn sm" onClick={() => runOps([{ op: "move", dx: 0, dy: 0.03, dz: 0 }], "button")}>up</button>
          <button className="btn sm" onClick={() => runOps([{ op: "move", dx: 0, dy: -0.03, dz: 0 }], "button")}>down</button>
          {/* A labelled swatch: a bare colour input reads as an empty box. */}
          <label className="btn sm" style={{ gap: 6, cursor: "pointer" }} title="paint the selection">
            <input type="color" defaultValue="#ffb020" style={{ width: 16, height: 16, padding: 0, border: 0, background: "none", cursor: "pointer" }}
              onChange={(e) => runOps([{ op: "color", hex: e.target.value }], "button")} />
            paint
          </label>
          <button className="btn sm danger" onClick={() => runOps([{ op: "delete" }], "button")}>delete</button>
        </div>

        <div className="row" style={{ marginTop: 6 }}>
          <button className="btn sm" onClick={doUndo} title="Ctrl+Z">undo</button>
          <button className="btn sm" onClick={doRedo} title="Ctrl+Y">redo</button>
          <span className="grow" />
          <button className="btn sm primary" disabled={!meshPath} onClick={saveGlb}>save .glb</button>
        </div>
        {meshPath && <button className="btn ghost sm" onClick={() => api.reveal(meshPath)}>reveal original</button>}

        {log.length > 0 && <div className="log selectable">{log.join("\n")}</div>}
      </div>
    </div>
  );
}
