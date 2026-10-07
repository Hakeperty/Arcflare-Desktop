// The studio: image, 3D, speech and flows, one tab each, able to hand work to
// each other — an image goes to 3D, a flow's mesh opens in the 3D editor.

import { useState } from "react";
import type { LoadedModel } from "../lib/api";
import { ImageTab } from "./studio/ImageTab";
import { Model3DTab } from "./studio/Model3D";
import { SpeechTab } from "./studio/SpeechTab";
import { FlowTab } from "./studio/Flow";

export type StudioTab = "image" | "3d" | "speech" | "flow";

/** How tabs hand files to each other. */
export type Handoff = {
  /** Show this mesh in the 3D tab (and switch to it). */
  openMesh: (path: string) => void;
  /** Use this image as the input of a 3D generation (and switch to 3D). */
  imageTo3D: (path: string) => void;
  /** Switch tabs. */
  go: (tab: StudioTab) => void;
};

export function Studio({ loaded }: { loaded: LoadedModel | null }) {
  const [tab, setTab] = useState<StudioTab>("image");
  const [mesh, setMesh] = useState<{ path: string; at: number } | null>(null);
  const [inputImage, setInputImage] = useState<{ path: string; at: number } | null>(null);

  const handoff: Handoff = {
    openMesh: (path) => { setMesh({ path, at: Date.now() }); setTab("3d"); },
    imageTo3D: (path) => { setInputImage({ path, at: Date.now() }); setTab("3d"); },
    go: setTab,
  };

  const TABS: [StudioTab, string][] = [["image", "image"], ["3d", "3d model"], ["speech", "speech"], ["flow", "flow"]];

  return (
    <div className="page flush">
      <div className="tabs">
        {TABS.map(([id, label]) => (
          <button key={id} className={`tab${tab === id ? " on" : ""}`} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      {/* Kept mounted so a running job, a loaded mesh or a half-built flow
          survives switching tabs. */}
      <div style={{ flex: 1, minHeight: 0, display: tab === "image" ? "flex" : "none" }}><ImageTab handoff={handoff} /></div>
      <div style={{ flex: 1, minHeight: 0, display: tab === "3d" ? "flex" : "none" }}>
        <Model3DTab handoff={handoff} openMesh={mesh} inputImage={inputImage} loaded={loaded} active={tab === "3d"} />
      </div>
      <div style={{ flex: 1, minHeight: 0, display: tab === "speech" ? "flex" : "none" }}><SpeechTab /></div>
      <div style={{ flex: 1, minHeight: 0, display: tab === "flow" ? "flex" : "none" }}><FlowTab handoff={handoff} loaded={loaded} /></div>
    </div>
  );
}
