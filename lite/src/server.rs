//! Finding, starting and watching a local llama-server.
use crate::config;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

// The server this app started, by process id: in memory for the signal handler, and in a file for the
// next start. A model server left behind holds the whole model in memory, which on a small computer is
// most of what there is, so the app makes sure it never outlives it: stopped on close, stopped when the
// app is told to quit (logout, shutdown, Ctrl+C), and cleaned up at the next start after a crash.
static RUNNING: Mutex<Option<u32>> = Mutex::new(None);

fn pid_file() -> PathBuf {
    config::lite_dir().join("server.pid")
}

/// A helper command that shows no console window and no output.
fn quiet(program: &str) -> Command {
    let mut cmd = Command::new(program);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

fn os_kill(pid: u32) {
    let pid = pid.to_string();
    let _ = if cfg!(windows) {
        quiet("taskkill").args(["/PID", &pid, "/F"]).status()
    } else {
        quiet("kill").arg(&pid).status()
    };
}

/// Is this process a llama-server? Asked of the system, so a process id that has since been given to
/// something else is never killed by mistake.
fn is_llama_server(pid: u32) -> bool {
    let out = if cfg!(windows) {
        quiet("tasklist").args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"]).output()
    } else {
        quiet("ps").args(["-p", &pid.to_string(), "-o", "args="]).output()
    };
    out.map(|o| String::from_utf8_lossy(&o.stdout).contains("llama-server")).unwrap_or(false)
}

/// Stop the server this app started, without its handle. For the signal handler, which has no access to the window.
pub fn kill_running() {
    let pid = RUNNING.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(pid) = pid {
        os_kill(pid);
        let _ = std::fs::remove_file(pid_file());
    }
}

/// At start: if an earlier run of this app left its server behind (a crash, a power cut), stop it.
/// Returns true when one was found and stopped.
pub fn reap_stale() -> bool {
    let Ok(text) = std::fs::read_to_string(pid_file()) else { return false };
    let _ = std::fs::remove_file(pid_file());
    match text.trim().parse::<u32>() {
        Ok(pid) if is_llama_server(pid) => {
            os_kill(pid);
            true
        }
        _ => false,
    }
}

const EXE: &str = if cfg!(windows) { "llama-server.exe" } else { "llama-server" };

/// A file, or a folder holding llama-server[.exe].
fn resolve(p: &Path) -> Option<PathBuf> {
    if p.is_file() {
        return Some(p.to_path_buf());
    }
    let f = p.join(EXE);
    f.is_file().then_some(f)
}

fn find_under(dir: &Path, depth: u32) -> Option<PathBuf> {
    let direct = dir.join(EXE);
    if direct.is_file() {
        return Some(direct);
    }
    if depth == 0 {
        return None;
    }
    let mut subs: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| e.path())
        .collect();
    subs.sort();
    subs.iter().find_map(|s| find_under(s, depth - 1))
}

pub fn find_llama_server(configured: Option<&str>) -> Option<PathBuf> {
    if let Some(c) = configured.map(str::trim).filter(|c| !c.is_empty()) {
        if let Some(f) = resolve(Path::new(c)) {
            return Some(f);
        }
    }
    if let Some(v) = std::env::var_os("ARCFLARE_LLAMA_SERVER").filter(|v| !v.is_empty()) {
        if let Some(f) = resolve(Path::new(&v)) {
            return Some(f);
        }
    }
    if let Some(f) = find_under(&config::home().join("engine"), 4) {
        return Some(f);
    }
    if let Some(path) = std::env::var_os("PATH") {
        for d in std::env::split_paths(&path) {
            let f = d.join(EXE);
            if f.is_file() {
                return Some(f);
            }
        }
    }
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(h) = config::user_home() {
        for sub in ["llamacpp/vulkan", "llamacpp/cuda", "llamacpp/rocm", "llamacpp", "llama.cpp/build/bin"] {
            dirs.push(h.join(sub));
        }
    }
    dirs.push(PathBuf::from("/usr/local/bin"));
    dirs.push(PathBuf::from("/opt/homebrew/bin"));
    dirs.iter().map(|d| d.join(EXE)).find(|f| f.is_file())
}

/// An unused local port.
pub fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(8081)
}

#[derive(Clone, Debug)]
pub struct ServerOpts {
    pub exe: PathBuf,
    pub model: PathBuf,
    pub ctx: u32,
    pub threads: u32,
    pub port: u16,
}

