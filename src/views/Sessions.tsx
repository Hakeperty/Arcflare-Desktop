// Every agent session on this computer in one list: started in the app, from
// the command line, or from the phone. App sessions open in the Agent view;
// the others show their saved conversation read-only. All text is shown as
// text (Markdown component), never as HTML.

import { useEffect, useState } from "react";
import { sessions, type SessionSummary, type SessionTranscript } from "../lib/api";
import { Markdown } from "../ui/md";
import { baseName } from "../lib/path";

const WHERE = { app: "app", cli: "command line", phone: "phone" } as const;

export function Sessions({ onOpenApp }: { onOpenApp: (folder: string) => void }) {
  const [rows, setRows] = useState<SessionSummary[] | null>(null);
  const [view, setView] = useState<SessionTranscript | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => { sessions.list().then(setRows).catch((e) => setErr((e as Error).message)); }, []);

  function open(r: SessionSummary) {
    setErr("");
    if (r.source === "app") return onOpenApp(r.folder);
    sessions.read(r.source, r.id).then(setView).catch((e) => setErr((e as Error).message));
  }

  if (view) {
    return (
      <div className="col" style={{ gap: 10 }}>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn sm" onClick={() => setView(null)}>back to sessions</button>
          <span className="dim mono truncate" style={{ fontSize: 12 }}>{WHERE[view.source]} · {view.folder} · {view.model ?? "?"} · read-only</span>
        </div>
        {view.messages.map((m, i) => (
          <div key={i} className="col" style={{ gap: 2 }}>
            <span className="label">{m.role}</span>
            {m.text ? <Markdown text={m.text} /> : <span className="dim">(no text)</span>}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="col" style={{ gap: 6 }}>
      {err && <div className="err">{err}</div>}
      {rows && rows.length === 0 && <span className="dim">No sessions yet.</span>}
      {rows?.map((r) => (
        <button key={`${r.source}:${r.id}`} className="btn ghost" style={{ textAlign: "left", display: "block" }} onClick={() => open(r)}
          title={r.source === "app" ? "Open in the agent" : "Read the saved conversation"}>
          <div className="truncate">{r.title || "(no message yet)"}</div>
          <div className="dim mono truncate" style={{ fontSize: 11 }}>
            <span className="chip">{WHERE[r.source]}</span> {baseName(r.folder)} · {r.model ?? "?"} · {new Date(r.updated).toLocaleString()}
          </div>
        </button>
      ))}
    </div>
  );
}
