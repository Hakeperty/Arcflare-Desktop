// Artifacts: self-contained things a reply makes (a web page, an SVG, a React
// component, a document, a file of code) that open in a panel beside the chat
// instead of scrolling past as a code block. The model marks one with
//
//   <artifact id="pricing-page" type="html" title="Pricing page">…</artifact>
//
// and writing the same id again later makes a new version of it. Everything
// here is pure: parsing a reply into text and artifacts, collecting versions
// across a conversation, and building the document a preview runs.

export type ArtifactKind = "html" | "svg" | "react" | "markdown" | "code";

export type Artifact = {
  id: string;
  kind: ArtifactKind;
  title: string;
  /** Language, for kind "code" (and the code view of everything else). */
  lang: string;
  content: string;
  /** False while the closing tag hasn't streamed in yet. */
  closed: boolean;
};

export type Segment = { type: "text"; text: string } | { type: "artifact"; artifact: Artifact };

/** One artifact across a conversation: every version, oldest first. */
export type ArtifactThread = { id: string; title: string; kind: ArtifactKind; versions: (Artifact & { turnId: string })[] };

const OPEN = /<artifact\b([^>]*)>/i;
const CLOSE = /<\/artifact\s*>/i;
const TAG = "<artifact";

export const PREVIEWABLE: ReadonlySet<ArtifactKind> = new Set(["html", "svg", "react"]);

function attrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? "";
  return out;
}

/** "text/html", "application/vnd.ant.react", "jsx"… → one of our kinds. */
export function kindOf(type: string, lang = ""): ArtifactKind {
  const t = `${type} ${lang}`.toLowerCase();
  if (/react|jsx|tsx/.test(t)) return "react";
  if (/svg/.test(t)) return "svg";
  if (/html/.test(t)) return "html";
  if (/markdown|\bmd\b|document|text\/plain/.test(t)) return "markdown";
  return "code";
}

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "artifact";

/** Models often wrap the body in a ``` fence as well; take it off. */
function unfence(body: string): { body: string; lang: string } {
  const m = /^\s*```[ \t]*([\w+#.-]*)[^\n]*\n([\s\S]*?)(?:\n?```\s*)?$/.exec(body);
  if (m) return { body: m[2], lang: m[1] };
  return { body: body.replace(/^\s*\n/, "").replace(/\s+$/, ""), lang: "" };
}

const DEFAULT_LANG: Record<ArtifactKind, string> = { html: "html", svg: "svg", react: "jsx", markdown: "markdown", code: "" };

/** Split a reply into prose and artifacts. Handles a reply that's still streaming. */
export function splitArtifacts(text: string): Segment[] {
  const out: Segment[] = [];
  let rest = text;
  let n = 0;
  for (;;) {
    const open = OPEN.exec(rest);
    if (!open) break;
    if (open.index > 0) out.push({ type: "text", text: rest.slice(0, open.index) });
    const a = attrs(open[1]);
    const after = rest.slice(open.index + open[0].length);
    const close = CLOSE.exec(after);
    const raw = close ? after.slice(0, close.index) : after;
    const { body, lang: fenceLang } = unfence(raw);
    const kind = kindOf(a.type || "", a.language || a.lang || fenceLang);
    const title = a.title || a.id || `Artifact ${++n}`;
    out.push({
      type: "artifact",
      artifact: {
        id: slug(a.id || a.identifier || title), kind, title,
        lang: a.language || a.lang || fenceLang || DEFAULT_LANG[kind],
        content: body, closed: !!close,
      },
    });
    if (!close) return out;
    rest = after.slice(close.index + close[0].length);
  }
  // While streaming, hide a tag that has only half arrived ("…<artif").
  const lt = rest.lastIndexOf("<");
  if (lt >= 0) {
    const tail = rest.slice(lt).toLowerCase();
    if (!tail.includes(">") && tail.length > 1 && (TAG.startsWith(tail) || tail.startsWith(TAG))) rest = rest.slice(0, lt);
  }
  if (rest) out.push({ type: "text", text: rest });
  return out;
}

