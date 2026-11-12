//! How much memory the computer has.

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Mem {
    pub total_mb: u64,
    pub available_mb: u64,
}

/// Parse the text of /proc/meminfo (values in kB).
pub fn parse_meminfo(text: &str) -> Option<Mem> {
    let mut total = None;
    let mut avail = None;
    for line in text.lines() {
        let Some((key, rest)) = line.split_once(':') else { continue };
        let kb = rest.split_whitespace().next().and_then(|n| n.parse::<u64>().ok());
        match key.trim() {
            "MemTotal" => total = kb,
            "MemAvailable" => avail = kb,
            _ => {}
        }
    }
    Some(Mem { total_mb: total? / 1024, available_mb: avail? / 1024 })
}

#[cfg(target_os = "linux")]
fn read_os() -> Option<Mem> {
    parse_meminfo(&std::fs::read_to_string("/proc/meminfo").ok()?)
}

#[cfg(target_os = "macos")]
fn read_os() -> Option<Mem> {
    let out = std::process::Command::new("sysctl").args(["-n", "hw.memsize"]).output().ok()?;
    let bytes: u64 = String::from_utf8_lossy(&out.stdout).trim().parse().ok()?;
    let total_mb = bytes / 1024 / 1024;
    Some(Mem { total_mb, available_mb: total_mb / 2 })
}

#[cfg(windows)]
fn read_os() -> Option<Mem> {
    #[repr(C)]
    struct MemoryStatusEx {
        length: u32,
        memory_load: u32,
        total_phys: u64,
        avail_phys: u64,
        total_page_file: u64,
        avail_page_file: u64,
        total_virtual: u64,
        avail_virtual: u64,
        avail_extended_virtual: u64,
    }
    extern "system" {
        fn GlobalMemoryStatusEx(buffer: *mut MemoryStatusEx) -> i32;
    }
    let mut s = MemoryStatusEx {
        length: std::mem::size_of::<MemoryStatusEx>() as u32,
        memory_load: 0,
        total_phys: 0,
        avail_phys: 0,
        total_page_file: 0,
        avail_page_file: 0,
        total_virtual: 0,
        avail_virtual: 0,
        avail_extended_virtual: 0,
    };
    // SAFETY: `s` is a valid, correctly sized MEMORYSTATUSEX with `length` set, as the API requires.
    let ok = unsafe { GlobalMemoryStatusEx(&mut s) };
    if ok == 0 {
        return None;
    }
    Some(Mem { total_mb: s.total_phys / 1024 / 1024, available_mb: s.avail_phys / 1024 / 1024 })
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn read_os() -> Option<Mem> {
    None
}

pub fn read() -> Option<Mem> {
    read_os()
}

pub fn cores() -> u32 {
    std::thread::available_parallelism().map(|n| n.get() as u32).unwrap_or(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meminfo() {
        let t = "MemTotal:        8167848 kB\nMemFree:          100 kB\nMemAvailable:    4096000 kB\n";
        assert_eq!(parse_meminfo(t), Some(Mem { total_mb: 7976, available_mb: 4000 }));
        assert_eq!(parse_meminfo("MemTotal: 1024 kB\n"), None);
        assert_eq!(parse_meminfo("junk"), None);
        assert_eq!(parse_meminfo(""), None);
    }

    #[test]
    fn cores_at_least_one() {
        assert!(cores() >= 1);
    }
}
