//! Talking to an OpenAI-compatible /v1/chat/completions endpoint, streaming.
use crate::guard::RepeatWatch;
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Arc;
use std::time::Duration;

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
pub struct Msg {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Default, PartialEq)]
pub struct Delta {
    pub content: String,
    pub reasoning: String,
    pub finished: bool,
    pub tps: Option<f64>,
    pub error: Option<String>,
}

/// Incremental parser for server-sent events.
#[derive(Default)]
pub struct SseParser {
    buf: Vec<u8>,
}

fn cut(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

fn parse_line(line: &str) -> Option<Delta> {
    let rest = line.strip_prefix("data:")?.trim();
    if rest == "[DONE]" {
        return Some(Delta { finished: true, ..Delta::default() });
    }
    let v: serde_json::Value = serde_json::from_str(rest).ok()?;
    let mut d = Delta::default();
    if let Some(e) = v.get("error") {
        let msg = e.get("message").and_then(|m| m.as_str()).or_else(|| e.as_str());
        d.error = Some(cut(msg.unwrap_or("The server reported an error."), 300));
    }
    if let Some(c) = v.pointer("/choices/0") {
        if let Some(s) = c.pointer("/delta/content").and_then(|x| x.as_str()) {
            d.content = s.to_string();
        }
        if let Some(s) = c.pointer("/delta/reasoning_content").and_then(|x| x.as_str()) {
            d.reasoning = s.to_string();
        }
        if c.get("finish_reason").is_some_and(|f| !f.is_null()) {
            d.finished = true;
        }
    }
    d.tps = v.pointer("/timings/predicted_per_second").and_then(|x| x.as_f64());
    if d == Delta::default() {
        None
    } else {
        Some(d)
    }
}

impl SseParser {
    pub fn new() -> SseParser {
        SseParser::default()
    }

    pub fn feed(&mut self, bytes: &[u8]) -> Vec<Delta> {
        self.buf.extend_from_slice(bytes);
        let mut out = Vec::new();
        while let Some(i) = self.buf.iter().position(|&b| b == b'\n') {
            let raw: Vec<u8> = self.buf.drain(..=i).collect();
            let line = String::from_utf8_lossy(&raw);
            if let Some(d) = parse_line(line.trim_end_matches(['\r', '\n'])) {
                out.push(d);
            }
        }
        out
    }
}

pub fn request_body(model: &str, msgs: &[Msg], system: &str) -> serde_json::Value {
    let mut m: Vec<serde_json::Value> = Vec::new();
    if !system.is_empty() {
        m.push(serde_json::json!({"role": "system", "content": system}));
    }
    // A reply that failed or was cut leaves two messages from the same side in a row, and many chat
    // templates refuse that. They are sent as one message.
    let mut last_role = "";
    for x in msgs {
        if x.content.trim().is_empty() {
            continue;
        }
        if x.role == last_role {
            if let Some(prev) = m.last_mut() {
                let joined = format!("{}\n\n{}", prev["content"].as_str().unwrap_or(""), x.content);
                prev["content"] = serde_json::Value::String(joined);
                continue;
            }
        }
        m.push(serde_json::json!({"role": x.role, "content": x.content}));
        last_role = &x.role;
    }
    serde_json::json!({"model": model, "stream": true, "messages": m})
}

/// Check and clean a server address: plain http only, a host, no credentials; drops a trailing "/" and "/v1".
pub fn validate_base_url(raw: &str) -> Result<String, String> {
    let t = raw.trim();
    let lower = t.to_ascii_lowercase();
    if lower.starts_with("https://") {
        return Err("This build only speaks plain http. Use it on your own network.".into());
    }
    if !lower.starts_with("http://") {
        return Err("The address must start with http://".into());
    }
    let after = &t["http://".len()..];
    let authority = after.split(['/', '?', '#']).next().unwrap_or("");
    if authority.contains('@') {
        return Err("Put the key in the key field, not in the address.".into());
    }
    let host = authority.rsplit_once(':').map_or(authority, |(h, p)| {
        if p.chars().all(|c| c.is_ascii_digit()) {
            h
        } else {
            authority
        }
    });
    if host.is_empty() {
        return Err("The address has no host name.".into());
    }
    let mut s = t.trim_end_matches('/');
    s = s.strip_suffix("/v1").unwrap_or(s);
    Ok(s.trim_end_matches('/').to_string())
}

#[derive(Debug, PartialEq)]
pub enum Event {
    Thinking,
    Text(String),
    Done { tps: Option<f64>, cut_repeat: bool },
    Error(String),
}

enum Chunk {
    Data(Vec<u8>),
    Eof,
    Fail(String),
}

fn host_port(base: &str) -> String {
    let after = base.split_once("://").map_or(base, |x| x.1);
    after.split(['/', '?', '#']).next().unwrap_or(after).to_string()
}

/// Blocking streamed chat request; always ends with exactly one Done or Error.
///
/// The request runs on a helper thread so `stop` is noticed even while the server is silent
/// (a slow computer can take minutes to read the prompt). On stop or cut the helper is told to
/// close its connection as soon as it wakes.
pub fn stream(
    base_url: &str,
    api_key: &str,
    body: &serde_json::Value,
    stop: &AtomicBool,
    guard: bool,
    on_event: &mut dyn FnMut(Event),
) {
    let url = format!("{}/v1/chat/completions", base_url.trim_end_matches('/'));
    let hp = host_port(base_url);
    let key = api_key.to_string();
    let payload = body.to_string();
    let abort = Arc::new(AtomicBool::new(false));
    let (tx, rx) = mpsc::channel::<Chunk>();
    {
        let abort = abort.clone();
        let hp = hp.clone();
        std::thread::spawn(move || worker(&url, &key, &payload, &hp, &abort, &tx));
    }

    let mut parser = SseParser::new();
    let mut think = RepeatWatch::thinking();
    let mut answer = RepeatWatch::answer();
    let mut thinking_sent = false;
    let mut tps: Option<f64> = None;

    loop {
        if stop.load(Ordering::SeqCst) {
            abort.store(true, Ordering::SeqCst);
            return on_event(Event::Done { tps: None, cut_repeat: false });
        }
        let bytes = match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(Chunk::Data(b)) => b,
            Ok(Chunk::Fail(m)) => return on_event(Event::Error(m)),
            Ok(Chunk::Eof) | Err(RecvTimeoutError::Disconnected) => {
                // A last line may lack its newline.
                let rest = parser.feed(b"\n");
                for d in rest {
                    if let Some(e) = d.error {
                        return on_event(Event::Error(e));
                    }
                    if !d.content.is_empty() {
                        on_event(Event::Text(d.content));
                    }
                    tps = d.tps.or(tps);
                }
                return on_event(Event::Done { tps, cut_repeat: false });
            }
            Err(RecvTimeoutError::Timeout) => continue,
        };
        for d in parser.feed(&bytes) {
            if let Some(e) = d.error {
                abort.store(true, Ordering::SeqCst);
                return on_event(Event::Error(e));
            }
            tps = d.tps.or(tps);
            let mut cut_now = false;
            if !d.reasoning.is_empty() {
                if !thinking_sent {
                    thinking_sent = true;
                    on_event(Event::Thinking);
                }
                if guard && think.feed(&d.reasoning) {
                    cut_now = true;
                }
            }
            if !d.content.is_empty() {
                if guard && answer.feed(&d.content) {
                    cut_now = true;
                }
                on_event(Event::Text(d.content));
            }
            if cut_now {
                abort.store(true, Ordering::SeqCst);
                return on_event(Event::Done { tps, cut_repeat: true });
            }
        }
    }
}

