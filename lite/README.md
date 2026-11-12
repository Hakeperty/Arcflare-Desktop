# ArcFlare Lite

The small version of ArcFlare, for old laptops, Raspberry Pi and other small computers. It is a separate
app from ArcFlare Desktop, written in Rust, and it does one thing: chat with a model.

It is made for weak machines and that is where it works best. On a computer with plenty of memory, use
ArcFlare Desktop instead: it has the agent, images, 3D and speech, and Lite has none of them.

## How small

Measured on Linux x64, both on the same machine, at idle:

| | ArcFlare Lite | ArcFlare Desktop |
| --- | --- | --- |
| Memory | about 13 MB | about 312 MB |

The program is a single file of 1.6 MB.

Lite draws its window with FLTK, which needs no graphics driver, so it also runs where a web view or
OpenGL does not. The memory it saves goes to the model, which is what a small computer is short of.

## What it does

- **Chat** with a model on this computer, with the reply appearing as it is written. Stop at any time.
- **Use a model on another computer** on your network: give it the address of a machine running
  `arcflare serve` or llama.cpp's `llama-server`, and the small computer is only the window.
- **Chats are kept** on this computer, in `~/.arcflare/lite/chats.json`.
- **Models are listed smallest first**, each marked fits, tight or too big against the memory that is
  free right now. Loading one that is too big asks first.
- **It stops a model that repeats itself.** Small models go round in circles; when the same sentence or
  passage keeps coming back, the reply is cut and says so. This can be switched off in Settings.
- **The model server never outlives the app.** It is stopped when the window closes and when the app is
  told to quit (logout, shutdown), and one left behind by a crash is stopped at the next start.

It does not download models, update itself, run an agent, or make images, 3D or speech.

## What it needs

- **A model server.** Lite starts llama.cpp's `llama-server` for you. It looks for one in Settings, in
  `ARCFLARE_LLAMA_SERVER`, under `~/.arcflare/engine` (where the `arcflare` command installs it), on the
  `PATH`, and in the usual llama.cpp folders. Or skip this and use another computer.
- **A model file** (`.gguf`) smaller than your free memory. Lite finds the ones in `~/.arcflare/models`
  and in llama.cpp's cache, the same folders the `arcflare` command uses, or press **Add model file**.

It shares models and the server with the other ArcFlare apps, and reads their settings file only to find
`llama-server`; it never writes to it. Its own settings are in `~/.arcflare/lite/settings.json`.

## How it runs a model

One model, started with a small footprint: bound to `127.0.0.1` only, one request at a time, no prompt
cache held in memory, a context of 2,048 or 4,096 tokens chosen from the free memory (or the size you
set), and as many threads as the computer has cores.

## Keys

Enter sends, Shift+Enter makes a new line, Esc stops a reply, Ctrl+N starts a new chat.

## Safety

- The model server listens on this computer only.
- Settings and chats are written with access for your user only.
- A model on another computer is reached over plain `http`. Use it on your own network: a key you enter
  travels unencrypted.

## Build

A recent stable Rust (it is built and tested with 1.97). On Linux, FLTK is built from source and needs these headers first:

```bash
sudo apt-get install libx11-dev libxext-dev libxft-dev libxinerama-dev libxcursor-dev \
  libxfixes-dev libxrender-dev libpango1.0-dev libcairo2-dev libfontconfig1-dev cmake g++
```

```bash
cd lite
cargo build --release      # target/release/arcflare-lite
cargo test
```

`arcflare-lite --self-test` opens the window, runs it briefly and exits; CI uses it to prove the window
opens. The workflow in `.github/workflows/lite.yml` builds and tests on Linux x64, Linux ARM and Windows.

## Status

Version 0.1. Tested on Linux x64: 41 tests, and the real window driven with a keyboard against a
stand-in model server (loading a model, a streamed reply, the repeat stop, another computer, stopping the
server on quit and after a crash). Not yet run against a real `llama-server`, on a real Raspberry Pi, or
by hand on Windows.
