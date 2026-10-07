// Paths and behaviour. Stored in ~/.arcflare/config.json — the same file the
// CLI reads, so the app and `arcflare` agree on everything.

import { useEffect, useState } from "react";
import { api, type Settings as S, type SystemInfo } from "../lib/api";
import { Field, Label, Panel } from "../ui/kit";

export function Settings({ info }: { info: SystemInfo | null }) {
  const [s, setS] = useState<S | null>(null);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { api.settings().then(setS).catch((e) => setErr(e.message)); }, []);
  if (!s) return <div className="page muted">{err || "…"}</div>;

  const set = <K extends keyof S>(k: K, v: S[K]) => { setS({ ...s, [k]: v }); setSaved(false); };
  const pick = async (k: keyof S, directory = false) => {
    const p = await api.pickFile({ directory });
    if (p) set(k, p as never);
  };
  const save = async () => {
    setErr("");
    try { await api.saveSettings(s); setSaved(true); } catch (e) { setErr((e as Error).message); }
  };

  return (
    <div className="page" style={{ maxWidth: 820 }}>
      <Label index="07">settings</Label>
      <div className="h1">Settings</div>
      <p className="muted" style={{ marginTop: 0 }}>Shared with the <code className="md-code">arcflare</code> command line: change it in either place.</p>

      <Panel title="engine">
        <div className="col">
          <Field label="llama-server">
            <div className="row">
              <input className="input" value={s.llamaServer} placeholder={info?.llamaServer || "found automatically"} onChange={(e) => set("llamaServer", e.target.value)} />
              <button className="btn sm" onClick={() => pick("llamaServer")}>browse</button>
            </div>
          </Field>
          <Field label="memory profile">
            <select className="select" value={s.memoryProfile} onChange={(e) => set("memoryProfile", e.target.value)}>
              <option value="lean">lean · 512 MiB prompt cache, sleeps after 5 min</option>
              <option value="balanced">balanced · 2 GiB prompt cache, sleeps after 15 min</option>
              <option value="max">max · 8 GiB cache, 4 models resident, never sleeps</option>
            </select>
          </Field>
          <label className="row" style={{ gap: 8 }}>
            <input type="checkbox" checked={s.stopServerOnQuit} onChange={(e) => set("stopServerOnQuit", e.target.checked)} />
            Stop the model server when the app closes (frees the GPU; untick to keep it for the CLI)
          </label>
        </div>
      </Panel>

      <div style={{ height: 12 }} />
      <Panel title="studio">
        <div className="col">
          <Field label="gpu memory between chat and studio">
            <select className="select" value={s.studioVram} onChange={(e) => set("studioVram", e.target.value as S["studioVram"])}>
              <option value="auto">auto · a studio job that won't fit unloads the chat model; chat reloads it when you need it</option>
              <option value="keep">keep · never unload the chat model (jobs may run out of memory)</option>
            </select>
          </Field>
          <Field label="python for 3D and speech (optional)">
            <div className="row">
              <input className="input" value={s.genPython} placeholder="ArcFlare's own environment" onChange={(e) => set("genPython", e.target.value)} />
              <button className="btn sm" onClick={() => pick("genPython")}>browse</button>
            </div>
          </Field>
          <Field label="stable-diffusion.cpp (sd / sd-cli)">
            <div className="row">
              <input className="input" value={s.sdcpp} placeholder="found automatically" onChange={(e) => set("sdcpp", e.target.value)} />
              <button className="btn sm" onClick={() => pick("sdcpp")}>browse</button>
            </div>
          </Field>
          <Field label="image models folder">
            <div className="row">
              <input className="input" value={s.imageModelsDir} placeholder="next to sd.cpp, and ~/.arcflare/image-models" onChange={(e) => set("imageModelsDir", e.target.value)} />
              <button className="btn sm" onClick={() => pick("imageModelsDir", true)}>browse</button>
            </div>
          </Field>
          <Field label="comfyui address">
            <input className="input" value={s.comfyUrl} onChange={(e) => set("comfyUrl", e.target.value)} />
          </Field>
        </div>
      </Panel>

      <div className="row" style={{ marginTop: 14 }}>
        <button className="btn primary" onClick={save}>save</button>
        {saved && <span style={{ color: "var(--accent-2)" }} className="mono">saved</span>}
        {err && <span className="err">{err}</span>}
        <span className="grow" />
        <button className="btn ghost" onClick={() => api.openStudioFolder()}>open studio folder</button>
      </div>
    </div>
  );
}
