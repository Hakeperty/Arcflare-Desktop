// Read-only view of the agent sessions saved on this computer: the ones from
// `arcflare agent` and the ones the phone started through the hub.
//
// Both kinds are ~/.arcflare/sessions/<id>.json. The phone's are the ids the
// hub lists in hub/agents.json (only that one field is read; the hub's tokens
// and accounts live elsewhere and are never touched). The renderer sends a
// source name and an id, never a path: the id must match ID, and the file's
// real path must stay inside the sessions folder.

const fs = require("fs");
const path = require("path");

const ID = /^\d{8}-\d{4}-[0-9a-f]{6}$/;      // same shape as the engine's newId()
const SOURCES = new Set(["cli", "phone"]);
const MAX_LIST = 200;
const MAX_FILE = 5 * 1024 * 1024;            // a bigger file is skipped, not parsed
const MAX_TEXT = 20000;                      // per message shown

const sessionsDir = (home) => path.join(home, "sessions");

/** Session ids the hub started for the phone. A missing or broken file means none. */
function phoneIds(home) {
  try {
    const f = path.join(home, "hub", "agents.json");
    if (fs.statSync(f).size > MAX_FILE) return new Set();
    const a = JSON.parse(fs.readFileSync(f, "utf8")).agents;
    return new Set((Array.isArray(a) ? a : []).map((r) => r && r.sessionId).filter((x) => typeof x === "string" && ID.test(x)));
  } catch { return new Set(); }
}

/** Parsed session file for id, or null. Throws for an id or path that is not allowed. */
function readDoc(home, id) {
  if (typeof id !== "string" || !ID.test(id)) throw new Error("not a session id");
  const root = fs.realpathSync(sessionsDir(home));
  const real = fs.realpathSync(path.join(root, id + ".json"));
  if (!real.startsWith(root + path.sep)) throw new Error("not a session id");
  if (fs.statSync(real).size > MAX_FILE) return null;
  return JSON.parse(fs.readFileSync(real, "utf8"));
}

/** Newest first, at most MAX_LIST, from every saved source. */
function list(home) {
  let names;
  try { names = fs.readdirSync(sessionsDir(home)); } catch { return []; }
  const phone = phoneIds(home);
  const out = [];
  const ids = names.filter((n) => n.endsWith(".json") && ID.test(n.slice(0, -5))).map((n) => n.slice(0, -5));
  for (const id of ids.sort().reverse().slice(0, MAX_LIST)) {   // ids start with the date
    let j;
    try { j = readDoc(home, id); } catch { continue; }          // corrupt, oversized or escaping: skipped
    if (!j || typeof j !== "object") continue;
    out.push({
      source: phone.has(id) ? "phone" : "cli", id,
      title: typeof j.title === "string" ? j.title.slice(0, 120) : "",
      folder: typeof j.cwd === "string" ? j.cwd : "",
      model: typeof j.model === "string" ? j.model : null,
      updated: typeof j.updated === "string" ? j.updated : "",
    });
  }
  return out.sort((a, b) => b.updated.localeCompare(a.updated));
}

/** The conversation as plain text, for a read-only view. */
function read(home, source, id) {
  if (!SOURCES.has(source)) throw new Error("unknown source");
  if ((phoneIds(home).has(id) ? "phone" : "cli") !== source) throw new Error("no such session");
  const j = readDoc(home, id);
  if (!j || !Array.isArray(j.messages)) throw new Error("session too large or unreadable");
  const messages = j.messages.filter((m) => m && typeof m === "object").map((m) => {
    let text = typeof m.content === "string" ? m.content : "";
    const calls = Array.isArray(m.tool_calls) ? m.tool_calls.map((c) => c && c.function && c.function.name).filter(Boolean) : [];
    if (calls.length) text += (text ? "\n\n" : "") + calls.map((c) => `[tool: ${String(c).slice(0, 60)}]`).join(" ");
    return { role: ["user", "assistant", "tool"].includes(m.role) ? m.role : "other", text: text.slice(0, MAX_TEXT) };
  });
  return { source, id, folder: typeof j.cwd === "string" ? j.cwd : "", model: typeof j.model === "string" ? j.model : null, messages };
}

module.exports = { list, read, ID };
