//! Paths and settings.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// The user's home folder (HOME, or USERPROFILE on Windows).
pub fn user_home() -> Option<PathBuf> {
    for k in ["HOME", "USERPROFILE"] {
        if let Some(v) = std::env::var_os(k) {
            if !v.is_empty() {
                return Some(PathBuf::from(v));
            }
        }
    }
    None
}

/// $ARCFLARE_HOME, else ~/.arcflare.
pub fn home() -> PathBuf {
    if let Some(v) = std::env::var_os("ARCFLARE_HOME") {
        if !v.is_empty() {
            return PathBuf::from(v);
        }
    }
    user_home().unwrap_or_else(|| PathBuf::from(".")).join(".arcflare")
}

pub fn lite_dir() -> PathBuf {
    home().join("lite")
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
pub enum Mode {
    Local,
    Remote,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
#[serde(default)]
pub struct Settings {
    pub mode: Mode,
    pub remote_url: String,
    pub api_key: String,
    pub model: String,
    pub ctx: u32,
    pub threads: u32,
    pub system_prompt: String,
    pub stop_repeats: bool,
    /// llama-server chosen by the user ("" = find it).
    pub llama_server: String,
    /// Model name to ask a remote server for ("" = none).
    pub remote_model: String,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            mode: Mode::Local,
            remote_url: String::new(),
            api_key: String::new(),
            model: String::new(),
            ctx: 0,
            threads: 0,
            system_prompt: String::new(),
            stop_repeats: true,
            llama_server: String::new(),
            remote_model: String::new(),
        }
    }
}

fn settings_path() -> PathBuf {
    lite_dir().join("settings.json")
}

impl Settings {
    /// Missing or broken file gives the defaults.
    pub fn load() -> Settings {
        std::fs::read_to_string(settings_path())
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    pub fn save(&self) -> std::io::Result<()> {
        let json = serde_json::to_vec_pretty(self).map_err(std::io::Error::other)?;
        write_private(&settings_path(), &json)
    }
}

/// Write `<path>.tmp` then rename over `path`; owner-only permissions on unix.
pub fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(&tmp)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    drop(f);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(&tmp, path)
}

/// The llama-server path the main ArcFlare apps saved in home()/config.json ("llamaServer"). Read-only.
pub fn shared_llama_server() -> Option<String> {
    let text = std::fs::read_to_string(home().join("config.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let s = v.get("llamaServer")?.as_str()?.trim();
    if s.is_empty() {
        None
    } else {
        Some(s.to_string())
    }
}

#[cfg(test)]
mod new_field_tests {
    use super::*;

    #[test]
    fn old_files_load_with_new_fields_empty() {
        let s: Settings = serde_json::from_str(r#"{"ctx":2048}"#).unwrap();
        assert_eq!(s.ctx, 2048);
        assert_eq!(s.llama_server, "");
        assert_eq!(s.remote_model, "");
        let t: Settings = serde_json::from_str(r#"{"llama_server":"/x/llama-server","remote_model":"m"}"#).unwrap();
        assert_eq!(t.llama_server, "/x/llama-server");
        assert_eq!(t.remote_model, "m");
    }
}

#[cfg(test)]
pub(crate) static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
pub(crate) fn test_dir(name: &str) -> PathBuf {
    use std::sync::atomic::{AtomicU32, Ordering};
    static N: AtomicU32 = AtomicU32::new(0);
    let d = std::env::temp_dir().join(format!(
        "arcflare-lite-test-{}-{}-{}",
        std::process::id(),
        name,
        N.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults() {
        let s = Settings::default();
        assert_eq!(s.mode, Mode::Local);
        assert!(s.stop_repeats);
        assert_eq!((s.ctx, s.threads), (0, 0));
    }

    #[test]
    fn roundtrip_and_shared_config() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let d = test_dir("cfg");
        std::env::set_var("ARCFLARE_HOME", &d);
        assert_eq!(Settings::load(), Settings::default());
        let s = Settings {
            mode: Mode::Remote,
            remote_url: "http://10.0.0.2:8080".into(),
            api_key: "k".into(),
            model: "m".into(),
            ctx: 4096,
            threads: 3,
            system_prompt: "hi".into(),
            llama_server: "/x/ls".into(),
            remote_model: "rm".into(),
            stop_repeats: false,
        };
        s.save().unwrap();
        assert_eq!(Settings::load(), s);
        assert!(!d.join("lite/settings.json.tmp").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let m = std::fs::metadata(d.join("lite/settings.json")).unwrap().permissions().mode();
            assert_eq!(m & 0o777, 0o600);
        }
        std::fs::write(d.join("lite/settings.json"), "{broken").unwrap();
        assert_eq!(Settings::load(), Settings::default());
        std::fs::write(d.join("lite/settings.json"), r#"{"ctx": 99}"#).unwrap();
        assert_eq!(Settings::load().ctx, 99);

        assert_eq!(shared_llama_server(), None);
        std::fs::write(d.join("config.json"), r#"{"llamaServer": "/x/llama-server"}"#).unwrap();
        assert_eq!(shared_llama_server().as_deref(), Some("/x/llama-server"));
        std::env::remove_var("ARCFLARE_HOME");
        let _ = std::fs::remove_dir_all(&d);
    }
}
