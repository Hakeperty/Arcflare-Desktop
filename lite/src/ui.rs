//! The main window.
use crate::dialog::{self, button, col, label, style_choice, style_input, ACCENT, BG, MUTED, PANEL, RAISED, TEXT};
use arcflare_lite::chat::{self, Event as ChatEvent, Msg};
use arcflare_lite::config::{self, Mode, Settings};
use arcflare_lite::models::{self, Fit, Model};
use arcflare_lite::server::{self, Server, ServerOpts};
use arcflare_lite::store::{self, Store};
use arcflare_lite::sysmem::{self, Mem};
use arcflare_lite::view;
use fltk::{
    app, browser::HoldBrowser, button::Button, dialog as fdlg, enums::*, frame::Frame, group::Flex, input::MultilineInput,
    menu::{Choice, MenuFlag}, prelude::*, text::*, window::Window,
};
use std::cell::RefCell;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

enum Ev {
    Loaded(Mutex<Option<Result<Server, String>>>),
    Chat(String, ChatEvent),
}

#[derive(Clone)]
struct Ui {
    win: Window,
    mem: Frame,
    state: Frame,
    new_btn: Button,
    list: HoldBrowser,
    del_btn: Button,
    choice: Choice,
    load_btn: Button,
    add_btn: Button,
    set_btn: Button,
    td: TextDisplay,
    tbuf: TextBuffer,
    sbuf: TextBuffer,
    input: MultilineInput,
    send_btn: Button,
}

struct App {
    ui: Ui,
    s: Settings,
    store: Store,
    models: Vec<Model>,
    cur: Option<usize>,
    server: Option<Server>,
    loaded: Option<String>,
    starting: Option<(JoinHandle<()>, Arc<AtomicBool>)>,
    stream_stop: Option<Arc<AtomicBool>>,
    reply: String,
    think: Option<(i32, i32)>,
    mem: Option<Mem>,
    tx: app::Sender<Ev>,
}

type Shared = Rc<RefCell<App>>;

const YOU: char = 'A';
const MODEL: char = 'B';
const BODY: char = 'C';
const NOTE: char = 'D';

fn bytes_of(c: char, n: usize) -> String {
    std::iter::repeat_n(c, n).collect()
}

fn home_text() -> String {
    config::home().display().to_string()
}

impl App {
    fn busy(&self) -> bool {
        self.starting.is_some() || self.stream_stop.is_some()
    }

    fn put(&mut self, text: &str, style: char) {
        let (_, y) = self.ui.td.position_to_xy(self.ui.tbuf.length());
        let follow = y >= self.ui.td.y() && y <= self.ui.td.y() + self.ui.td.h();
        self.ui.tbuf.append(text);
        self.ui.sbuf.append(&bytes_of(style, text.len()));
        if follow {
            let n = self.ui.tbuf.length();
            self.ui.td.set_insert_position(n);
            self.ui.td.show_insert_position();
        }
        self.ui.td.redraw();
    }

    fn put_msg(&mut self, role: &str, content: &str) {
        if role == "user" {
            self.put("You\n", YOU);
        } else {
            self.put("Model\n", MODEL);
        }
        self.put(content, BODY);
        self.put("\n\n", BODY);
    }

    fn clear_view(&mut self) {
        self.ui.tbuf.set_text("");
        self.ui.sbuf.set_text("");
        self.think = None;
    }

    fn show_chat(&mut self) {
        self.clear_view();
        let msgs = self.cur.and_then(|i| self.store.chats.get(i)).map(|c| c.msgs.clone()).unwrap_or_default();
        if msgs.is_empty() {
            let no_server = self.s.mode == Mode::Local && !self.exe_found();
            let nm = if self.models.is_empty() { Some(home_text()) } else { None };
            let t = view::empty_text(self.mem, no_server, nm.as_deref());
            self.put(&t, BODY);
        } else {
            for m in &msgs {
                self.put_msg(&m.role, &m.content);
            }
        }
        self.ui.td.scroll(0, 0);
        let n = self.ui.tbuf.length();
        if !msgs.is_empty() {
            self.ui.td.set_insert_position(n);
            self.ui.td.show_insert_position();
        }
    }

