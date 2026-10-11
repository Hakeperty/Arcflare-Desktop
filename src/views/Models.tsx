// Models on this machine, ready to load. Finding and downloading new ones is
// the Shop's job.

import { useEffect, useState } from "react";
import { api, type LoadedModel, type LocalModel, type ModelProgress } from "../lib/api";
import { EmptyState, Meter, Progress, ViewHead, fmtCtx } from "../ui/kit";
import { progressText, type View } from "../App";
import { Term } from "../ui/Term";
import { EngineBanner } from "../ui/Engine";

export function Models({ loaded, progress, go, freeGb, engine, refresh }: {
  loaded: LoadedModel | null; progress: ModelProgress | null; go: (v: View) => void;
  freeGb?: number | null; engine: boolean | null; refresh: () => void;
}) {
  return (
    <div className="page">
      {engine === false && <EngineBanner onDone={refresh} />}
      <Local loaded={loaded} progress={progress} go={go} freeGb={freeGb ?? null} />
    </div>
  );
}

function Local({ loaded, progress, go, freeGb }: { loaded: LoadedModel | null; progress: ModelProgress | null; go: (v: View) => void; freeGb: number | null }) {
  const [list, setList] = useState<LocalModel[] | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { api.models().then(setList).catch((e) => setErr(e.message)); }, []);

  async function load(id: string) {
    setErr(""); setBusy(id);
    try { await api.loadModel(id); } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }

  if (!list) return <div className="muted">Reading GGUF headers…</div>;
  return (
    <>
      <ViewHead index="06" label="models" title="On this machine" right={<button className="btn sm" onClick={() => go("shop")}>get more in the shop</button>}>
        GGUF models ArcFlare found in your llama.cpp cache and model folders. Loading sizes the context to the VRAM that&apos;s actually free.
      </ViewHead>
      {err && <div className="err" style={{ marginBottom: 10 }}>{err}</div>}
      {progress && busy && !["loaded", "failed"].includes(progress.stage) && (
        <div className="panel" style={{ padding: 10, marginBottom: 12 }}>
          <div className="mono dim" style={{ fontSize: 12, marginBottom: 6 }}>{progressText(progress)}</div>
          <Progress value={null} />
        </div>
      )}
      {list.length === 0 && (
        <EmptyState seed="no-models" title="No models yet" action={<button className="btn primary" onClick={() => go("shop")}>open the shop</button>}>
          The shop shows what fits your GPU. Pick one, download it, and it appears here.
        </EmptyState>
      )}
      <div className="col" style={{ gap: 8 }}>
        {list.map((m) => {
          const isLoaded = loaded?.id === m.id;
          return (
            <div key={m.id} className={`card model-row${isLoaded ? " loaded" : ""}`}>
              <span className={`led ${isLoaded ? "on" : m.fits === false ? "err" : "off"}`} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="mono truncate" style={{ fontWeight: 600 }}>{m.id}</div>
                <div className="dim mono" style={{ fontSize: 12 }}>
                  <Term k="quant">{m.quant}</Term> · {m.sizeGb} GB · trained {fmtCtx(m.trainCtx)} <Term k="context">ctx</Term>{m.moe ? <> · <Term k="moe">MoE</Term> {m.moe}</> : ""}{m.vision ? " · vision" : ""}
                  {m.bestCtx ? ` · ${fmtCtx(m.bestCtx)} fits now` : ""}
                </div>
              </div>
              {freeGb
                ? <Meter need={m.sizeGb} of={isLoaded ? m.sizeGb + freeGb : freeGb}
                    label={isLoaded ? "loaded" : m.sizeGb <= freeGb ? `${Math.round((m.sizeGb / freeGb) * 100)}% of free VRAM` : "bigger than free VRAM"} />
                : <span />}
              {isLoaded
                ? <button className="btn sm on" onClick={() => go("chat")}>chat →</button>
                : <button className={`btn sm${busy === m.id ? " on" : ""}`} disabled={!!busy} onClick={() => load(m.id)}>{busy === m.id ? "loading…" : "load"}</button>}
            </div>
          );
        })}
      </div>
    </>
  );
}
