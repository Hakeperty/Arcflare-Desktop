//! The modal Settings window.
use arcflare_lite::config::{Mode, Settings};
use arcflare_lite::{chat, config, server, sysmem};
use fltk::{button::*, dialog, enums::*, frame::Frame, group::Flex, input::*, menu::Choice, prelude::*, window::Window};
use std::cell::RefCell;
use std::rc::Rc;

pub const BG: u32 = 0x0b0b0a;
pub const PANEL: u32 = 0x121211;
pub const RAISED: u32 = 0x1a1a18;
pub const TEXT: u32 = 0xedeae2;
pub const MUTED: u32 = 0xa09d93;
pub const ACCENT: u32 = 0xffb020;
pub const DANGER: u32 = 0xff4d3d;

pub fn col(h: u32) -> Color {
    Color::from_hex(h)
}

pub fn button(label: &str, primary: bool) -> Button {
    let mut b = Button::default().with_label(label);
    style_button(&mut b, primary);
    b
}

pub fn style_button(b: &mut Button, primary: bool) {
    b.set_frame(FrameType::BorderBox);
    b.set_color(col(RAISED));
    b.set_selection_color(col(0x2a2a27));
    b.set_label_size(13);
    b.set_label_color(col(if primary { ACCENT } else { TEXT }));
}

pub fn style_input<I: InputExt + WidgetExt>(i: &mut I) {
    i.set_frame(FrameType::BorderBox);
    i.set_color(col(RAISED));
    i.set_text_color(col(TEXT));
    i.set_text_size(14);
    i.set_cursor_color(col(ACCENT));
    i.set_selection_color(col(ACCENT));
}

pub fn style_choice(c: &mut Choice) {
    c.set_frame(FrameType::BorderBox);
    c.set_color(col(RAISED));
    c.set_text_color(col(TEXT));
    c.set_text_size(13);
    c.set_selection_color(col(ACCENT));
}

pub fn label(text: &str, color: u32, size: i32) -> Frame {
    let mut f = Frame::default().with_label(text);
    f.set_label_color(col(color));
    f.set_label_size(size);
    f.set_align(Align::Inside | Align::Left | Align::Wrap);
    f
}

fn row<W: WidgetExt, F: FnOnce() -> W>(col_flex: &mut Flex, text: &str, h: i32, make: F) -> W {
    let mut r = Flex::default().row();
    r.set_spacing(8);
    let l = label(text, MUTED, 13);
    r.fixed(&l, 150);
    let w = make();
    r.end();
    col_flex.fixed(&r, h);
    w
}

pub fn exe_in_use(s: &Settings) -> Option<String> {
    let configured = if s.llama_server.trim().is_empty() { config::shared_llama_server() } else { Some(s.llama_server.clone()) };
    server::find_llama_server(configured.as_deref()).map(|p| p.display().to_string())
}

fn pick(title: &str, filter: &str) -> Option<String> {
    let mut c = dialog::NativeFileChooser::new(dialog::NativeFileChooserType::BrowseFile);
    c.set_title(title);
    c.set_filter(filter);
    c.show();
    let p = c.filename();
    if p.as_os_str().is_empty() {
        None
    } else {
        Some(p.display().to_string())
    }
}

pub fn choose_gguf() -> Option<String> {
    pick("Add model file", "GGUF model\t*.gguf")
}

