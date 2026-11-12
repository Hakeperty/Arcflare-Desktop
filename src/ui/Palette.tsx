import { useEffect, useMemo, useRef, useState } from "react";
import { filterPalette, type PaletteItem } from "../lib/palette";

/** Ctrl/Cmd+K overlay: type to filter, arrows to move, Enter to run, Esc to close. */
export function Palette({ items, onRun, onClose }: {
  items: PaletteItem[]; onRun: (id: string) => void; onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useMemo(() => filterPalette(items, q), [items, q]);
  const at = Math.min(sel, Math.max(0, list.length - 1));
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    document.querySelector(".palette-row.on")?.scrollIntoView({ block: "nearest" });
  }, [at, q]);

  const run = (id: string) => { onClose(); onRun(id); };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setSel(list.length ? (at + 1) % list.length : 0); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel(list.length ? (at - 1 + list.length) % list.length : 0); }
    else if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); if (list[at]) run(list[at].id); }
  };

  return (
    <div className="modal-back palette-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal palette" role="dialog" aria-label="Command palette" onKeyDown={onKeyDown}>
        <input ref={input} className="input palette-input" value={q} placeholder="Type a command or a view"
          aria-label="Command" onChange={(e) => { setQ(e.target.value); setSel(0); }} />
        <div className="palette-list" role="listbox">
          {list.length === 0 && <div className="dim palette-none">Nothing matches.</div>}
          {list.map((it, i) => (
            <div key={it.id} role="option" aria-selected={i === at} className={`palette-row${i === at ? " on" : ""}`}
              onMouseMove={() => setSel(i)} onClick={() => run(it.id)}>
              <span className="grow truncate">{it.label}</span>
              {it.hint && <span className="kbd">{it.hint}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