    fn exe_found(&self) -> bool {
        dialog::exe_in_use(&self.s).is_some()
    }

    fn refresh_list(&mut self) {
        self.ui.list.clear();
        for c in &self.store.chats {
            self.ui.list.add(&c.title.replace('@', "@@"));
        }
        if let Some(i) = self.cur {
            self.ui.list.select(i as i32 + 1);
        }
    }

    fn refresh_mem(&mut self) {
        self.mem = sysmem::read();
        self.ui.mem.set_label(&view::memory_label(self.mem));
        self.ui.mem.redraw();
    }

    fn ctx_for(&self, m: &Model) -> u32 {
        if self.s.ctx > 0 {
            self.s.ctx
        } else {
            models::auto_ctx(m.size_mb, self.mem)
        }
    }

    fn refresh_models(&mut self) {
        let mut ms = models::discover(&models::roots());
        if !self.s.model.is_empty() {
            let p = std::path::PathBuf::from(&self.s.model);
            if p.is_file() && !ms.iter().any(|m| m.path == p) {
                let size = std::fs::metadata(&p).map(|m| m.len() / (1024 * 1024)).unwrap_or(0);
                let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                ms.push(Model { name, path: p, size_mb: size });
            }
        }
        ms.sort_by_key(|m| m.size_mb);
        self.models = ms;
        self.ui.choice.clear();
        for m in &self.models {
            let f = models::fit(m.size_mb, self.ctx_for(m), self.mem);
            let l = view::model_label(m, f).replace('\\', "\\\\").replace('/', "\\/").replace('|', "\\|");
            self.ui.choice.add(&l, Shortcut::None, MenuFlag::Normal, |_| {});
        }
        let idx = self.models.iter().position(|m| m.path.display().to_string() == self.s.model).unwrap_or(0);
        if !self.models.is_empty() {
            self.ui.choice.set_value(idx as i32);
        }
        self.ui.choice.redraw();
    }

    fn selected_model(&self) -> Option<Model> {
        let i = self.ui.choice.value();
        if i < 0 {
            return None;
        }
        self.models.get(i as usize).cloned()
    }

    fn update(&mut self) {
        let remote = self.s.mode == Mode::Remote;
        let st = if remote {
            "another computer"
        } else if self.starting.is_some() {
            "starting…"
        } else if self.server.is_some() {
            "ready"
        } else {
            "no model loaded"
        };
        self.ui.state.set_label(st);
        let ready = !remote && self.server.is_some();
        self.ui.state.set_label_color(col(if ready || remote { ACCENT } else { MUTED }));
        self.ui.load_btn.set_label(if self.starting.is_some() {
            "Starting…"
        } else if self.server.is_some() {
            "Unload"
        } else {
            "Load"
        });
        let streaming = self.stream_stop.is_some();
        self.ui.send_btn.set_label(if streaming { "Stop" } else { "Send" });
        set_active(&mut self.ui.load_btn, !remote && self.starting.is_none() && !streaming);
        set_active(&mut self.ui.choice, !remote && self.server.is_none() && self.starting.is_none());
        set_active(&mut self.ui.list, !streaming);
        set_active(&mut self.ui.new_btn, !streaming);
        set_active(&mut self.ui.del_btn, !streaming && self.cur.is_some());
        let busy = self.busy();
        set_active(&mut self.ui.set_btn, !busy);
        set_active(&mut self.ui.add_btn, !busy && !remote);
        self.ui.win.redraw();
    }

    fn save_store(&self) {
        let _ = self.store.save(&store::default_path());
    }

    fn remove_think(&mut self) {
        if let Some((a, b)) = self.think.take() {
            self.ui.tbuf.remove(a, b);
            self.ui.sbuf.remove(a, b);
        }
    }

