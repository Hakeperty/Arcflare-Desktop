// "Control from your phone": the QR code for the remote-control link, its
// status, and the switch. The conversation itself shows in Chat as "Phone".

import { useEffect, useRef, useState } from "react";
import { on, rc, type RcStatus } from "../lib/api";

/** Live remote-control status, shared by the title bar, the panel and Chat. */
export function useRemote(): RcStatus | null {
  const [s, setS] = useState<RcStatus | null>(null);
  useEffect(() => {
    rc.status().then(setS).catch(() => {});
    return on("rc:status", (x: RcStatus) => setS(x));
  }, []);
  return s;
}

export function PhoneButton({ status, onClick }: { status: RcStatus | null; onClick: () => void }) {
  const live = status?.on;
  return (
    <button className={`btn sm nodrag${live ? " on" : ""}`} onClick={onClick} title="Control ArcFlare from your phone">
      <span className={`led ${live ? (status?.connected ? "on" : "busy") : "off"}`} />
      phone{live && status && status.clients > 0 ? ` · ${status.clients}` : ""}
    </button>
  );
}

export function PhonePanel({ status, onClose, onOpenChat }: { status: RcStatus | null; onClose: () => void; onOpenChat: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  // A second click that lands just after the switch flipped (a double click,
  // or a click queued while it was starting) must not undo it straight away.
  const flipped = useRef(0);
  async function toggle() {
    if (Date.now() - flipped.current < 1500) return;
    setBusy(true);
    setErr("");
    try { if (status?.on) await rc.stop(); else await rc.start(); } catch (e) { setErr((e as Error).message); }
    flipped.current = Date.now();
    setBusy(false);
  }

  async function copy() {
    if (!status) return;
    try { await navigator.clipboard.writeText(status.link); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* no clipboard */ }
  }

  const on_ = !!status?.on;
  const qrSrc = status ? `data:image/svg+xml;utf8,${encodeURIComponent(status.qrSvg)}` : "";

  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-label="Control from your phone">
        <div className="modal-h">
          <span className="a" style={{ color: "var(--accent)" }}>[ rc ]</span> {"//"} control from your phone
          <span className="grow" />
          <button className="btn ghost sm" onClick={onClose}>esc</button>
        </div>
        <div className="modal-b">
          <div>
            {qrSrc && <img className={`qr${on_ ? "" : " dim"}`} src={qrSrc} alt="QR code for the remote-control link" />}
            {!on_ && <div className="dim mono" style={{ fontSize: 11, marginTop: 6, textAlign: "center" }}>start to use the code</div>}
          </div>
          <div className="col" style={{ gap: 12 }}>
            <div style={{ fontSize: 14, lineHeight: 1.55 }}>
              Scan the code with your phone&apos;s camera and chat with the model on this computer, from any network.
              Nothing listens on a port: the app and your phone both talk to the relay over HTTPS.
            </div>
            <div className="row mono" style={{ fontSize: 12, gap: 8 }}>
              <span className={`led ${on_ ? (status?.connected ? "on" : "busy") : "off"}`} />
              {on_ ? (status?.connected ? "relay connected" : "connecting…") : "off"}
              {on_ && <span className="dim">· {status?.clients ?? 0} phone{status?.clients === 1 ? "" : "s"} watching</span>}
            </div>
            {status?.note && on_ && <div className="dim mono" style={{ fontSize: 11 }}>⇄ {status.note}</div>}
            <div className="linkbox">{status?.link ?? "…"}</div>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <button className={`btn${on_ ? " danger" : " primary"}`} onClick={toggle} disabled={busy || !status}>
                {busy ? "…" : on_ ? "stop" : "start"}
              </button>
              <button className="btn" onClick={copy} disabled={!status}>{copied ? "copied" : "copy link"}</button>
              <button className="btn ghost" onClick={() => { onOpenChat(); onClose(); }}>open the phone chat</button>
            </div>
            {err && <div className="err">{err}</div>}
            <div className="dim" style={{ fontSize: 12, lineHeight: 1.5 }}>
              Anyone with this link can use the chat, so treat it like a password. It&apos;s the same key as <span className="mono">/rc</span> in
              the CLI ({status?.keyHint}); <span className="mono">arcflare rc rotate</span> makes a new one. Relay: {status?.relay}.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
