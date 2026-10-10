// The React runtime for artifact previews, built on its own into
// dist/runtime/react-runtime.js (scripts/build-runtime.mjs) and loaded by the
// preview frame, never by the app. It turns the model's JSX/TSX into a
// function with Sucrase and renders the default export. Offline: React is the
// only module there is.

import * as React from "react";
import * as ReactDOM from "react-dom";
import * as ReactDOMClient from "react-dom/client";
import * as JsxRuntime from "react/jsx-runtime";
import { transform } from "sucrase";

declare global {
  interface Window { __arcReport?: (e: unknown) => void }
}

const MODULES: Record<string, unknown> = {
  react: React,
  "react-dom": ReactDOM,
  "react-dom/client": ReactDOMClient,
  "react/jsx-runtime": JsxRuntime,
};

function report(e: unknown) {
  if (window.__arcReport) window.__arcReport(e);
  const pre = document.createElement("pre");
  pre.style.cssText = "margin:16px;padding:12px;border:1px solid #ff4d3d;color:#ff4d3d;background:#1a0f0e;white-space:pre-wrap;font:12px ui-monospace,Menlo,Consolas,monospace";
  pre.textContent = String((e as Error)?.message || e);
  document.body.appendChild(pre);
}

class Boundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { if (window.__arcReport) window.__arcReport(error); }
  render() {
    if (this.state.error) {
      return React.createElement("pre", {
        style: { margin: 16, padding: 12, border: "1px solid #ff4d3d", color: "#ff4d3d", whiteSpace: "pre-wrap", font: "12px ui-monospace,Menlo,Consolas,monospace" },
      }, String(this.state.error.message || this.state.error));
    }
    return this.props.children;
  }
}

export function run(source: string) {
  try {
    const code = transform(source, { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "classic", production: true }).code;
    const module: { exports: Record<string, unknown> } = { exports: {} };
    const require = (name: string) => {
      if (name in MODULES) return MODULES[name];
      if (/\.css$/.test(name)) return {};
      throw new Error(`"${name}" isn't available: previews run offline with React only.`);
    };
    // A component that was defined but not exported still renders.
    const tail = `\n;if(!module.exports.default){var __c=typeof App!=="undefined"?App:typeof Component!=="undefined"?Component:null;if(__c)module.exports.default=__c;}`;
    new Function("React", "require", "module", "exports", code + tail)(React, require, module, module.exports);
    let C = module.exports.default as React.ComponentType | undefined;
    if (typeof C !== "function") C = Object.values(module.exports).find((v) => typeof v === "function") as React.ComponentType | undefined;
    if (!C) throw new Error("Nothing to render: export a component, e.g. export default function App() { … }");
    const root = document.getElementById("root") || document.body.appendChild(document.createElement("div"));
    ReactDOMClient.createRoot(root).render(React.createElement(Boundary, null, React.createElement(C)));
  } catch (e) {
    report(e);
  }
}
