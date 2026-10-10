// npm run test:smoke — launch the built app and visit every view.
//
// Drives the real Electron app over the Chrome DevTools Protocol (Node's
// built-in WebSocket; no Playwright). For each view: click it in the sidebar,
// check the title bar says so and the view rendered, and fail on any uncaught
// exception, console error, or the renderer going away. Works with no model
// and no llama.cpp: the app runs against a throwaway ARCFLARE_HOME and home
// folder, so it never sees or touches the real ~/.arcflare.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const electronBin = createRequire(import.meta.url)("electron");
const TIMEOUT = Number(process.env.SMOKE_TIMEOUT_MS || 120000);

if (!existsSync(join(root, "dist", "index.html"))) {
  console.error("dist/ is missing: run `npx vite build` first (npm run test:smoke does).");
  process.exit(1);
}

// ------------------------------------------------------------- sandbox ----

const tmp = mkdtempSync(join(tmpdir(), "arcflare-smoke-"));
const home = join(tmp, "home");
const arcHome = join(tmp, "arcflare");
for (const d of [home, arcHome, join(tmp, "appdata"), join(tmp, "config")]) mkdirSync(d, { recursive: true });
// First-run setup already done, so the welcome flow doesn't cover the views.
writeFileSync(join(arcHome, "config.json"), JSON.stringify({ setupDone: true }));

const env = {
  ...process.env,
  ARCFLARE_HOME: arcHome,
  HOME: home,
  USERPROFILE: home,
  APPDATA: join(tmp, "appdata"),
  XDG_CONFIG_HOME: join(tmp, "config"),
  ARCFLARE_NO_UPDATE_CHECK: "1",
  ELECTRON_ENABLE_LOGGING: "1",
};
delete env.ARCFLARE_FORCE_SETUP;
delete env.ARCFLARE_DEV_URL;
delete env.ELECTRON_RUN_AS_NODE;

const args = [".", "--remote-debugging-port=0", `--user-data-dir=${join(tmp, "userdata")}`];
if (process.platform === "linux") args.push("--no-sandbox", "--disable-gpu");

// ------------------------------------------------------------- launch ----

const problems = [];
const mainLog = [];
const app = spawn(electronBin, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });

let wsUrlResolve;
const devtools = new Promise((r) => { wsUrlResolve = r; });
const onOutput = (chunk) => {
  for (const line of String(chunk).split(/\r?\n/)) {
    if (!line.trim()) continue;
    mainLog.push(line);
    const m = /DevTools listening on (ws:\/\/[^\s]+)/.exec(line);
    if (m) wsUrlResolve(m[1]);
    // main.js reports page errors, failed loads and renderer crashes on stderr.
    if (/^\[(page|load|renderer)\]/.test(line)) problems.push(`main process: ${line}`);
    if (/Uncaught|UnhandledPromiseRejection|Error: Cannot find module/.test(line)) problems.push(`main process: ${line}`);
  }
};
app.stdout.on("data", onOutput);
app.stderr.on("data", onOutput);
app.on("exit", (code) => { if (!finished) problems.push(`app exited early (code ${code})`); });

let finished = false;
let ws;

function killApp() {
  if (app.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(app.pid), "/T", "/F"], { stdio: "ignore" });
  else app.kill("SIGKILL");
}

const deadline = setTimeout(() => {
  console.error(`smoke test timed out after ${TIMEOUT} ms`);
  console.error(mainLog.slice(-30).join("\n"));
  killApp();
  process.exit(1);
}, TIMEOUT);

// ---------------------------------------------------------------- CDP ----