/// Command-line arguments. Only ever binds 127.0.0.1.
pub fn args(o: &ServerOpts) -> Vec<String> {
    [
        "-m",
        &o.model.to_string_lossy(),
        "--host",
        "127.0.0.1",
        "--port",
        &o.port.to_string(),
        "-c",
        &o.ctx.to_string(),
        "-t",
        &o.threads.to_string(),
        "--parallel",
        "1",
        "--cache-ram",
        "0",
        "--jinja",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

pub struct Server {
    pub port: u16,
    pub log: PathBuf,
    child: Option<Child>,
}

impl Server {
    pub fn start(o: &ServerOpts) -> std::io::Result<Server> {
        let log = config::lite_dir().join("server.log");
        if let Some(d) = log.parent() {
            std::fs::create_dir_all(d)?;
        }
        let out = std::fs::OpenOptions::new().create(true).append(true).open(&log)?;
        let err = out.try_clone()?;
        let mut cmd = Command::new(&o.exe);
        cmd.args(args(o)).stdin(Stdio::null()).stdout(out).stderr(err);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let child = cmd.spawn()?;
        *RUNNING.lock().unwrap_or_else(|e| e.into_inner()) = Some(child.id());
        let _ = config::write_private(&pid_file(), child.id().to_string().as_bytes());
        Ok(Server { port: o.port, log, child: Some(child) })
    }

    /// Poll /health every 300 ms until the model is loaded.
    pub fn wait_ready(&mut self, timeout: Duration, cancel: &AtomicBool) -> Result<(), String> {
        let start = Instant::now();
        loop {
            if cancel.load(Ordering::SeqCst) {
                return Err("Cancelled before the model finished loading.".into());
            }
            match self.child.as_mut().map(|c| c.try_wait()) {
                Some(Ok(Some(status))) => {
                    return Err(format!(
                        "The model server stopped ({status}). Last lines of its log:\n{}",
                        log_tail(&self.log, 12)
                    ));
                }
                None => return Err("The model server is not running.".into()),
                _ => {}
            }
            if health(self.port) {
                return Ok(());
            }
            if start.elapsed() >= timeout {
                return Err("The model took too long to load. A smaller model may work better on this computer.".into());
            }
            std::thread::sleep(Duration::from_millis(300));
        }
    }

    /// Kill and wait; safe to call twice.
    pub fn stop(&mut self) {
        if let Some(mut c) = self.child.take() {
            let _ = c.kill();
            let _ = c.wait();
            let mut running = RUNNING.lock().unwrap_or_else(|e| e.into_inner());
            if *running == Some(c.id()) {
                *running = None;
                let _ = std::fs::remove_file(pid_file());
            }
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop();
    }
}

/// GET /health with a 1 s timeout; true on 200.
pub fn health(port: u16) -> bool {
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(1)).build();
    matches!(agent.get(&format!("http://127.0.0.1:{port}/health")).call(), Ok(r) if r.status() == 200)
}

/// The last `lines` lines of a file ("" when unreadable).
pub fn log_tail(path: &Path, lines: usize) -> String {
    let Ok(bytes) = std::fs::read(path) else { return String::new() };
    let text = String::from_utf8_lossy(&bytes);
    let all: Vec<&str> = text.lines().collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args_exact() {
        let o = ServerOpts {
            exe: "x".into(),
            model: "/m/a b.gguf".into(),
            ctx: 4096,
            threads: 4,
            port: 8123,
        };
        assert_eq!(
            args(&o).join(" "),
            "-m /m/a b.gguf --host 127.0.0.1 --port 8123 -c 4096 -t 4 --parallel 1 --cache-ram 0 --jinja"
        );
        assert_eq!(args(&o).len(), 15);
    }

    #[test]
    fn port_and_tail() {
        assert!(free_port() > 0);
        let d = config::test_dir("srv");
        let f = d.join("l.log");
        std::fs::write(&f, "a\nb\nc\nd\n").unwrap();
        assert_eq!(log_tail(&f, 2), "c\nd");
        assert_eq!(log_tail(&f, 10), "a\nb\nc\nd");
        assert_eq!(log_tail(&d.join("none"), 3), "");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn find_configured_file_and_folder() {
        let d = config::test_dir("find");
        let exe = d.join(EXE);
        std::fs::write(&exe, "").unwrap();
        assert_eq!(find_llama_server(Some(exe.to_str().unwrap())), Some(exe.clone()));
        assert_eq!(find_llama_server(Some(d.to_str().unwrap())), Some(exe));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn health_false_when_nothing_listens() {
        assert!(!health(free_port()));
    }

    #[test]
    fn a_stale_pid_file_is_removed_and_only_a_llama_server_is_stopped() {
        let _g = config::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let d = config::test_dir("reap");
        std::env::set_var("ARCFLARE_HOME", &d);
        assert!(!reap_stale(), "no file, nothing to do");
        // This test process is not a llama-server: its id in the file must not get it killed.
        config::write_private(&pid_file(), std::process::id().to_string().as_bytes()).unwrap();
        assert!(!reap_stale());
        assert!(!pid_file().exists(), "the file is removed either way");
        config::write_private(&pid_file(), b"not a number").unwrap();
        assert!(!reap_stale());
        assert!(!pid_file().exists());
        std::env::remove_var("ARCFLARE_HOME");
    }
}
