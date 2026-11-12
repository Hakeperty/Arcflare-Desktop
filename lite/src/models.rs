//! Finding model files and judging whether they fit in memory.
use crate::config;
use crate::sysmem::Mem;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq)]
pub struct Model {
    pub name: String,
    pub path: PathBuf,
    pub size_mb: u64,
}

fn env_dir(k: &str) -> Option<PathBuf> {
    std::env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// Folders that may hold models (existing ones only, deduped, in priority order).
pub fn roots() -> Vec<PathBuf> {
    let user = config::user_home();
    let mut c: Vec<PathBuf> = Vec::new();
    c.extend(env_dir("ARCFLARE_MODELS"));
    c.extend(env_dir("LLAMA_CACHE"));
    c.push(config::home().join("models"));
    if let Some(h) = &user {
        c.push(h.join("llamacpp").join("models"));
    }
    if cfg!(windows) {
        c.extend(env_dir("LOCALAPPDATA").map(|d| d.join("llama.cpp")));
    } else {
        let cache = env_dir("XDG_CACHE_HOME").or_else(|| user.as_ref().map(|h| h.join(".cache")));
        c.extend(cache.map(|d| d.join("llama.cpp")));
        if cfg!(target_os = "macos") {
            if let Some(h) = &user {
                c.push(h.join("Library").join("Caches").join("llama.cpp"));
            }
        }
    }
    let mut seen: Vec<PathBuf> = Vec::new();
    let mut out = Vec::new();
    for p in c {
        if !p.is_dir() {
            continue;
        }
        let canon = p.canonicalize().unwrap_or_else(|_| p.clone());
        if !seen.contains(&canon) {
            seen.push(canon);
            out.push(p);
        }
    }
    out
}

/// Parse `<stem>-00001-of-00003` from a file name without ".gguf": (index, total, base).
fn shard_info(file_name: &str) -> Option<(u32, u32, String)> {
    let stem = file_name.get(..file_name.len().checked_sub(5)?)?;
    let b = stem.as_bytes();
    if b.len() < 15 {
        return None;
    }
    let t = &b[b.len() - 15..];
    let digits = |s: &[u8]| s.iter().all(u8::is_ascii_digit);
    if t[0] != b'-' || !digits(&t[1..6]) || &t[6..10] != b"-of-" || !digits(&t[10..15]) {
        return None;
    }
    let num = |s: &[u8]| std::str::from_utf8(s).ok()?.parse::<u32>().ok();
    Some((num(&t[1..6])?, num(&t[10..15])?, stem[..stem.len() - 15].to_string()))
}

fn is_aux(lower: &str) -> bool {
    lower.starts_with("mmproj") || lower.starts_with("mtp-") || lower.contains("eagle3")
}

struct Found {
    path: PathBuf,
    name: String,
    bytes: u64,
    shard: Option<(u32, u32, String)>,
}

fn walk(dir: &Path, depth: u32, out: &mut Vec<Found>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let path = e.path();
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            if depth < 5 {
                walk(&path, depth + 1, out);
            }
            continue;
        }
        let fname = e.file_name().to_string_lossy().into_owned();
        if !fname.to_ascii_lowercase().ends_with(".gguf") {
            continue;
        }
        // Symlinked files are fine (Hugging Face caches use them); symlinked folders are not followed.
        let Ok(md) = std::fs::metadata(&path) else { continue };
        if !md.is_file() {
            continue;
        }
        out.push(Found { path, shard: shard_info(&fname), name: fname, bytes: md.len() });
    }
}