    fn handle(&mut self, ev: Ev) {
        match ev {
            Ev::Loaded(cell) => {
                let r = cell.lock().ok().and_then(|mut g| g.take());
                let cancelled = self.starting.is_none();
                if let Some((h, _)) = self.starting.take() {
                    let _ = h.join();
                }
                match r {
                    Some(Ok(srv)) if !cancelled => {
                        self.server = Some(srv);
                        let n = self.selected_model().map(|m| m.path.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or(m.name));
                        self.loaded = n;
                    }
                    Some(Err(e)) => {
                        let e = format!("{e}\n");
                        self.put(&e, NOTE);
                    }
                    _ => {}
                }
                self.update();
            }
            Ev::Chat(id, e) => {
                let Some(ci) = self.store.chats.iter().position(|c| c.id == id) else { return };
                match e {
                    ChatEvent::Thinking => {
                        if self.think.is_none() {
                            let a = self.ui.tbuf.length();
                            self.put("thinking…", NOTE);
                            self.think = Some((a, self.ui.tbuf.length()));
                        }
                    }
                    ChatEvent::Text(t) => {
                        self.remove_think();
                        self.reply.push_str(&t);
                        self.put(&t, BODY);
                    }
                    ChatEvent::Done { tps, cut_repeat } => {
                        self.remove_think();
                        self.put("\n", BODY);
                        if cut_repeat {
                            self.put("stopped: the model was repeating itself\n", NOTE);
                        }
                        if let Some(t) = tps {
                            self.put(&format!("{}\n", view::speed_note(t)), NOTE);
                        }
                        self.put("\n", BODY);
                        self.finish_reply(ci);
                    }
                    ChatEvent::Error(e) => {
                        self.remove_think();
                        self.put(&format!("\n{e}\n\n"), NOTE);
                        self.finish_reply(ci);
                    }
                }
            }
        }
    }

    fn finish_reply(&mut self, ci: usize) {
        let reply = std::mem::take(&mut self.reply);
        if !reply.trim().is_empty() {
            self.store.chats[ci].msgs.push(Msg { role: "assistant".into(), content: reply });
        }
        self.stream_stop = None;
        self.save_store();
        self.update();
    }
}

fn set_active<W: WidgetExt>(w: &mut W, on: bool) {
    if on {
        w.activate()
    } else {
        w.deactivate()
    }
}

fn on_new(a: &Shared) {
    let mut a = a.borrow_mut();
    if a.stream_stop.is_some() {
        return;
    }
    a.cur = None;
    a.refresh_list();
    a.show_chat();
    a.update();
    let _ = a.ui.input.take_focus();
}

fn on_pick(a: &Shared) {
    let mut a = a.borrow_mut();
    if a.stream_stop.is_some() {
        return;
    }
    let v = a.ui.list.value();
    if v > 0 {
        a.cur = Some(v as usize - 1);
        a.show_chat();
        a.update();
    }
}

fn on_delete(a: &Shared) {
    let cur = {
        let g = a.borrow();
        if g.stream_stop.is_some() {
            return;
        }
        g.cur
    };
    if cur.is_none() {
        return;
    }
    if fdlg::choice2_default("Delete this chat?", "Cancel", "Delete", "") != Some(1) {
        return;
    }
    let mut a = a.borrow_mut();
    if let Some(i) = a.cur {
        if i < a.store.chats.len() {
            a.store.chats.remove(i);
        }
    }
    a.cur = None;
    a.save_store();
    a.refresh_list();
    a.show_chat();
    a.update();
}

fn on_load(app: &Shared) {
    let (opts, too_big) = {
        let mut a = app.borrow_mut();
        if a.starting.is_some() {
            return;
        }
        if a.server.is_some() {
            a.server = None;
            a.loaded = None;
            a.update();
            return;
        }
        let Some(m) = a.selected_model() else {
            let t = format!("{}\n", view::no_models(&home_text()));
            a.put(&t, NOTE);
            return;
        };
        let configured = if a.s.llama_server.trim().is_empty() { config::shared_llama_server() } else { Some(a.s.llama_server.clone()) };
        let Some(exe) = server::find_llama_server(configured.as_deref()) else {
            a.put(&format!("{}\n", view::NO_SERVER), NOTE);
            return;
        };
        let ctx = a.ctx_for(&m);
        let threads = if a.s.threads > 0 { a.s.threads } else { sysmem::cores().max(1) };
        let big = models::fit(m.size_mb, ctx, a.mem) == Fit::TooBig;
        (ServerOpts { exe, model: m.path, ctx, threads, port: server::free_port() }, big)
    };
    if too_big
        && fdlg::choice2_default(
            "This model is larger than your free memory and may make the computer very slow. Load it anyway?",
            "Cancel",
            "Load",
            "",
        ) != Some(1)
    {
        return;
    }
    let mut a = app.borrow_mut();
    let cancel = Arc::new(AtomicBool::new(false));
    let c2 = cancel.clone();
    let tx = a.tx;
    let h = std::thread::spawn(move || {
        let r = match Server::start(&opts) {
            Err(e) => Err(format!("Could not start llama-server: {e}")),
            Ok(mut srv) => match srv.wait_ready(Duration::from_secs(180), &c2) {
                Ok(()) => Ok(srv),
                Err(e) => Err(e),
            },
        };
        if c2.load(Ordering::SeqCst) {
            return; // window closing: dropping the server stops it
        }
        tx.send(Ev::Loaded(Mutex::new(Some(r))));
        app::awake();
    });
    a.starting = Some((h, cancel));
    a.update();
}