/// Runs the dialog; Some(new settings) when saved.
pub fn open(s: &Settings) -> Option<Settings> {
    let result: Rc<RefCell<Option<Settings>>> = Rc::new(RefCell::new(None));
    let mut win = Window::default().with_size(580, 600).with_label("Settings");
    win.set_color(col(BG));
    win.make_modal(true);
    let mut root = Flex::default_fill().column();
    root.set_margin(16);
    root.set_spacing(8);

    let mut mode = row(&mut root, "Where the model runs", 28, || {
        let mut c = Choice::default();
        style_choice(&mut c);
        c.add_choice("This computer|Another computer on your network");
        c.set_value(if s.mode == Mode::Remote { 1 } else { 0 });
        c
    });
    let url = row(&mut root, "Address", 28, || {
        let mut i = Input::default();
        style_input(&mut i);
        i.set_value(&s.remote_url);
        i
    });
    let rmodel = row(&mut root, "Model name", 28, || {
        let mut i = Input::default();
        style_input(&mut i);
        i.set_value(&s.remote_model);
        i
    });
    let key = row(&mut root, "Key", 28, || {
        let mut i = SecretInput::default();
        style_input(&mut i);
        i.set_value(&s.api_key);
        i
    });
    let hint = label("For example http://192.168.1.20:11434. Leave the key empty if the server needs none.", MUTED, 12);
    root.fixed(&hint, 18);

    let mut ctxs = vec![0u32, 1024, 2048, 4096, 8192];
    if !ctxs.contains(&s.ctx) {
        ctxs.push(s.ctx);
        ctxs.sort();
    }
    let ctx = row(&mut root, "Context size", 28, || {
        let mut c = Choice::default();
        style_choice(&mut c);
        for v in &ctxs {
            c.add_choice(&if *v == 0 { "Auto".to_string() } else { v.to_string() });
        }
        c.set_value(ctxs.iter().position(|v| *v == s.ctx).unwrap_or(0) as i32);
        c
    });
    let max_t = sysmem::cores().max(s.threads).max(1);
    let thr = row(&mut root, "Threads", 28, || {
        let mut c = Choice::default();
        style_choice(&mut c);
        c.add_choice("Auto");
        for n in 1..=max_t {
            c.add_choice(&n.to_string());
        }
        c.set_value(s.threads.min(max_t) as i32);
        c
    });

    let l = label("System prompt", MUTED, 13);
    root.fixed(&l, 18);
    let mut sys = MultilineInput::default();
    style_input(&mut sys);
    sys.set_wrap(true);
    sys.set_value(&s.system_prompt);

    let mut stop = CheckButton::default().with_label(" Stop the model when it starts repeating itself");
    stop.set_label_color(col(TEXT));
    stop.set_label_size(13);
    stop.set_value(s.stop_repeats);
    root.fixed(&stop, 24);

    let chosen = Rc::new(RefCell::new(s.llama_server.clone()));
    let shown = |c: &str| {
        let t = Settings { llama_server: c.to_string(), ..s.clone() };
        exe_in_use(&t).unwrap_or_else(|| "not found".into())
    };
    let mut exe_label = row(&mut root, "llama-server in use", 28, || {
        let mut r = Flex::default().row();
        r.set_spacing(8);
        let mut f = label(&shown(&s.llama_server), TEXT, 12);
        f.set_align(Align::Inside | Align::Left | Align::Clip);
        let mut b = button("Choose…", false);
        r.fixed(&b, 90);
        let mut f2 = f.clone();
        let chosen = chosen.clone();
        let s2 = s.clone();
        b.set_callback(move |_| {
            if let Some(p) = pick("Choose llama-server", "") {
                let t = Settings { llama_server: p.clone(), ..s2.clone() };
                *chosen.borrow_mut() = p;
                f2.set_label(&exe_in_use(&t).unwrap_or_else(|| "not found".into()));
                f2.redraw();
            }
        });
        r.end();
        f
    });
    exe_label.set_tooltip("llama-server in use");

    let mut err = label("", DANGER, 13);
    root.fixed(&err, 36);

    let mut btns = Flex::default().row();
    btns.set_spacing(8);
    let _sp = Frame::default();
    let mut save = button("Save", true);
    let mut cancel = button("Cancel", false);
    btns.fixed(&save, 90);
    btns.fixed(&cancel, 90);
    btns.end();
    root.fixed(&btns, 30);
    root.end();
    win.end();

    fn sync(remote: bool, ws: &mut [&mut Input]) {
        for w in ws.iter_mut() {
            set(*w, remote);
        }
    }
    fn set<W: WidgetExt>(w: &mut W, on: bool) {
        if on {
            w.activate()
        } else {
            w.deactivate()
        }
    }
    let apply = {
        let (mut u, mut m, mut k) = (url.clone(), rmodel.clone(), key.clone());
        move |remote: bool| {
            sync(remote, &mut [&mut u, &mut m]);
            set(&mut k, remote);
        }
    };
    let mut apply0 = apply.clone();
    apply0(s.mode == Mode::Remote);
    {
        let mut apply = apply.clone();
        mode.set_callback(move |c| apply(c.value() == 1));
    }

    let mut w2 = win.clone();
    cancel.set_callback(move |_| w2.hide());
    let mut w3 = win.clone();
    let res = result.clone();
    let base = s.clone();
    save.set_callback(move |_| {
        let mut n = base.clone();
        n.mode = if mode.value() == 1 { Mode::Remote } else { Mode::Local };
        if n.mode == Mode::Remote {
            match chat::validate_base_url(&url.value()) {
                Ok(u) => n.remote_url = u,
                Err(e) => {
                    err.set_label(&e);
                    err.redraw();
                    return;
                }
            }
        } else {
            n.remote_url = url.value().trim().to_string();
        }
        n.remote_model = rmodel.value().trim().to_string();
        n.api_key = key.value();
        n.ctx = ctxs[ctx.value().max(0) as usize];
        n.threads = thr.value().max(0) as u32;
        n.system_prompt = sys.value();
        n.stop_repeats = stop.value();
        n.llama_server = chosen.borrow().clone();
        *res.borrow_mut() = Some(n);
        w3.hide();
    });
    win.show();
    while win.shown() {
        fltk::app::wait();
    }
    let out = result.borrow_mut().take();
    out
}