/// Models under the roots, smallest first.
pub fn discover(roots: &[PathBuf]) -> Vec<Model> {
    let mut found = Vec::new();
    for r in roots {
        walk(r, 0, &mut found);
    }
    // Overlapping roots must not count a file (or a shard) twice.
    let mut canon_seen = Vec::new();
    found.retain(|f| {
        let c = f.path.canonicalize().unwrap_or_else(|_| f.path.clone());
        if canon_seen.contains(&c) {
            false
        } else {
            canon_seen.push(c);
            true
        }
    });
    let mut seen = Vec::new();
    let mut out = Vec::new();
    for f in &found {
        if is_aux(&f.name.to_ascii_lowercase()) {
            continue;
        }
        let (name, bytes) = match &f.shard {
            Some((idx, total, base)) => {
                if *idx != 1 {
                    continue;
                }
                let sum = found
                    .iter()
                    .filter(|o| o.path.parent() == f.path.parent())
                    .filter(|o| matches!(&o.shard, Some((_, t, b)) if t == total && b == base))
                    .map(|o| o.bytes)
                    .sum();
                (base.clone(), sum)
            }
            None => (f.name[..f.name.len() - 5].to_string(), f.bytes),
        };
        let canon = f.path.canonicalize().unwrap_or_else(|_| f.path.clone());
        if seen.contains(&canon) {
            continue;
        }
        seen.push(canon);
        out.push(Model { name, path: f.path.clone(), size_mb: bytes / 1024 / 1024 });
    }
    out.sort_by(|a, b| a.size_mb.cmp(&b.size_mb).then_with(|| a.name.cmp(&b.name)));
    out
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Fit {
    Fits,
    Tight,
    TooBig,
    Unknown,
}

/// Rough memory need in MB: the model plus 10%, 300 MB of runtime overhead, and about 40 KB of KV cache per context token.
pub fn need_mb(model_mb: u64, ctx: u32) -> u64 {
    model_mb * 11 / 10 + 300 + (ctx as u64) * 40 / 1024
}

pub fn fit(model_mb: u64, ctx: u32, mem: Option<Mem>) -> Fit {
    let Some(m) = mem else { return Fit::Unknown };
    let need = need_mb(model_mb, ctx);
    if need <= m.available_mb * 8 / 10 {
        Fit::Fits
    } else if need <= m.available_mb {
        Fit::Tight
    } else {
        Fit::TooBig
    }
}

/// 4096 when at least 2 GB would be left after the model, else 2048 (also when memory is unknown).
pub fn auto_ctx(model_mb: u64, mem: Option<Mem>) -> u32 {
    match mem {
        Some(m) if m.available_mb.saturating_sub(model_mb) >= 2048 => 4096,
        _ => 2048,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(p: &Path, mb: usize) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, vec![0u8; mb * 1024 * 1024]).unwrap();
    }

    #[test]
    fn discovery() {
        let d = config::test_dir("models");
        touch(&d.join("big.GGUF"), 3);
        touch(&d.join("small.gguf"), 1);
        touch(&d.join("sub/split-00001-of-00002.gguf"), 2);
        touch(&d.join("sub/split-00002-of-00002.gguf"), 2);
        touch(&d.join("mmproj-x.gguf"), 1);
        touch(&d.join("MTP-draft.gguf"), 1);
        touch(&d.join("x-eagle3-y.gguf"), 1);
        touch(&d.join("notes.txt"), 1);
        touch(&d.join("a/b/c/d/e/f/deep.gguf"), 1);
        let got = discover(&[d.clone(), d.clone()]);
        let names: Vec<_> = got.iter().map(|m| (m.name.as_str(), m.size_mb)).collect();
        assert_eq!(names, vec![("small", 1), ("big", 3), ("split", 4)]);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn shard_parse() {
        assert_eq!(shard_info("m-00001-of-00003.gguf"), Some((1, 3, "m".into())));
        assert_eq!(shard_info("m-0001-of-00003.gguf"), None);
        assert_eq!(shard_info("m.gguf"), None);
    }

    #[test]
    fn fit_boundaries() {
        let mem = Some(Mem { total_mb: 8000, available_mb: 1000 });
        assert_eq!(need_mb(1000, 4096), 1100 + 300 + 160);
        assert_eq!(fit(400, 0, mem), Fit::Fits); // 740 <= 800
        assert_eq!(fit(500, 0, mem), Fit::Tight); // 850: over 800, within 1000
        assert_eq!(fit(636, 0, mem), Fit::Tight); // 999
        assert_eq!(fit(637, 0, mem), Fit::Tight); // 1000 exactly
        assert_eq!(fit(638, 0, mem), Fit::TooBig); // 1001
        assert_eq!(fit(1, 0, None), Fit::Unknown);
    }

    #[test]
    fn auto_ctx_boundaries() {
        let m = |a| Some(Mem { total_mb: 16000, available_mb: a });
        assert_eq!(auto_ctx(1000, m(3048)), 4096);
        assert_eq!(auto_ctx(1000, m(3047)), 2048);
        assert_eq!(auto_ctx(5000, m(3000)), 2048);
        assert_eq!(auto_ctx(1000, None), 2048);
    }

    #[test]
    fn roots_order_and_dedupe() {
        let _g = config::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let d = config::test_dir("roots");
        let m = d.join("m");
        std::fs::create_dir_all(&m).unwrap();
        std::env::set_var("ARCFLARE_MODELS", &m);
        std::env::set_var("LLAMA_CACHE", &m);
        std::env::set_var("ARCFLARE_HOME", d.join("home"));
        std::fs::create_dir_all(d.join("home/models")).unwrap();
        let r = roots();
        assert_eq!(r[0], m);
        assert_eq!(r[1], d.join("home/models"));
        assert_eq!(r.iter().filter(|p| **p == m).count(), 1);
        for k in ["ARCFLARE_MODELS", "LLAMA_CACHE", "ARCFLARE_HOME"] {
            std::env::remove_var(k);
        }
        let _ = std::fs::remove_dir_all(&d);
    }
}