fn on_send(app: &Shared) {
    let mut a = app.borrow_mut();
    if let Some(s) = &a.stream_stop {
        s.store(true, Ordering::SeqCst);
        return;
    }
    let text = a.ui.input.value();
    if text.trim().is_empty() {
        return;
    }
    let remote = a.s.mode == Mode::Remote;
    if !remote && a.server.is_none() {
        a.put("Load a model first.\n", NOTE);
        return;
    }
    let (base, model) = if remote {
        (a.s.remote_url.clone(), a.s.remote_model.clone())
    } else {
        (format!("http://127.0.0.1:{}", a.server.as_ref().map_or(0, |s| s.port)), a.loaded.clone().unwrap_or_default())
    };
    if remote && chat::validate_base_url(&base).is_err() {
        a.put("Set the address of the other computer in Settings first.\n", NOTE);
        return;
    }
    let ci = match a.cur {
        Some(i) => i,
        None => {
            let i = a.store.new_chat();
            a.cur = Some(i);
            a.refresh_list();
            i
        }
    };
    let first = a.store.chats[ci].msgs.is_empty();
    a.store.chats[ci].msgs.push(Msg { role: "user".into(), content: text.trim_end().to_string() });
    if first {
        a.store.chats[ci].title = store::title_from(&text);
        a.refresh_list();
        a.clear_view();
    }
    a.put_msg("user", text.trim_end());
    a.put("Model\n", MODEL);
    a.ui.input.set_value("");
    a.save_store();
    let msgs = a.store.chats[ci].msgs.clone();
    let id = a.store.chats[ci].id.clone();
    let body = chat::request_body(&model, &msgs, &a.s.system_prompt);
    let key = a.s.api_key.clone();
    let guard = a.s.stop_repeats;
    let stop = Arc::new(AtomicBool::new(false));
    a.stream_stop = Some(stop.clone());
    a.reply.clear();
    let tx = a.tx;
    std::thread::spawn(move || {
        chat::stream(&base, &key, &body, &stop, guard, &mut |e| {
            tx.send(Ev::Chat(id.clone(), e));
            app::awake();
        });
    });
    a.update();
}

fn on_settings(app: &Shared) {
    let cur = app.borrow().s.clone();
    let Some(n) = dialog::open(&cur) else { return };
    let mut a = app.borrow_mut();
    let mode_changed = n.mode != a.s.mode;
    a.s = n;
    let _ = a.s.save();
    if mode_changed && a.s.mode == Mode::Remote {
        a.server = None;
        a.loaded = None;
    }
    a.refresh_models();
    if a.cur.is_none_or(|i| a.store.chats.get(i).is_none_or(|c| c.msgs.is_empty())) {
        a.show_chat();
    }
    a.update();
}

fn on_add(app: &Shared) {
    let Some(p) = dialog::choose_gguf() else { return };
    let mut a = app.borrow_mut();
    a.s.model = p;
    let _ = a.s.save();
    a.refresh_models();
    if a.cur.is_none_or(|i| a.store.chats.get(i).is_none_or(|c| c.msgs.is_empty())) {
        a.show_chat();
    }
    a.update();
}

fn on_close(app: &Shared) {
    let mut a = app.borrow_mut();
    if let Some(s) = &a.stream_stop {
        s.store(true, Ordering::SeqCst);
    }
    if let Some((h, cancel)) = a.starting.take() {
        cancel.store(true, Ordering::SeqCst);
        let _ = h.join();
    }
    a.server = None; // Drop stops llama-server
    app::quit();
}

