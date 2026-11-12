//! Pure text helpers for the window.
use crate::chat::Msg;
use crate::models::{Fit, Model};
use crate::sysmem::Mem;

pub const SUBTITLE: &str = "for old laptops, Raspberry Pi and other small computers";

pub const INTRO: &str = "ArcFlare Lite is the small version of ArcFlare: chat only, in a few megabytes of memory. It is made for old laptops, Raspberry Pi and other small computers, and that is where it works best. On a stronger computer, ArcFlare Desktop does much more: an agent, images, 3D and speech.";

pub const NO_SERVER: &str = "No llama-server was found. Install llama.cpp, then choose its llama-server in Settings. Or use a model on another computer: Settings, Another computer on your network.";

fn gb(mb: u64) -> String {
    format!("{:.1}", mb as f64 / 1024.0)
}

pub fn memory_label(m: Option<Mem>) -> String {
    match m {
        Some(m) => format!("{} of {} GB free", gb(m.available_mb), gb(m.total_mb)),
        None => "memory unknown".into(),
    }
}

pub fn fit_word(f: Fit) -> &'static str {
    match f {
        Fit::Fits => "fits",
        Fit::Tight => "tight",
        Fit::TooBig => "too big",
        Fit::Unknown => "size unknown",
    }
}

pub fn model_label(m: &Model, f: Fit) -> String {
    if m.size_mb == 0 {
        return format!("{} · size unknown", m.name);
    }
    format!("{} · {} GB · {}", m.name, gb(m.size_mb), fit_word(f))
}

pub fn big_memory_note(m: Option<Mem>) -> Option<String> {
    let m = m?;
    if m.total_mb >= 16 * 1024 {
        Some(format!(
            "This computer has {} GB of memory. ArcFlare Desktop would suit it better.",
            (m.total_mb + 512) / 1024
        ))
    } else {
        None
    }
}

pub fn no_models(home: &str) -> String {
    format!("No models yet. Put a .gguf file in {home}/models, or press Add model file. Pick one smaller than your free memory.")
}

/// Text shown in an empty chat.
pub fn empty_text(mem: Option<Mem>, no_server: bool, no_models_home: Option<&str>) -> String {
    let mut parts = vec![INTRO.to_string()];
    if let Some(n) = big_memory_note(mem) {
        parts.push(n);
    }
    if no_server {
        parts.push(NO_SERVER.into());
    }
    if let Some(h) = no_models_home {
        parts.push(no_models(h));
    }
    parts.join("\n\n")
}

pub fn speed_note(tps: f64) -> String {
    format!("{:.1} tokens a second", tps)
}

/// Plain transcript used to size and test the view: "You\n..." / "Model\n..." blocks.
pub fn transcript_text(msgs: &[Msg]) -> String {
    let mut out = String::new();
    for m in msgs {
        let who = if m.role == "user" { "You" } else { "Model" };
        out.push_str(&format!("{who}\n{}\n\n", m.content));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn mem(t: u64, a: u64) -> Option<Mem> {
        Some(Mem { total_mb: t, available_mb: a })
    }

    #[test]
    fn memory() {
        assert_eq!(memory_label(mem(3789, 1229)), "1.2 of 3.7 GB free");
        assert_eq!(memory_label(None), "memory unknown");
    }

    #[test]
    fn labels() {
        let m = Model { name: "tiny".into(), path: PathBuf::new(), size_mb: 1229 };
        assert_eq!(model_label(&m, Fit::Fits), "tiny · 1.2 GB · fits");
        assert_eq!(model_label(&m, Fit::TooBig), "tiny · 1.2 GB · too big");
        let z = Model { size_mb: 0, ..m };
        assert_eq!(model_label(&z, Fit::Unknown), "tiny · size unknown");
    }

    #[test]
    fn empty_states() {
        let t = empty_text(mem(8192, 4000), false, None);
        assert_eq!(t, INTRO);
        let t = empty_text(mem(16 * 1024, 9000), true, Some("/h"));
        assert!(t.contains("has 16 GB of memory"));
        assert!(t.contains("No llama-server was found"));
        assert!(t.contains("/h/models"));
    }

    #[test]
    fn transcript() {
        let v = vec![
            Msg { role: "user".into(), content: "hi".into() },
            Msg { role: "assistant".into(), content: "hello".into() },
        ];
        assert_eq!(transcript_text(&v), "You\nhi\n\nModel\nhello\n\n");
        assert_eq!(speed_note(12.34), "12.3 tokens a second");
    }
}
