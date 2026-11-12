//! Saved chats.
use crate::chat::Msg;
use crate::config;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
pub struct Chat {
    pub id: String,
    pub title: String,
    pub created: u64,
    pub msgs: Vec<Msg>,
}

#[derive(Default, Serialize, Deserialize, Debug, PartialEq)]
pub struct Store {
    pub chats: Vec<Chat>,
}

pub fn default_path() -> PathBuf {
    config::lite_dir().join("chats.json")
}

static COUNTER: AtomicU64 = AtomicU64::new(0);

impl Store {
    /// Missing or broken file gives an empty store.
    pub fn load(path: &Path) -> Store {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        let json = serde_json::to_vec(self).map_err(std::io::Error::other)?;
        config::write_private(path, &json)
    }

    /// Insert an empty chat at the front; returns its index (0).
    pub fn new_chat(&mut self) -> usize {
        let d = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default();
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        self.chats.insert(
            0,
            Chat {
                id: format!("{}-{}-{}", d.as_millis(), std::process::id(), n),
                title: "New chat".into(),
                created: d.as_secs(),
                msgs: Vec::new(),
            },
        );
        0
    }
}

/// First line, whitespace collapsed, at most 40 chars ("…" when cut). "New chat" when empty.
pub fn title_from(text: &str) -> String {
    let line = text.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
    let s = line.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.is_empty() {
        return "New chat".into();
    }
    if s.chars().count() <= 40 {
        s
    } else {
        s.chars().take(39).collect::<String>() + "…"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles() {
        assert_eq!(title_from("  hello \t  world \nsecond"), "hello world");
        assert_eq!(title_from("\n\nfirst real"), "first real");
        assert_eq!(title_from(""), "New chat");
        let long = "x".repeat(60);
        let t = title_from(&long);
        assert_eq!(t.chars().count(), 40);
        assert!(t.ends_with('…'));
        assert_eq!(title_from(&"y".repeat(40)).chars().count(), 40);
        assert!(!title_from(&"y".repeat(40)).ends_with('…'));
    }

    #[test]
    fn new_chat_roundtrip() {
        let mut s = Store::default();
        let a = s.new_chat();
        s.chats[0].msgs.push(Msg { role: "user".into(), content: "hi".into() });
        let b = s.new_chat();
        assert_eq!((a, b), (0, 0));
        assert_ne!(s.chats[0].id, s.chats[1].id);
        assert_eq!(s.chats[1].msgs.len(), 1);
        let d = config::test_dir("store");
        let p = d.join("sub/chats.json");
        s.save(&p).unwrap();
        assert_eq!(Store::load(&p), s);
        std::fs::write(&p, "nope").unwrap();
        assert_eq!(Store::load(&p), Store::default());
        assert_eq!(Store::load(&d.join("missing.json")), Store::default());
        let _ = std::fs::remove_dir_all(&d);
    }
}
