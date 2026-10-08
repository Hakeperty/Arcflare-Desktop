// The coding tools ArcFlare can point at your model. They are terminal
// programs, so each opens in a terminal window, already configured.

import { useEffect, useState } from "react";
import { api, type Harness, type LoadedModel } from "../lib/api";
import { ViewHead } from "../ui/kit";

const ABOUT: Record<string, string> = {
  agent: "ArcFlare's own coding agent: reads and edits files, runs commands (it asks first), uses MCP tools and skills.",
  chat: "A plain streaming chat in the terminal.",
  opencode: "OpenCode, configured with an arcflare provider and the real context limit.",
  hermes: "Hermes, set up through its own config tool, working in the folder you choose.",
  "hermes-desktop": "Hermes Desktop, launched against your model.",
  codex: "OpenAI's Codex CLI, pointed at your local model instead of the cloud.",
};

export function Harnesses({ loaded }: { loaded: LoadedModel | null }) {
  const [list, setList] = useState<Harness[]>([]);
  const [msg, setMsg] = useState("");
  useEffect(() => { api.harnesses().then(setList).catch((e) => setMsg(e.message)); }, []);

  async function launch(h: Harness) {
    setMsg("");
    try {
      await api.launchHarness(h.id, loaded?.id);
      setMsg(`${h.label} is opening in a terminal window${loaded ? ` with ${loaded.name}` : " with your last model"}.`);
    } catch (e) { setMsg((e as Error).message); }
  }

  return (
    <div className="page">
      <ViewHead index="06" label="harnesses" title="Harnesses">
        Already use a coding agent? Open it here and it talks to the model on your GPU instead of a cloud API. ArcFlare
        writes its config (backing up yours first) and opens it in a terminal.
      </ViewHead>
      {msg && <div className="panel" style={{ padding: 10, marginBottom: 12, borderColor: "var(--accent-2)" }}>{msg}</div>}
      <div className="grid3">
        {list.map((h) => (
          <div key={h.id} className={`card col${h.installed ? " click" : ""}`} style={{ gap: 0 }} onClick={() => h.installed && launch(h)}>
            <div className="row">
              <span className={`led ${h.installed ? "on" : "off"}`} />
              <span className="h2 grow">{h.label}</span>
              {h.builtin && <span className="chip">built in</span>}
            </div>
            <p className="muted" style={{ fontSize: 13, flex: 1 }}>{ABOUT[h.id] || ""}</p>
            {h.installed
              ? <div className="go">open in a terminal →</div>
              : <div className="go" style={{ color: "var(--muted-2)" }}>not installed</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
