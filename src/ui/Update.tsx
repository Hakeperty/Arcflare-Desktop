// Updates: a live status hook, and a small title-bar pill that only appears
// when there is something to do (downloading, ready to restart, or a new
// version to fetch from the release page).

import { useEffect, useState } from "react";
import { api, on, updates, type UpdateStatus } from "../lib/api";

export function useUpdates(): UpdateStatus | null {
  const [s, setS] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    updates.status().then(setS).catch(() => {});
    return on("update:status", (x: UpdateStatus) => setS(x));
  }, []);
  return s;
}

export function UpdatePill({ status }: { status: UpdateStatus | null }) {
  if (!status) return null;
  if (status.state === "downloading") {
    return (
      <span className="chip warn nodrag" title={`Downloading ArcFlare ${status.version ?? ""}`}>
        <span className="led busy" /> update {status.percent ?? 0}%
      </span>
    );
  }
  if (status.state === "ready") {
    return (
      <button
        className="btn sm nodrag on"
        title="Restart now to install. Otherwise it installs the next time you quit."
        onClick={() => updates.install().catch(() => {})}
      >
        <span className="led on" /> {status.version} ready · restart
      </button>
    );
  }
  if (status.state === "available" && status.url) {
    return (
      <button
        className="btn sm nodrag"
        title="This build can't update itself. Opens the download page."
        onClick={() => api.openExternal(status.url!).catch(() => {})}
      >
        <span className="led busy" /> update {status.version} available
      </button>
    );
  }
  return null;
}

/** One line of text for Settings. */
export function updateText(s: UpdateStatus | null): string {
  if (!s) return "…";
  switch (s.state) {
    case "unsupported": return "development build: updates are off";
    case "checking": return "checking…";
    case "idle": return s.lastChecked ? `up to date · checked ${new Date(s.lastChecked).toLocaleTimeString()}` : "not checked yet";
    case "downloading": return `downloading ${s.version} · ${s.percent ?? 0}%`;
    case "ready": return `${s.version} downloaded: restart to install`;
    case "available": return s.mode === "link" ? `${s.version} is out: download it from the release page` : `${s.version} is available`;
    case "error": return `couldn't check: ${s.error ?? "unknown error"}`;
  }
}
