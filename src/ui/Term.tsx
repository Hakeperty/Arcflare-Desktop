// Plain-words help for the jargon local AI is full of. Wrap a word in
// <Term k="vram">VRAM</Term> and it gets a dotted underline and a short
// explanation on hover or keyboard focus. Esc closes it.

import { useId, useState } from "react";

export const GLOSSARY = {
  gguf: ["GGUF", "The file format local language models come in. One .gguf file holds the whole model, ready for llama.cpp."],
  quant: ["Quant (Q4, Q5, Q8…)", "How much the model was compressed. Lower numbers are smaller and faster but a little less accurate; Q4–Q5 is the usual sweet spot."],
  context: ["Context", "How much text the model can keep in mind at once: your messages, its replies and any files. Bigger needs more memory."],
  tokens: ["Tokens", "The pieces of text models read and write — roughly ¾ of a word each. Context and speed are counted in tokens."],
  toks: ["tok/s", "Tokens per second: how fast the model writes. Around 10 feels like reading speed; 40+ feels instant."],
  vram: ["VRAM", "Your graphics card's own memory. The model has to fit in it (plus room for context) to run fast. On Macs it's shared with system memory."],
  moe: ["MoE", "Mixture of experts: a big model that only uses a small part of itself for each token, so it runs much faster than its size suggests."],
  harness: ["Harness", "A coding tool like OpenCode, Codex or Hermes. ArcFlare points it at your local model instead of a paid cloud one."],
  mcp: ["MCP", "Model Context Protocol: a standard way to give a model tools — files, a browser, apps on your computer."],
  llamacpp: ["llama.cpp", "The free, open engine that actually runs language models on your GPU. ArcFlare starts it, sizes it and talks to it for you."],
} as const;

export type TermKey = keyof typeof GLOSSARY;

export function Term({ k, children }: { k: TermKey; children?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const [title, body] = GLOSSARY[k];
  return (
    <span
      className="term"
      tabIndex={0}
      aria-describedby={open ? id : undefined}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onKeyDown={(e) => { if (e.key === "Escape") { setOpen(false); e.stopPropagation(); } }}
    >
      {children ?? title}
      {open && (
        <span role="tooltip" id={id} className="term-tip">
          <b>{title}</b>
          {body}
        </span>
      )}
    </span>
  );
}