/** Every artifact in a conversation, newest first, with its versions in order. */
export function collectArtifacts(turns: { id: string; role: string; content: string }[]): ArtifactThread[] {
  const byId = new Map<string, ArtifactThread>();
  for (const t of turns) {
    if (t.role !== "assistant") continue;
    for (const s of splitArtifacts(t.content)) {
      if (s.type !== "artifact") continue;
      const a = s.artifact;
      let th = byId.get(a.id);
      if (!th) { th = { id: a.id, title: a.title, kind: a.kind, versions: [] }; byId.set(a.id, th); }
      else { byId.delete(a.id); byId.set(a.id, th); } // re-insert: most recently touched last
      th.title = a.title;
      th.kind = a.kind;
      th.versions.push({ ...a, turnId: t.id });
    }
  }
  return [...byId.values()].reverse();
}

/** Which version number (1-based) an artifact in a given turn is. */
export function versionIn(threads: ArtifactThread[], id: string, turnId: string): number {
  const th = threads.find((x) => x.id === id);
  if (!th) return 1;
  const i = th.versions.findIndex((v) => v.turnId === turnId);
  return i < 0 ? th.versions.length : i + 1;
}

// ------------------------------------------------------------- previews ----

/** What a file of this artifact is called when saved. */
export function fileName(a: Pick<Artifact, "id" | "kind" | "lang">): string {
  const ext: Record<ArtifactKind, string> = { html: "html", svg: "svg", react: "jsx", markdown: "md", code: "" };
  const codeExt: Record<string, string> = {
    javascript: "js", js: "js", typescript: "ts", ts: "ts", python: "py", py: "py", rust: "rs", go: "go",
    css: "css", json: "json", bash: "sh", sh: "sh", shell: "sh", c: "c", cpp: "cpp", "c++": "cpp", java: "java",
    csharp: "cs", "c#": "cs", ruby: "rb", php: "php", sql: "sql", yaml: "yml", yml: "yml", toml: "toml", lua: "lua",
    tsx: "tsx", jsx: "jsx", html: "html", svg: "svg", markdown: "md", md: "md", kotlin: "kt", swift: "swift",
  };
  const e = ext[a.kind] || codeExt[a.lang.toLowerCase()] || "txt";
  return `${a.id}.${e}`;
}

export const RUNTIME_URL = "arcview://view/_/react-runtime.js";

/**
 * Runs first in every preview. Talks to the app only by postMessage: reports
 * errors, follows the light/dark switch, and in "pick" mode outlines what's
 * under the pointer and sends back the element that was clicked.
 */
const BOOT = `(function(){
var P=window.parent,pick=false,hover=null,box=null;
function post(m){try{P.postMessage(Object.assign({arc:1},m),"*")}catch(e){}}
window.__arcReport=function(e){post({type:"error",message:String(e&&(e.stack||e.message)||e).slice(0,2000)})};
addEventListener("error",function(e){window.__arcReport(e.error||e.message)});
addEventListener("unhandledrejection",function(e){window.__arcReport(e.reason)});
function sel(el){var p=[];while(el&&el.nodeType===1&&p.length<5){var s=el.tagName.toLowerCase();if(el.id){p.unshift(s+"#"+el.id);break}var c=(el.getAttribute("class")||"").trim().split(/\\s+/).filter(Boolean).slice(0,2);if(c.length)s+="."+c.join(".");var par=el.parentElement;if(par){var same=[].filter.call(par.children,function(x){return x.tagName===el.tagName});if(same.length>1)s+=":nth-of-type("+(same.indexOf(el)+1)+")"}p.unshift(s);el=par}return p.join(" > ")}
function ensureBox(){if(box)return box;box=document.createElement("div");box.style.cssText="position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #ffb020;background:rgba(255,176,32,.12);transition:all .06s";document.documentElement.appendChild(box);return box}
function show(el){var b=ensureBox(),r=el.getBoundingClientRect();b.style.display="block";b.style.left=r.left+"px";b.style.top=r.top+"px";b.style.width=r.width+"px";b.style.height=r.height+"px"}
addEventListener("mousemove",function(e){if(!pick)return;var el=e.target;if(el&&el!==hover&&el!==box){hover=el;show(el)}},true);
addEventListener("click",function(e){if(!pick)return;e.preventDefault();e.stopPropagation();var el=e.target;var h=el.outerHTML||"";if(h.length>1500)h=h.slice(0,1500)+"…";post({type:"picked",selector:sel(el),tag:el.tagName.toLowerCase(),text:(el.textContent||"").trim().slice(0,200),html:h})},true);
addEventListener("message",function(e){var d=e.data||{};if(e.source!==P||!d.arc)return;
if(d.type==="theme"){var r=document.documentElement;if(d.theme==="auto"){r.removeAttribute("data-theme");r.style.colorScheme=""}else{r.setAttribute("data-theme",d.theme);r.style.colorScheme=d.theme}}
if(d.type==="pick"){pick=!!d.on;document.documentElement.style.cursor=pick?"crosshair":"";if(!pick&&box)box.style.display="none"}});
post({type:"ready"});
})();`;