fn flat(f: &mut Flex, color: u32) {
    f.set_frame(FrameType::FlatBox);
    f.set_color(col(color));
}

pub fn run(self_test: bool) {
    // A model server from an earlier run that crashed is stopped first, and one this run starts is
    // stopped when the app is told to quit from outside (logout, shutdown, Ctrl+C).
    server::reap_stale();
    let _ = ctrlc::set_handler(|| {
        server::kill_running();
        std::process::exit(0);
    });
    let a = app::App::default();
    app::background(0x0b, 0x0b, 0x0a);
    app::background2(0x1a, 0x1a, 0x18);
    app::foreground(0xed, 0xea, 0xe2);
    app::set_color(Color::Selection, 0xff, 0xb0, 0x20);
    app::set_visible_focus(true);
    app::set_font_size(13);

    let mut win = Window::default().with_size(980, 640).with_label("ArcFlare Lite");
    win.set_color(col(BG));
    win.size_range(720, 480, 0, 0);
    let mut root = Flex::default_fill().column();
    root.set_margin(0);
    root.set_spacing(0);

    let mut top = Flex::default().row();
    flat(&mut top, BG);
    top.set_margins(14, 6, 14, 6);
    top.set_spacing(10);
    let mut title = label("ArcFlare Lite", ACCENT, 16);
    title.set_label_font(Font::HelveticaBold);
    top.fixed(&title, 110);
    let subtitle = label(view::SUBTITLE, MUTED, 12);
    let mut mem = label("", MUTED, 13);
    mem.set_align(Align::Inside | Align::Right);
    top.fixed(&mem, 170);
    let mut state = label("", MUTED, 13);
    state.set_align(Align::Inside | Align::Right);
    top.fixed(&state, 120);
    top.end();
    root.fixed(&top, 38);

    let mut body = Flex::default().row();
    flat(&mut body, BG);
    body.set_margin(8);
    body.set_spacing(8);

    let mut left = Flex::default().column();
    flat(&mut left, PANEL);
    left.set_margin(8);
    left.set_spacing(8);
    let new_btn = button("New chat", true);
    left.fixed(&new_btn, 30);
    let mut list = HoldBrowser::default();
    list.set_frame(FrameType::FlatBox);
    list.set_color(col(PANEL));
    list.set_text_size(13);
    list.set_selection_color(col(ACCENT));
    let del_btn = button("Delete chat", false);
    left.fixed(&del_btn, 30);
    left.end();
    body.fixed(&left, 210);

    let mut right = Flex::default().column();
    flat(&mut right, PANEL);
    right.set_margin(8);
    right.set_spacing(8);
    let mut r1 = Flex::default().row();
    r1.set_spacing(8);
    let mut choice = Choice::default();
    style_choice(&mut choice);
    let load_btn = button("Load", true);
    let add_btn = button("Add model file…", false);
    let set_btn = button("Settings", false);
    r1.fixed(&load_btn, 90);
    r1.fixed(&add_btn, 130);
    r1.fixed(&set_btn, 90);
    r1.end();
    right.fixed(&r1, 30);

    let mut td = TextDisplay::default();
    td.set_frame(FrameType::FlatBox);
    td.set_color(col(PANEL));
    td.set_text_size(14);
    td.set_text_color(col(TEXT));
    td.set_cursor_color(col(PANEL));
    td.set_selection_color(col(0x5a4010));
    td.wrap_mode(WrapMode::AtBounds, 0);
    let tbuf = TextBuffer::default();
    let sbuf = TextBuffer::default();
    td.set_buffer(tbuf.clone());
    let styles = vec![
        StyleTableEntry { color: col(ACCENT), font: Font::HelveticaBold, size: 14 },
        StyleTableEntry { color: col(MUTED), font: Font::HelveticaBold, size: 13 },
        StyleTableEntry { color: col(TEXT), font: Font::Helvetica, size: 14 },
        StyleTableEntry { color: col(MUTED), font: Font::HelveticaItalic, size: 13 },
    ];
    td.set_highlight_data(sbuf.clone(), styles);

    let mut r3 = Flex::default().row();
    r3.set_spacing(8);
    let mut input = MultilineInput::default();
    style_input(&mut input);
    input.set_wrap(true);
    input.set_color(col(RAISED));
    let send_btn = button("Send", true);
    r3.fixed(&send_btn, 90);
    r3.end();
    right.fixed(&r3, 74);
    right.end();
    body.end();
    root.end();
    win.end();

    let (tx, rx) = app::channel::<Ev>();
    let ui = Ui { win: win.clone(), mem, state, new_btn, list, del_btn, choice, load_btn, add_btn, set_btn, td, tbuf, sbuf, input, send_btn };
    let s = Settings::load();
    let mut store = Store::load(&store::default_path());
    store.chats.sort_by_key(|c| std::cmp::Reverse(c.created));
    let app_state: Shared = Rc::new(RefCell::new(App {
        ui: ui.clone(),
        s,
        store,
        models: Vec::new(),
        cur: None,
        server: None,
        loaded: None,
        starting: None,
        stream_stop: None,
        reply: String::new(),
        think: None,
        mem: None,
        tx,
    }));
    {
        let mut g = app_state.borrow_mut();
        g.refresh_mem();
        g.refresh_models();
        g.refresh_list();
        g.show_chat();
        g.update();
    }

    macro_rules! hook {
        ($w:ident, $f:ident) => {{
            let s = app_state.clone();
            let mut w = ui.$w.clone();
            w.set_callback(move |_| $f(&s));
        }};
    }
    hook!(new_btn, on_new);
    hook!(list, on_pick);
    hook!(del_btn, on_delete);
    hook!(load_btn, on_load);
    hook!(send_btn, on_send);
    hook!(set_btn, on_settings);
    hook!(add_btn, on_add);
    {
        let s = app_state.clone();
        let mut c = ui.choice.clone();
        c.set_callback(move |c| {
            let mut a = s.borrow_mut();
            if let Some(m) = a.models.get(c.value().max(0) as usize).cloned() {
                a.s.model = m.path.display().to_string();
                let _ = a.s.save();
            }
        });
    }
    {
        let s = app_state.clone();
        let mut inp = ui.input.clone();
        inp.handle(move |_, ev| {
            if ev == fltk::enums::Event::KeyDown {
                let k = app::event_key();
                let ctrl = app::is_event_ctrl();
                if (k == Key::Enter || k == Key::KPEnter) && !app::is_event_shift() {
                    on_send(&s);
                    return true;
                }
                if k == Key::Escape {
                    if let Some(st) = &s.borrow().stream_stop {
                        st.store(true, Ordering::SeqCst);
                    }
                    return true;
                }
                if ctrl && k == Key::from_char('n') {
                    on_new(&s);
                    return true;
                }
            }
            false
        });
    }
    {
        let s = app_state.clone();
        let mut w = win.clone();
        w.set_callback(move |_| {
            if app::event() == fltk::enums::Event::Close {
                on_close(&s);
            } else if let Some(st) = &s.borrow().stream_stop {
                st.store(true, Ordering::SeqCst); // Esc
            }
        });
        let s = app_state.clone();
        w.handle(move |_, ev| {
            if ev == fltk::enums::Event::Shortcut && app::is_event_ctrl() && app::event_key() == Key::from_char('n') {
                on_new(&s);
                return true;
            }
            false
        });
        let mut sub = subtitle.clone();
        w.resize_callback(move |_, _, _, w, _| {
            sub.set_label(if w < 900 { "" } else { view::SUBTITLE });
        });
    }
    {
        let s = app_state.clone();
        app::add_timeout3(5.0, move |h| {
            if let Ok(mut g) = s.try_borrow_mut() {
                g.refresh_mem();
            }
            app::repeat_timeout3(5.0, h);
        });
    }

    win.show();
    let _ = ui.input.clone().take_focus();
    if self_test {
        for _ in 0..10 {
            app::wait_for(0.1).ok();
        }
        on_close(&app_state);
        return;
    }
    while a.wait() {
        while let Some(ev) = rx.recv() {
            if let Ok(mut g) = app_state.try_borrow_mut() {
                g.handle(ev);
            }
        }
    }
    on_close(&app_state);
}
