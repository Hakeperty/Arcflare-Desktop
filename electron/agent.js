// The ArcFlare coding agent, inside the app.
//
// The same Agent the CLI runs (arcflare/lib/agent): same system prompt, tools,
// skills, MCP servers and trust gate for a folder's own MCP config. What this
// file adds is what a window needs instead of a terminal: a transcript kept in
// the main process (so leaving the screen loses nothing), approvals answered
// by buttons, and a stop button.
//
// One session per folder. Only one turn runs at a time across sessions — they
// share one model on one GPU anyway.

const fs = require("fs");
const http = require("http");
const path = require("path");

const { Agent } = require("arcflare/lib/agent/agent");
const run = require("arcflare/lib/agent/run");
const skillsmod = require("arcflare/lib/agent/skills");
const trust = require("arcflare/lib/agent/trust");
const models = require("arcflare/lib/models");

const MAX_TOOL_OUT = 6000;   // characters of a tool result kept for the screen
const MAX_ITEMS = 600;       // transcript entries kept per session

// ------------------------------------------------------------------ stop ----
//
// Fallback for engines without Agent.abort(): its model requests go through its own http.Agent to
// /v1/chat/completions, so they can be recognised here and destroyed: that
// rejects the stream, and the Agent's loop ends the turn through its normal
// error path. Requests made by the Chat screen carry no `agent` option and are
// never touched.
const inflight = new Set();
let tracking = 0;
const origRequest = http.request;
http.request = function patchedRequest(...args) {
  const req = origRequest.apply(this, args);
  const o = args[0];
  if (tracking > 0 && o && typeof o === "object" && o.agent && o.path === "/v1/chat/completions") {
    inflight.add(req);
    req.on("close", () => inflight.delete(req));
  }
  return req;
};

// --------------------------------------------------------------- helpers ----

function gitBranch(dir) {
  try {
    const head = fs.readFileSync(path.join(dir, ".git", "HEAD"), "utf8").trim();
    const m = /^ref: refs\/heads\/(.+)$/.exec(head);
    return m ? m[1] : head.slice(0, 8);
  } catch { return null; }
}

/** The machine server, started through this same executable in Node mode. */
function machineServer() {
  let bin = require.resolve("arcflare/bin/arcflare-mcp.js");
  const unpacked = bin.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  if (unpacked !== bin && fs.existsSync(unpacked)) bin = unpacked;
  return { command: process.execPath, args: [bin], env: { ELECTRON_RUN_AS_NODE: "1" } };
}

function summarize(args) {
  const a = args || {};
  let d = a.path || a.pattern || a.command || a.name || a.query || a.tool || a.url || "";
  if (typeof d !== "string") d = JSON.stringify(d);
  return String(d).slice(0, 200);
}

const id = () => Math.random().toString(36).slice(2, 10);

// --------------------------------------------------------------- sessions ----

