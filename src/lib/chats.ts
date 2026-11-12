// Pure helpers for the chat list: search and Markdown export.

type TurnLike = { role: string; content: string };
type ConvoLike = { title: string; turns: TurnLike[] };

/** Conversations whose title or any message contains the text (case-insensitive). */
export function filterConvos<T extends ConvoLike>(convos: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return convos;
  return convos.filter((c) => c.title.toLowerCase().includes(q) || c.turns.some((t) => t.content.toLowerCase().includes(q)));
}

/** A conversation as Markdown. Reasoning is left out. */
export function convoToMarkdown(c: ConvoLike, modelName?: string | null): string {
  const bot = modelName || "Assistant";
  const blocks = c.turns
    .filter((t) => (t.role === "user" || t.role === "assistant") && t.content.trim())
    .map((t) => `**${t.role === "user" ? "You" : bot}**\n\n${t.content.trim()}`);
  return [`# ${c.title}`, ...blocks].join("\n\n") + "\n";
}
