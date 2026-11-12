use arcflare_lite::chat::{stream, Event};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// Read the request (headers + body); returns the header text.
fn read_request(s: &mut TcpStream) -> String {
    let mut data = Vec::new();
    let mut buf = [0u8; 1024];
    loop {
        let n = s.read(&mut buf).unwrap_or(0);
        if n == 0 {
            break;
        }
        data.extend_from_slice(&buf[..n]);
        if let Some(i) = data.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&data[..i]).to_string();
            let len: usize = head
                .lines()
                .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap()))
                .unwrap_or(0);
            while data.len() < i + 4 + len {
                let n = s.read(&mut buf).unwrap_or(0);
                if n == 0 {
                    break;
                }
                data.extend_from_slice(&buf[..n]);
            }
            return head;
        }
    }
    String::new()
}

fn sse(content: &str, reasoning: &str) -> String {
    let delta = if reasoning.is_empty() {
        serde_json::json!({"content": content})
    } else {
        serde_json::json!({"reasoning_content": reasoning})
    };
    format!("data: {}\n\n", serde_json::json!({"choices": [{"delta": delta}]}))
}

/// Start a fake server; `serve` gets each connection after its request was read.
fn fake(serve: impl Fn(&mut TcpStream) + Send + 'static) -> (String, mpsc::Receiver<String>) {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", l.local_addr().unwrap());
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for s in l.incoming() {
            let Ok(mut s) = s else { break };
            let head = read_request(&mut s);
            let _ = tx.send(head);
            serve(&mut s);
        }
    });
    (base, rx)
}

fn run(base: &str, key: &str, stop: &AtomicBool, guard: bool) -> Vec<Event> {
    let mut ev = Vec::new();
    let body = serde_json::json!({"model": "m", "stream": true, "messages": []});
    stream(base, key, &body, stop, guard, &mut |e| ev.push(e));
    ev
}

fn head_ok(s: &mut TcpStream) {
    let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n");
}

#[test]
fn text_in_order_then_done() {
    let (base, _rx) = fake(|s| {
        head_ok(s);
        for w in ["Hel", "lo ", "there"] {
            let _ = s.write_all(sse(w, "").as_bytes());
        }
        let _ = s.write_all(b"data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"timings\":{\"predicted_per_second\":3.0}}\n\ndata: [DONE]\n\n");
    });
    let ev = run(&base, "", &AtomicBool::new(false), true);
    assert_eq!(
        ev,
        vec![
            Event::Text("Hel".into()),
            Event::Text("lo ".into()),
            Event::Text("there".into()),
            Event::Done { tps: Some(3.0), cut_repeat: false }
        ]
    );
}

#[test]
fn stop_ends_endless_stream() {
    let (base, _rx) = fake(|s| {
        head_ok(s);
        let mut i = 0;
        while s.write_all(sse(&format!("w{i} "), "").as_bytes()).is_ok() {
            i += 1;
            std::thread::sleep(Duration::from_millis(20));
        }
    });
    let stop = std::sync::Arc::new(AtomicBool::new(false));
    let s2 = stop.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(200));
        s2.store(true, Ordering::SeqCst);
    });
    let t = Instant::now();
    let ev = run(&base, "", &stop, true);
    assert!(t.elapsed() < Duration::from_secs(2));
    assert_eq!(ev.last(), Some(&Event::Done { tps: None, cut_repeat: false }));
    assert!(ev.len() > 2);
}

#[test]
fn stop_while_server_is_silent() {
    let (base, _rx) = fake(|_s| std::thread::sleep(Duration::from_secs(3)));
    let stop = std::sync::Arc::new(AtomicBool::new(false));
    let s2 = stop.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(150));
        s2.store(true, Ordering::SeqCst);
    });
    let t = Instant::now();
    let ev = run(&base, "", &stop, true);
    assert!(t.elapsed() < Duration::from_secs(2));
    assert_eq!(ev, vec![Event::Done { tps: None, cut_repeat: false }]);
}

#[test]
fn http_500_is_error_without_key() {
    let (base, rx) = fake(|s| {
        let body = "{\"error\":\"bad key sk-secret-123 rejected\"}";
        let _ = s.write_all(
            format!("HTTP/1.1 500 Internal Server Error\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
                .as_bytes(),
        );
    });
    let ev = run(&base, "sk-secret-123", &AtomicBool::new(false), true);
    assert_eq!(ev.len(), 1);
    let Event::Error(m) = &ev[0] else { panic!("{ev:?}") };
    assert!(m.contains("500"));
    assert!(!m.contains("sk-secret-123"));
    let head = rx.recv().unwrap();
    assert!(head.contains("Authorization: Bearer sk-secret-123") || head.contains("authorization: Bearer sk-secret-123"));
    assert!(head.starts_with("POST /v1/chat/completions"));
}

#[test]
fn no_authorization_header_without_key() {
    let (base, rx) = fake(|s| {
        head_ok(s);
        let _ = s.write_all(b"data: [DONE]\n\n");
    });
    let ev = run(&base, "", &AtomicBool::new(false), true);
    assert_eq!(ev, vec![Event::Done { tps: None, cut_repeat: false }]);
    assert!(!rx.recv().unwrap().to_ascii_lowercase().contains("authorization"));
}

#[test]
fn connection_failure_names_host_and_port() {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = l.local_addr().unwrap();
    drop(l);
    let ev = run(&format!("http://{addr}"), "k-secret", &AtomicBool::new(false), true);
    let Event::Error(m) = &ev[0] else { panic!("{ev:?}") };
    assert!(m.contains(&addr.to_string()));
    assert!(!m.contains("k-secret"));
}

fn looping_server() -> String {
    let (base, _rx) = fake(|s| {
        head_ok(s);
        let _ = s.write_all(sse("", "First I add the numbers.").as_bytes());
        for _ in 0..40 {
            if s.write_all(sse("", "Wait, let me check that 2 + 2 = 4 again. Yes it is 4. ").as_bytes()).is_err() {
                return;
            }
        }
        let _ = s.write_all(sse("final answer", "").as_bytes());
    });
    base
}

#[test]
fn looping_reasoning_is_cut_with_guard_and_not_without() {
    let base = looping_server();
    let ev = run(&base, "", &AtomicBool::new(false), true);
    assert_eq!(ev.first(), Some(&Event::Thinking));
    assert_eq!(ev.last(), Some(&Event::Done { tps: None, cut_repeat: true }));
    assert!(!ev.contains(&Event::Text("final answer".into())));

    let ev = run(&base, "", &AtomicBool::new(false), false);
    assert_eq!(ev.iter().filter(|e| **e == Event::Thinking).count(), 1);
    assert!(ev.contains(&Event::Text("final answer".into())));
    assert_eq!(ev.last(), Some(&Event::Done { tps: None, cut_repeat: false }));
}