module.exports = function createAgents(eng) {
  const sessions = new Map(); // sessionId -> session
  let running = null;         // sessionId with a turn in flight

  const emit = (ch, p) => eng.bus.emit(ch, p);

  function publicSession(s) {
    return {
      sessionId: s.id, folder: s.folder, branch: gitBranch(s.folder), model: s.modelName,
      auto: s.auto, machine: s.machine, busy: running === s.id, stopping: !!s.stopping,
      notes: s.notes, stats: s.stats, items: s.items,
    };
  }
  const pushStatus = (s) => emit("agent:status", {
    sessionId: s.id, busy: running === s.id, stopping: !!s.stopping, auto: s.auto, stats: s.stats, model: s.modelName,
  });

  function upsert(s, item) {
    const i = s.items.findIndex((x) => x.id === item.id);
    if (i >= 0) s.items[i] = item; else s.items.push(item);
    if (s.items.length > MAX_ITEMS) s.items.splice(0, s.items.length - MAX_ITEMS);
    emit("agent:item", { sessionId: s.id, item });
  }

  /** The last assistant entry of the turn in progress, made if needed. */
  function assistantItem(s) {
    const last = s.items[s.items.length - 1];
    if (last && last.kind === "assistant" && !last.done) return last;
    const item = { id: id(), kind: "assistant", content: "", reasoning: "", done: false };
    upsert(s, item);
    return item;
  }

  function onEvent(s, ev) {
    switch (ev.type) {
      case "content":
      case "reasoning": {
        if (s.stopping) return;
        const item = assistantItem(s);
        if (ev.type === "content") item.content += ev.text; else item.reasoning += ev.text;
        emit("agent:delta", { sessionId: s.id, itemId: item.id, kind: ev.type, text: ev.text });
        return;
      }
      case "tool": {
        const last = s.items[s.items.length - 1];
        if (last && last.kind === "assistant" && !last.done) { last.done = true; upsert(s, last); }
        let args = "";
        try { args = JSON.stringify(ev.args || {}, null, 2).slice(0, 4000); } catch { /* unserialisable */ }
        upsert(s, { id: id(), kind: "tool", name: ev.name, detail: summarize(ev.args), args, out: null, state: "running" });
        return;
      }
      case "tool_result": {
        const item = [...s.items].reverse().find((x) => x.kind === "tool" && x.name === ev.name && x.state === "running");
        if (!item) return;
        const out = String(ev.out ?? "");
        item.out = out.length > MAX_TOOL_OUT ? out.slice(0, MAX_TOOL_OUT) + `\n… (${out.length - MAX_TOOL_OUT} more characters)` : out;
        item.state = out.startsWith("ERROR") ? "error" : "done";
        upsert(s, item);
        return;
      }
      case "compact":
        upsert(s, { id: id(), kind: "note", text: `context compacted (${ev.actions.length} change${ev.actions.length === 1 ? "" : "s"}) to stay inside the window` });
        return;
      case "error":
        // A stop shows up here as the destroyed request; say it plainly.
        upsert(s, s.stopping
          ? { id: id(), kind: "note", text: "stopped" }
          : { id: id(), kind: "error", text: /^stopped after 0 steps/.test(ev.text) ? "stopped" : ev.text });
        return;
      case "done": {
        const last = s.items[s.items.length - 1];
        if (last && last.kind === "assistant" && !last.done) { last.done = true; upsert(s, last); }
        return;
      }
    }
  }

  /** The approver the Agent's tools call: a card in the transcript, answered by buttons. */
  function approver(s) {
    return (kind, detail) => {
      if (s.auto || s.always) return Promise.resolve(true);
      if (s.stopping) return Promise.resolve(false);
      const item = { id: id(), kind: "approval", what: kind, detail: String(detail).slice(0, 4000), state: "pending" };
      upsert(s, item);
      return new Promise((resolve) => s.pending.set(item.id, { item, resolve }));
    };
  }

  function settleApprovals(s, allow) {
    for (const [, p] of s.pending) { p.item.state = allow ? "allowed" : "denied"; upsert(s, p.item); p.resolve(allow); }
    s.pending.clear();
  }

  async function build(s) {
    const m = await eng.ensureChatModel();
    const meta = (() => { try { const mod = models.resolve(models.discover({ meta: true }), m.id); return mod ? models.loadMeta(mod) || {} : {}; } catch { return {}; } })();

    const { cfg: mcpCfg, gate } = run.resolveMcpConfig(s.folder, { machine: false });
    if (s.machine && !(mcpCfg.servers && mcpCfg.servers.arcflare)) {
      mcpCfg.servers = { arcflare: machineServer(), ...(mcpCfg.servers || {}) };
    }
    s.notes = [];
    const withheld = trust.explain(gate);
    if (withheld) s.notes.push(withheld);
    const skills = skillsmod.discover(s.folder);
    if (skills.length) s.notes.push(`${skills.length} skill${skills.length === 1 ? "" : "s"}: ${skills.map((k) => k.name).slice(0, 6).join(", ")}`);
    const { reg, results } = await run.connectMcp(mcpCfg);
    for (const r of results) s.notes.push(r.ok ? `mcp ${r.name}: ${r.tools} tools` : `mcp ${r.name}: ${r.error}`);
    if (s.reg) s.reg.stopAll();
    s.reg = reg;

    const previous = s.agent ? s.agent.messages.slice(1) : [];
    s.agent = new Agent({
      port: m.port, model: m.servedId, cwd: s.folder,
      mcp: reg.all().length ? reg : null,
      skills, nCtx: m.ctx, sampling: meta.sampling || null, maxSteps: 40,
      approve: approver(s),
      onEvent: (ev) => onEvent(s, ev),
    });
    // A model reload keeps the conversation; the system prompt is the same.
    if (previous.length) s.agent.messages.push(...previous);
    // Refuse any tool the model asks for after Stop was pressed.
    const exec = s.agent.execute;
    s.agent.execute = (name, args) => (s.stopping ? Promise.resolve("ERROR: stopped by the user") : exec(name, args));
    s.modelKey = `${m.port}|${m.servedId}|${m.ctx}`;
    s.modelName = m.name || m.id;
  }

  async function open(folder, opts = {}) {
    const dir = path.resolve(String(folder || ""));
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error("pick a folder");
    const existing = [...sessions.values()].find((s) => s.folder === dir);
    if (existing && (opts.machine === undefined || opts.machine === existing.machine)) return publicSession(existing);
    if (existing) dispose(existing.id);
    const s = {
      id: id(), folder: dir, machine: opts.machine !== false, auto: false, always: false,
      agent: null, reg: null, items: [], pending: new Map(), notes: [], stopping: false,
      stats: null, modelKey: null, modelName: null,
    };
    sessions.set(s.id, s);
    return publicSession(s);
  }

  function get(sessionId) {
    const s = sessions.get(sessionId);
    if (!s) throw new Error("that agent session is gone — open the folder again");
    return s;
  }

  async function send(sessionId, text) {
    const s = get(sessionId);
    const body = String(text || "").trim();
    if (!body) throw new Error("empty message");
    if (running) throw new Error(running === s.id ? "a turn is already running" : "another folder's agent is working — wait or stop it");
    running = s.id;
    s.stopping = false;
    upsert(s, { id: id(), kind: "user", text: body });
    pushStatus(s);
    tracking++;
    try {
      const m = await eng.ensureChatModel();
      if (!s.agent || s.modelKey !== `${m.port}|${m.servedId}|${m.ctx}`) {
        upsert(s, { id: id(), kind: "note", text: s.agent ? "the model changed — reconnecting, the conversation is kept" : "starting the agent…" });
        await build(s);
      }
      // Stop pressed while the model was (re)loading or the session starting:
      // end here, before anything is generated.
      if (s.stopping) {
        upsert(s, { id: id(), kind: "note", text: "stopped" });
        s.agent.messages.push({ role: "user", content: body }, { role: "assistant", content: "[stopped by the user]" });
        return { ok: false, stats: null };
      }
      const t0 = Date.now();
      // The Agent's stats add up over the session; this turn is the difference.
      const before = { steps: s.agent.stats.steps, toolCalls: s.agent.stats.toolCalls, tps: s.agent.stats.tps.length };
      const r = await s.agent.send(body);
      const st = s.agent.stats;
      const tpsList = st.tps.slice(before.tps);
      const tps = tpsList.length ? tpsList.reduce((a, b) => a + b, 0) / tpsList.length : null;
      s.stats = {
        steps: st.steps - before.steps, toolCalls: st.toolCalls - before.toolCalls,
        tokPerSec: tps ? Math.round(tps * 10) / 10 : null, seconds: Math.round((Date.now() - t0) / 100) / 10,
      };
      // A stopped turn leaves the question unanswered in the history; record
      // what was said so far, so the next turn alternates user/assistant.
      const msgs = s.agent.messages;
      if (s.stopping && msgs.length && msgs[msgs.length - 1].role !== "assistant") {
        // Only this turn's words: the entries after the question just asked.
        const lastUser = s.items.map((x) => x.kind).lastIndexOf("user");
        const said = s.items.slice(lastUser + 1).filter((x) => x.kind === "assistant").map((x) => x.content).join("\n\n");
        msgs.push({ role: "assistant", content: (said ? said + "\n\n" : "") + "[stopped by the user]" });
      }
      return { ok: !!(r && r.ok), stats: s.stats };
    } catch (e) {
      upsert(s, { id: id(), kind: "error", text: e.message });
      throw e;
    } finally {
      tracking--;
      settleApprovals(s, false);
      const last = s.items[s.items.length - 1];
      if (last && last.kind === "assistant" && !last.done) { last.done = true; upsert(s, last); }
      if (s.agent) s.agent.maxSteps = 40;
      s.stopping = false;
      running = null;
      pushStatus(s);
    }
  }

  function stop(sessionId) {
    const s = get(sessionId);
    if (running !== s.id) return false;
    s.stopping = true;
    if (s.agent) s.agent.maxSteps = 0;   // no further model calls this turn
    settleApprovals(s, false);
    // Engines with Agent.abort() stop the model stream and any running shell
    // command (with its children). Older engines: destroy the request instead.
    if (s.agent && typeof s.agent.abort === "function") s.agent.abort();
    else for (const req of inflight) req.destroy(new Error("stopped"));
    pushStatus(s);
    return true;
  }

  function answer(sessionId, approvalId, allow, always) {
    const s = get(sessionId);
    const p = s.pending.get(approvalId);
    if (!p) return false;
    s.pending.delete(approvalId);
    if (always && allow) s.always = true;
    p.item.state = allow ? (always ? "allowed for this session" : "allowed") : "denied";
    upsert(s, p.item);
    p.resolve(!!allow);
    return true;
  }

  function setAuto(sessionId, on) {
    const s = get(sessionId);
    s.auto = !!on;
    if (s.auto) settleApprovals(s, true);
    pushStatus(s);
    return s.auto;
  }

  /** Forget the conversation (and restart the session's MCP servers on next use). */
  function clear(sessionId) {
    const s = get(sessionId);
    if (running === s.id) throw new Error("stop the turn first");
    if (s.reg) s.reg.stopAll();
    s.reg = null; s.agent = null; s.items = []; s.stats = null; s.always = false; s.modelKey = null;
    pushStatus(s);
    return publicSession(s);
  }

  function dispose(sessionId) {
    const s = sessions.get(sessionId);
    if (!s) return;
    if (running === s.id) stop(s.id);
    if (s.reg) s.reg.stopAll();
    sessions.delete(sessionId);
  }

  return {
    open,
    state: (sessionId) => publicSession(get(sessionId)),
    list: () => [...sessions.values()].map((s) => ({ sessionId: s.id, folder: s.folder, busy: running === s.id })),
    send, stop, answer, setAuto, clear, close: dispose,
    shutdown: () => { for (const k of [...sessions.keys()]) dispose(k); },
  };
};