fn worker(url: &str, key: &str, payload: &str, hp: &str, abort: &AtomicBool, tx: &mpsc::Sender<Chunk>) {
    let agent = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(10)).build();
    let mut req = agent.post(url).set("Content-Type", "application/json").set("Accept", "text/event-stream");
    if !key.is_empty() {
        req = req.set("Authorization", &format!("Bearer {key}"));
    }
    let redact = |s: String| if key.is_empty() { s } else { s.replace(key, "***") };
    let resp = match req.send_string(payload) {
        Ok(r) => r,
        Err(ureq::Error::Status(code, r)) => {
            let text = r.into_string().unwrap_or_default();
            let _ = tx.send(Chunk::Fail(redact(format!("The server answered HTTP {code}: {}", cut(&text, 300)))));
            return;
        }
        Err(_) => {
            let _ = tx.send(Chunk::Fail(format!("Could not reach the server at {hp}. Is it running, and is the address right?")));
            return;
        }
    };
    let mut rd = resp.into_reader();
    let mut buf = [0u8; 4096];
    loop {
        if abort.load(Ordering::SeqCst) {
            return;
        }
        match rd.read(&mut buf) {
            Ok(0) => {
                let _ = tx.send(Chunk::Eof);
                return;
            }
            Ok(n) => {
                if tx.send(Chunk::Data(buf[..n].to_vec())).is_err() {
                    return;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => {
                let _ = tx.send(Chunk::Fail(format!("The connection to {hp} was lost.")));
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all(chunks: &[&[u8]]) -> Vec<Delta> {
        let mut p = SseParser::new();
        chunks.iter().flat_map(|c| p.feed(c)).collect()
    }

    #[test]
    fn parses_content_reasoning_finish_timings() {
        let d = all(&[
            b"data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"hm\"}}]}\n\n",
            b"data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\r\n",
            b"data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"timings\":{\"predicted_per_second\":7.5}}\n",
            b"data: [DONE]\n",
        ]);
        assert_eq!(d.len(), 4);
        assert_eq!(d[0].reasoning, "hm");
        assert_eq!(d[1].content, "hi");
        assert!(d[2].finished);
        assert_eq!(d[2].tps, Some(7.5));
        assert!(d[3].finished);
    }

    #[test]
    fn split_lines_and_utf8() {
        let line = "data: {\"choices\":[{\"delta\":{\"content\":\"h\u{e9}\u{1f600}\"}}]}\n".as_bytes();
        for cut in 1..line.len() {
            let d = all(&[&line[..cut], &line[cut..]]);
            assert_eq!(d.len(), 1, "cut {cut}");
            assert_eq!(d[0].content, "h\u{e9}\u{1f600}");
        }
    }

    #[test]
    fn errors_and_junk() {
        let d = all(&[b": comment\n", b"event: x\n", b"data: not json\n", b"\n", b"data: {\"error\":{\"message\":\"boom\"}}\n"]);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].error.as_deref(), Some("boom"));
        let d = all(&[b"data: {\"error\":\"plain\"}\n"]);
        assert_eq!(d[0].error.as_deref(), Some("plain"));
        let long = format!("data: {{\"error\":\"{}\"}}\n", "e".repeat(500));
        assert_eq!(all(&[long.as_bytes()])[0].error.as_ref().unwrap().len(), 300);
        assert!(all(&[b"data:{\"choices\":[]}\n", b"data: {\"choices\":[{\"delta\":{\"content\":null},\"finish_reason\":null}]}\n"]).is_empty());
    }

    #[test]
    fn body() {
        let m = [Msg { role: "user".into(), content: "yo".into() }];
        let b = request_body("m", &m, "sys");
        assert_eq!(b["stream"], true);
        assert_eq!(b["messages"][0]["role"], "system");
        assert_eq!(b["messages"][1]["content"], "yo");
        assert_eq!(request_body("m", &m, "")["messages"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn urls() {
        assert_eq!(validate_base_url(" http://10.0.0.2:8080/v1/ ").unwrap(), "http://10.0.0.2:8080");
        assert_eq!(validate_base_url("http://host").unwrap(), "http://host");
        assert_eq!(validate_base_url("HTTP://host/api/v1").unwrap(), "HTTP://host/api");
        assert_eq!(
            validate_base_url("https://x").unwrap_err(),
            "This build only speaks plain http. Use it on your own network."
        );
        assert!(validate_base_url("ftp://x").is_err());
        assert!(validate_base_url("http://").is_err());
        assert!(validate_base_url("http://:80").is_err());
        assert!(validate_base_url("http://u:p@host").is_err());
        assert!(validate_base_url("http://u@host").is_err());
        assert!(validate_base_url("host:80").is_err());
    }

    #[test]
    fn two_messages_from_the_same_side_are_sent_as_one() {
        let msg = |r: &str, c: &str| Msg { role: r.into(), content: c.into() };
        let body = request_body("m", &[msg("user", "first"), msg("user", "second"), msg("assistant", ""), msg("assistant", "reply"), msg("user", "third")], "");
        let sent: Vec<(String, String)> = body["messages"].as_array().unwrap().iter()
            .map(|x| (x["role"].as_str().unwrap().to_string(), x["content"].as_str().unwrap().to_string())).collect();
        assert_eq!(sent, vec![
            ("user".to_string(), "first\n\nsecond".to_string()),
            ("assistant".to_string(), "reply".to_string()),
            ("user".to_string(), "third".to_string()),
        ]);
    }
}
