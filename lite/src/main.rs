#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]
mod dialog;
mod ui;

fn main() {
    let arg = std::env::args().nth(1).unwrap_or_default();
    match arg.as_str() {
        "--version" | "-V" => println!("{} {}", env!("CARGO_PKG_NAME"), env!("CARGO_PKG_VERSION")),
        "--self-test" => ui::run(true),
        _ => ui::run(false),
    }
}
