// Control from your phone: the desktop app as a remote-control host.
//
// Same relay, key and protocol as `/rc` in the CLI (arcflare/lib/rc): the app
// long-polls the relay, so it works from any network, and the phone opens
// <relay>/remote#k=<key>, which a QR code carries. The key lives in
// ~/.arcflare/rc.json, so a phone paired with the CLI is already paired here.
//
// The phone talks to one conversation, owned here in the main process: a turn
// typed on the phone runs even when the Chat screen is closed. The Chat screen
// mirrors it as a "Phone" conversation (rc:turn events, and rc:status for the
// history so far), streaming the same chat:delta events as any other chat.

const os = require("os");
const rc = require("arcflare/lib/rc");
const qr = require("arcflare/lib/qr");
const serve = require("arcflare/lib/serve");

const SYSTEM = "You are a helpful assistant running locally on the user's own computer. "
  + "The user is writing from their phone, so keep answers clear and reasonably short.";
const MAX_HISTORY = 40; // messages kept for context; older ones fall off

module.exports = function createRemote(eng) {
  let session = null;
  let history = [];           // { role, content, from? }
  let queue = Promise.resolve();
  let busyId = null;
  let lastNote = "";
  let generation = 0;         // bumps on stop, so an old wait loop ends

  const send = (channel, payload) => eng.bus.emit(channel, payload);

  function status() {
    const relay = rc.relayUrl(serve.loadConfig());
    const key = rc.getKey();
    const link = rc.linkFor(relay, key);
    return {
      on: !!(session && session.active),
      connected: !!(session && session.connected),
      clients: session ? session.clients : 0,
      relay,
      link,
      keyHint: rc.redact(key),
      qrSvg: qr.toSvg(qr.encode(link), { quiet: 3 }),
      note: lastNote,
      busy: !!busyId,
      history: history.map(({ role, content, from }) => ({ role, content, from })),
    };
  }

  const pushStatus = () => send("rc:status", status());

  function info() {
    const loaded = eng.state.loaded;
    return {
      host: os.hostname(),
      kind: "desktop chat",
      model: loaded ? loaded.name || loaded.id : "no model loaded",
      cwd: "ArcFlare desktop",
    };
  }

  /** One turn, from the phone or from the Phone conversation on the desktop. */
  function turn(text, from) {
    queue = queue.then(async () => {
      const live = session && session.active ? session : null;
      const requestId = "rc-" + Math.random().toString(36).slice(2, 10);
      history.push({ role: "user", content: text, from });
      if (live) live.emit({ type: "user", text, from: from === "phone" ? "remote" : "terminal" });
      send("rc:turn", { phase: "start", requestId, text, from });

      // Mirror this request's deltas to the phone as they stream.
      const onDelta = (d) => {
        if (d.requestId === requestId && live && live.active) live.emit({ type: "delta", kind: d.kind, text: d.text });
      };
      eng.bus.on("chat:delta", onDelta);
      busyId = requestId;
      pushStatus();
      try {
        const messages = [{ role: "system", content: SYSTEM },
          ...history.slice(-MAX_HISTORY).map(({ role, content }) => ({ role, content }))];
        const r = await eng.chat(requestId, { messages });
        history.push({ role: "assistant", content: r.text });
        send("rc:turn", { phase: "done", requestId, text: r.text, tokPerSec: r.tokPerSec });
      } catch (e) {
        const msg = e.message === "stopped" ? "stopped" : e.message;
        history.push({ role: "assistant", content: "" });
        if (live) live.emit({ type: "error", text: msg });
        send("rc:turn", { phase: "error", requestId, error: msg });
      } finally {
        eng.bus.off("chat:delta", onDelta);
        busyId = null;
        if (live) live.emit({ type: "turn_end" });
        if (history.length > MAX_HISTORY * 2) history = history.slice(-MAX_HISTORY * 2);
        pushStatus();
      }
    });
    return queue;
  }

  async function waitLoop(s, gen) {
    while (s.active && gen === generation) {
      const msg = await s.nextMessage();
      s.consumed();
      if (!s.active || gen !== generation) break;
      turn(msg.text, "phone");
    }
  }

  async function start() {
    if (session && session.active) return status();
    const relay = rc.relayUrl(serve.loadConfig());
    const s = new rc.RemoteSession({
      relay,
      key: rc.getKey(),
      info: info(),
      onStatus: (t) => { lastNote = t; pushStatus(); },
    });
    try {
      await s.open();
    } catch (e) {
      throw new Error(`could not reach the relay at ${relay}: ${e.message}`);
    }
    session = s;
    lastNote = "relay connected";
    waitLoop(s, ++generation);
    // The relay's watcher count only arrives with polls; refresh the panel now and then.
    const tick = setInterval(() => { if (!s.active) clearInterval(tick); else pushStatus(); }, 5000);
    pushStatus();
    return status();
  }

  async function stop() {
    generation++;
    const s = session;
    session = null;
    if (busyId) eng.stopChat(busyId);
    if (s) await s.close();
    lastNote = "remote control off";
    pushStatus();
    return status();
  }

  /** A message typed into the Phone conversation on the desktop itself. */
  function say(text) {
    const t = String(text || "").trim();
    if (!t) throw new Error("empty message");
    turn(t, "desktop");
    return true;
  }

  function clear() {
    if (busyId) throw new Error("wait for the reply to finish");
    history = [];
    pushStatus();
    return true;
  }

  return { start, stop, status, say, clear, shutdown: () => (session ? stop() : null) };
};
