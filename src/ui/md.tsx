// Just enough Markdown for chat replies: fenced code (with a copy button),
// headings, lists, paragraphs, and inline `code`, **bold**, *italic*.
// Rendered as React elements — never as HTML — so a model's output can't
// inject markup into the app.

import { Fragment, memo, useState } from "react";

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
  return (
    <div className="md-pre">
      <div className="md-pre-h">
        <span>{lang || "code"}</span>
        <button className="btn ghost sm" onClick={() => {
          navigator.clipboard.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }).catch(() => {});
        }}>{copied ? "copied" : "copy"}</button>
      </div>
      <pre className="selectable">{code}</pre>
    </div>
  );
}

export type Chunk = { code: false; lines: string[] } | { code: true; lang: string; text: string };

// Split lines into prose and fenced-code chunks. An unterminated fence (a reply
// still streaming) runs to the end.
export function splitFences(lines: string[]): Chunk[] {
  const out: Chunk[] = [];
  let i = 0;
  while (i < lines.length) {
    // CommonMark: the info string of a backtick fence has no backtick, and a closing
    // fence is at least as long as the opening one with only spaces after it.
    const fence = /^(`{3,})\s*([\w+-]*)[^`]*$/.exec(lines[i].trim());
    if (fence) {
      const buf: string[] = [];
      const close = new RegExp("^`{" + fence[1].length + ",}\\s*$");
      i++;
      while (i < lines.length && !close.test(lines[i].trim())) buf.push(lines[i++]);
      i++;
      out.push({ code: true, lang: fence[2], text: buf.join("\n") });
      continue;
    }
    const last = out[out.length - 1];
    if (last && !last.code) last.lines.push(lines[i]);
    else out.push({ code: false, lines: [lines[i]] });
    i++;
  }
  return out;
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const out: React.ReactNode[] = [];
  let k = 0;
  for (const chunk of splitFences(text.replace(/\r\n/g, "\n").split("\n"))) {
    if (chunk.code) { out.push(<CodeBlock key={k++} lang={chunk.lang} code={chunk.text} />); continue; }
    const lines = chunk.lines;
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
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
      while (i < lines.length && lines[i].trim() && !/^#{1,3}\s|^\s*([-*]|\d+\.)\s+/.test(lines[i])) para.push(lines[i++]);
      out.push(<p key={k++} className="md-p">{inline(para.join("\n"))}</p>);
    }
  }
  return <div className="md selectable">{out}</div>;
});
