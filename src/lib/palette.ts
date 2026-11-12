// Command palette matching. Pure, so it can be tested without a window.

export type PaletteItem = { id: string; label: string; hint?: string };

/** Items whose label contains every typed word (case-insensitive). Label-start matches come first; order is otherwise kept. */
export function filterPalette<T extends PaletteItem>(items: T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return items;
  const scored: { item: T; score: number; i: number }[] = [];
  items.forEach((item, i) => {
    const label = item.label.toLowerCase();
    if (!words.every((w) => label.includes(w))) return;
    const score = label.startsWith(words[0]) ? 0 : label.split(/\s+/).some((p) => p.startsWith(words[0])) ? 1 : 2;
    scored.push({ item, score, i });
  });
  return scored.sort((a, b) => a.score - b.score || a.i - b.i).map((s) => s.item);
}