let nextId = 0;
const waiting = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  waiting.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ""}`);
  return r.result?.value;
}
async function until(expression, what, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await evaluate(expression).catch(() => false)) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(150);
  }
}

async function connect() {
  const browserWs = await Promise.race([devtools, sleep(30000).then(() => null)]);
  if (!browserWs) throw new Error("the app never opened a DevTools port");
  const port = new URL(browserWs).port;
  // The page target appears once the window has loaded dist/index.html.
  let page;
  for (let i = 0; i < 100 && !page; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      page = targets.find((t) => t.type === "page" && /index\.html/.test(t.url));
    } catch { /* not up yet */ }
    if (!page) await sleep(200);
  }
  if (!page) throw new Error("no app window appeared");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener("open", r, { once: true }); ws.addEventListener("error", j, { once: true }); });
  ws.addEventListener("message", (m) => {
    const d = JSON.parse(m.data);
    if (d.id && waiting.has(d.id)) {
      const w = waiting.get(d.id);
      waiting.delete(d.id);
      if (d.error) w.reject(new Error(d.error.message)); else w.resolve(d.result);
      return;
    }
    if (d.method === "Runtime.exceptionThrown") {
      const e = d.params.exceptionDetails;
      problems.push(`uncaught: ${e.exception?.description ?? e.text}`);
    } else if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") {
      problems.push(`console.error: ${d.params.args.map((a) => a.value ?? a.description ?? "").join(" ")}`);
    } else if (d.method === "Log.entryAdded" && d.params.entry.level === "error") {
      problems.push(`log error: ${d.params.entry.text} ${d.params.entry.url ?? ""}`);
    } else if (d.method === "Inspector.targetCrashed") {
      problems.push("renderer crashed");
    }
  });
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Inspector.enable").catch(() => {});
}

// --------------------------------------------------------------- views ----

const VIEWS = ["home", "chat", "agent", "studio", "models", "harnesses", "jobs", "settings"];
const STUDIO_TABS = ["image", "3d model", "speech", "flow"];
const results = [];

const clickNav = (label) => evaluate(`(() => {
  const b = [...document.querySelectorAll(".sidebar .nav")].find((x) => x.textContent.replace(/\\^\\d|⌘\\d/, "").trim().replace(/^\\//, "").trim().startsWith(${JSON.stringify(label)}));
  if (!b) return false;
  b.click();
  return true;
})()`);

const viewOk = (label) => `(() => {
  const app = document.querySelector(".app");
  const title = document.querySelector(".titlebar");
  const main = document.querySelector("main.main");
  return !!app && !!title && title.textContent.includes("// " + ${JSON.stringify(label)}) && !!main && main.innerText.trim().length > 20;
})()`;

async function checkView(label) {
  const before = problems.length;
  if (!(await clickNav(label))) throw new Error(`no sidebar entry for "${label}"`);
  await until(viewOk(label), `the ${label} view`);
  await sleep(400); // let effects run and first IPC calls settle
  if (!(await evaluate(viewOk(label)))) throw new Error(`${label} view disappeared after rendering`);
  const errs = problems.slice(before);
  results.push({ name: label, ok: errs.length === 0, errs });
}

async function checkStudioTab(tab) {
  const before = problems.length;
  const clicked = await evaluate(`(() => {
    const t = [...document.querySelectorAll("main .tab")].find((x) => x.textContent.trim().toLowerCase() === ${JSON.stringify(tab)});
    if (!t) return false;
    t.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`no studio tab "${tab}"`);
  await until(`(() => { const t = [...document.querySelectorAll("main .tab")].find((x) => x.textContent.trim().toLowerCase() === ${JSON.stringify(tab)}); return !!t && t.className.split(/\\s+/).includes("on"); })()`, `the ${tab} tab to be active`);
  await sleep(500);
  if (!(await evaluate(viewOk("studio")))) throw new Error(`studio broke on the ${tab} tab`);
  results.push({ name: `studio › ${tab}`, ok: problems.length === before, errs: problems.slice(before) });
}

// ----------------------------------------------------------- artifacts ----
//
// A saved conversation with an HTML page and a React component in it: each
// must open in the panel and actually run inside the sandboxed preview frame.
// The artifacts post what they rendered back to the page, which is the only
// way out of the frame.

const ARTIFACT_CONVO = [{
  id: "smoke", title: "artifacts", system: "", created: 1,
  turns: [
    { id: "u1", role: "user", content: "make a page" },
    { id: "a1", role: "assistant", content: [
      "Here is a page.",
      '<artifact id="smoke-page" type="html" title="Smoke page">',
      '<!doctype html><html><head><title>x</title></head><body><h1 id="h">hello from html</h1>',
      '<script>parent.postMessage({ arc: 1, type: "smoke", text: document.getElementById("h").textContent }, "*")</script></body></html>',
      "</artifact>",
      '<artifact id="smoke-react" type="react" title="Smoke component">',
      'import { useEffect, useState } from "react";',
      "export default function App() {",
      "  const [n, setN] = useState(41);",
      "  useEffect(() => { setN(42); }, []);",
      '  useEffect(() => { if (n === 42) parent.postMessage({ arc: 1, type: "smoke", text: document.body.innerText.trim() }, "*"); }, [n]);',
      "  return <p>react says {n}</p>;",
      "}",
      "</artifact>",
    ].join("\n") },
  ],
}];

async function checkArtifact(title, expect) {
  const before = problems.length;
  await evaluate(`(() => { window.__smoke = []; return true; })()`);
  const clicked = await evaluate(`(() => {
    const c = [...document.querySelectorAll(".art-card")].find((x) => x.textContent.includes(${JSON.stringify(title)}));
    if (!c) return false;
    c.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`no card for the artifact "${title}"`);
  await until(`(window.__smoke || []).some((t) => t === ${JSON.stringify(expect)})`, `"${expect}" from the ${title} preview`);
  const err = await evaluate(`document.querySelector(".art-foot .err")?.textContent || ""`);
  results.push({ name: `artifact › ${title}`, ok: problems.length === before && !err, errs: [...problems.slice(before), ...(err ? [err] : [])] });
}

async function checkArtifacts() {
  await evaluate(`(() => { localStorage.setItem("arcflare.chats", ${JSON.stringify(JSON.stringify(ARTIFACT_CONVO))}); location.reload(); return true; })()`);
  await sleep(500);
  await until(`document.querySelectorAll(".sidebar .nav").length >= ${VIEWS.length}`, "the sidebar after reload");
  await evaluate(`(() => { addEventListener("message", (e) => { if (e.data && e.data.type === "smoke") (window.__smoke = window.__smoke || []).push(e.data.text); }); return true; })()`);
  await clickNav("chat");
  await until(viewOk("chat"), "the chat view");
  await checkArtifact("Smoke page", "hello from html");
  await checkArtifact("Smoke component", "react says 42");
}

// ----------------------------------------------------------------- run ----

let failed = false;
try {
  await connect();
  await until(`document.querySelectorAll(".sidebar .nav").length >= ${VIEWS.length}`, "the sidebar");
  results.push({ name: "startup", ok: problems.length === 0, errs: problems.slice() });
  for (const v of VIEWS) {
    await checkView(v);
    if (v === "studio") for (const t of STUDIO_TABS) await checkStudioTab(t);
  }
  await checkArtifacts();
  // Keyboard switching (Ctrl+1 → home) goes through the same state.
  await evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "1", ctrlKey: true })), true`);
  await until(viewOk("home"), "Ctrl+1 to show home");
  results.push({ name: "ctrl+1 shortcut", ok: true, errs: [] });
} catch (e) {
  failed = true;
  results.push({ name: "run", ok: false, errs: [String(e && e.message || e)] });
}
finished = true;

// Anything that arrived after the per-view windows still counts.
const reported = new Set(results.flatMap((r) => r.errs));
const late = problems.filter((p) => !reported.has(p));
if (late.length) results.push({ name: "late errors", ok: false, errs: late });

for (const r of results) {
  console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name}`);
  for (const e of r.errs) console.log(`     ${e.slice(0, 400)}`);
}
failed = failed || results.some((r) => !r.ok);
console.log(failed ? `\nsmoke: FAILED (${results.filter((r) => !r.ok).length} of ${results.length})` : `\nsmoke: ${results.length} checks passed`);
if (failed) console.log("\nlast app output:\n" + mainLog.slice(-25).join("\n"));

clearTimeout(deadline);
try { ws?.close(); } catch { /* closing anyway */ }
killApp();
await sleep(300);
try { rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows may hold a file briefly */ }
process.exit(failed ? 1 : 0);
