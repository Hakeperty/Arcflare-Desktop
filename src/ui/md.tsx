// Just enough Markdown for chat replies: fenced code (with a copy button),
// headings, lists, paragraphs, and inline `code`, **bold**, *italic*.
// Rendered as React elements — never as HTML — so a model's output can't
// inject markup into the app.

import { Fragment, createContext, useContext, useState } from "react";

/**
 * Set by the chat: opens a fenced block of HTML, SVG or JSX in the artifact
 * panel, for replies that wrote one without the artifact tags.
 */
export const PreviewCode = createContext<((lang: string, code: string) => void) | null>(null);
const PREVIEW_LANGS = /^(html|svg|xml|jsx|tsx|react)$/i;

const INLINE = /(`[^`]+`|\*\*(?=\S)[^*]+\*\*|\*(?=\S)[^*]+\*)/g;

function inline(text: string) {
  return text.split(INLINE).map((p, i) => {
    if (p.startsWith("`") && p.endsWith("`") && p.length > 1) return <code key={i} className="md-code">{p.slice(1, -1)}</code>;
    if (p.startsWith("**") && p.endsWith("**") && p.length > 4) return <strong key={i}>{p.slice(2, -2)}</strong>;
    if (p.startsWith("*") && p.endsWith("*") && p.length > 2) return <em key={i}>{p.slice(1, -1)}</em>;
    return <Fragment key={i}>{p}</Fragment>;
  });
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const preview = useContext(PreviewCode);
  const canPreview = preview && PREVIEW_LANGS.test(lang) && (lang.toLowerCase() !== "xml" || /<svg[\s>]/i.test(code)) && code.split("\n").length >= 4;
  return (
    <div className="md-pre">
      <div className="md-pre-h">
        <span className="grow">{lang || "code"}</span>
        {canPreview && <button className="btn ghost sm" onClick={() => preview(lang, code)}>preview</button>}
        <button className="btn ghost sm" onClick={() => {
          navigator.clipboard.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }).catch(() => {});
        }}>{copied ? "copied" : "copy"}</button>
      </div>
      <pre className="selectable">{code}</pre>
    </div>
  );
}

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: React.ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^```\s*([\w+-]*)/.exec(line.trim());
    if (fence) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) buf.push(lines[i++]);
      i++;
      out.push(<CodeBlock key={k++} lang={fence[1]} code={buf.join("\n")} />);
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) { out.push(<div key={k++} className={`md-h md-h${h[1].length}`}>{inline(h[2])}</div>); i++; continue; }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ""));
      const L = ordered ? "ol" : "ul";
      out.push(<L key={k++} className="md-list">{items.map((it, j) => <li key={j}>{inline(it)}</li>)}</L>);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const para: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^```|^#{1,3}\s|^\s*([-*]|\d+\.)\s+/.test(lines[i])) para.push(lines[i++]);
    out.push(<p key={k++} className="md-p">{inline(para.join("\n"))}</p>);
  }
  return <div className="md selectable">{out}</div>;
}