const bootTag = `<script>${BOOT}</script>`;
const META = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`;

/** Safe to drop inside an inline <script>. */
const scriptJson = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

/** The HTML document a preview frame loads, or null for kinds shown natively. */
export function buildDocument(a: Pick<Artifact, "kind" | "content" | "title">): string | null {
  const title = a.title.replace(/[<>&]/g, "");
  switch (a.kind) {
    case "html": {
      const src = a.content;
      if (/<head[^>]*>/i.test(src)) return src.replace(/<head[^>]*>/i, (m) => `${m}${bootTag}`);
      if (/<html[^>]*>/i.test(src)) return src.replace(/<html[^>]*>/i, (m) => `${m}<head>${bootTag}</head>`);
      return `<!doctype html><html><head>${META}<title>${title}</title>${bootTag}</head><body>${src}</body></html>`;
    }
    case "svg":
      return `<!doctype html><html><head>${META}<title>${title}</title>${bootTag}<style>html,body{margin:0;height:100%}body{display:grid;place-items:center;background:#fff}@media (prefers-color-scheme:dark){body{background:#111}}svg{max-width:100%;max-height:100vh;height:auto}</style></head><body>${a.content}</body></html>`;
    case "react":
      return `<!doctype html><html><head>${META}<title>${title}</title>${bootTag}<style>html,body{margin:0}</style></head><body><div id="root"></div><script src="${RUNTIME_URL}"></script><script>if(window.ArcRuntime)ArcRuntime.run(${scriptJson(a.content)});else window.__arcReport("The React runtime didn't load (dist/runtime is missing: run npm run build).");</script></body></html>`;
    default:
      return null;
  }
}

// --------------------------------------------------------------- prompts ----

/** Appended to the system prompt while artifacts are on. Short: local models have small contexts. */
export const ARTIFACT_PROMPT = `
You can create artifacts: substantial, self-contained content the user will view, reuse or edit, shown in a panel next to the chat. Use one for a web page, an app or game, an SVG, a React component, a document over ~20 lines, or a complete code file. Do not use one for short snippets, explanations or answers.

Write an artifact like this, then keep talking normally outside the tags:
<artifact id="short-kebab-id" type="html" title="Readable title">
...the full content, no code fences...
</artifact>

Types: html (a complete page; CSS and JS inline), svg, react (one component in JSX: import from "react" only, export default the component, style with inline styles or a <style> element), markdown (a document), code (add language="python" etc).
Previews run offline: no external scripts, fonts, images or network requests; inline everything.
To change an artifact, write it again in full with the same id. Never say you can't show visuals: write an artifact.`.trim();

/** Appended in design mode, after ARTIFACT_PROMPT. */
export const DESIGN_PROMPT = `
Design mode: you are a senior product designer who writes production front-end code. When asked for a page, screen, component or visual, answer with an html artifact (or react when asked) that looks finished, not like a wireframe.
- Define colors, radii and spacing as CSS custom properties on :root, and support light and dark: redefine the colors under @media (prefers-color-scheme: dark) for :root:not([data-theme="light"]), and under :root[data-theme="dark"]. Give body an explicit background and color.
- Use a system font stack, a clear type scale (e.g. 14/16/20/28/40px), comfortable line height and a 4px/8px spacing rhythm.
- One accent color used sparingly; subtle borders and shadows; generous whitespace; aligned edges.
- Responsive from 360px phones to wide desktops with CSS grid/flex; no horizontal scroll.
- Real, specific content (names, numbers, copy) instead of lorem ipsum. Icons as inline SVG.
- Accessible: sufficient contrast, semantic elements, visible focus states, labels on inputs.
- Interactive where it helps (hover, tabs, toggles, a working form) with small inline JS.
Briefly say what you made and what you'd try next. When the user asks for a change to a picked element, rewrite the whole artifact with the same id.`.trim();

export const DESIGN_STARTERS = [
  "A landing page for a local-first note-taking app",
  "An analytics dashboard with KPIs, a chart and a table",
  "A mobile onboarding screen with three steps",
  "A pricing section with three plans and a monthly/yearly toggle",
];
