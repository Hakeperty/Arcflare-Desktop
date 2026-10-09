# ArcFlare Desktop

ArcFlare without the command line. Chat with models on your own GPU, make images,
3D models and speech in the studio, and open your coding tools pointed at your
local model. Windows, macOS and Linux.

It is a face on the [ArcFlare engine](https://github.com/Hakeperty/ArcFlare-Code):
the app runs the engine's own code for finding models, sizing the context to your
free VRAM, supervising llama.cpp, and generating 3D and speech. So the app and
the `arcflare` command never disagree, and they share one settings file
(`~/.arcflare/config.json`).

## What's in it

| | |
| --- | --- |
| **Chat** | Conversations kept locally. Streaming replies, collapsible reasoning, stop, retry, per-chat system prompt, tok/s. Pick a model and it loads at the largest context that fits. |
| **Phone** | Press **phone** in the title bar and scan the QR code: your phone gets a chat with the model on this computer, from any network. It's the same relay and key as `/rc` in the CLI. The app only makes outbound HTTPS requests, so nothing listens on a port. The conversation shows in Chat as **phone**, and you can type into it from either side. |
| **Agent** | The ArcFlare coding agent on a folder you pick, in a window: the same tools, skills and MCP servers as `arcflare agent`. Every file it reads and writes shows as a card; each shell command and MCP call asks first, with **allow**, **allow for this session** and **deny**. **Auto mode** skips the questions (with a warning). **Stop** ends the turn at once. **Machine tools** toggles ArcFlare's machine server. Uses the model loaded in the app; a 20–35B coding model works best. A folder's own `.mcp.json` stays behind the same trust gate as in the CLI. |
| **Studio · Image** | stable-diffusion.cpp on this machine (SD 1.5, SDXL, FLUX checkpoints), or your own ComfyUI workflow when ComfyUI is running. One click sends an image to 3D. |
| **Studio · 3D** | Hunyuan3D and TripoSR, from an image or a description. Then **point and ask**: paint a soft selection on the model, type "make this bigger", "smooth it", "paint it red" or "pull it up a bit", and it changes just that part. Undo/redo, export `.glb`. |
| **Studio · Speech** | Qwen3-TTS, Kitten TTS 2, Kokoro, Chatterbox, VoxCPM2, OuteTTS. Preset voices, tone and emotion, voice cloning from a clip or a saved voice. |
| **Studio · Voice lab** | Record a voice from the microphone (with a passage to read, so the transcript is already written) or import a clip. Silence is trimmed and the take saved as a 24 kHz WAV under a name, with a consent check. Then try it on any cloning model, or **compare all models** on the same line, one after another. Saved voices live in `~/.arcflare/voices`, so `arcflare gen tts --clone <name>` uses them too. |
| **Studio · Flow** | A node graph that chains the tools: prompt → rewrite with the chat model → image → 3D, or text → speech. |
| **Models** | What's on this machine, and the arcflare.net hub marked fits / tight / too big against your free VRAM, with one-click download. |
| **Harnesses** | Open OpenCode, Hermes, Codex or the ArcFlare agent in a terminal, already pointed at your model. |

## How editing a 3D model works

Generated meshes are welded on load, so neighbouring faces share vertices. A
selection is a weight per vertex: the brush sets full weight at its centre, fading
to nothing at its edge, and every operation is scaled by that weight. Edits blend
into the surrounding surface instead of tearing a step into it.

The instruction is turned into operations (scale, stretch, move, inflate, smooth,
flatten, rotate, paint, delete) by the chat model you have loaded. It gets the
instruction plus a summary of the selection (size, centre, which way it faces) and
replies with JSON that is validated and clamped before anything is applied. With
no chat model loaded, a keyword parser handles the common requests.

## Performance

- **One GPU, shared fairly.** With "auto" (the default), a studio job that won't fit
  next to the chat model unloads it first. Chat reloads it when you send the next
  message.
- **Warm generators.** 3D and speech run through resident workers that keep the
  last model loaded between jobs. They unload after 10 idle minutes and exit after
  30.
- **The 3D view renders on demand.** It draws when something changes, not 60 times
  a second, so it isn't competing with generation for the GPU.
- **No styling framework at runtime.** One plain stylesheet.

## Develop

Needs Node 18+ and a clone of the engine next to this one:

```
C:\Users\you\ArcFlare-Code      the engine (github.com/Hakeperty/ArcFlare-Code)
C:\Users\you\ArcFlare-Desktop   this app
```

```bash
npm install
npm start          # build the UI and open the app
npm run dev        # live-reloading UI
npm run typecheck
```

`package.json` takes the engine from `file:../ArcFlare-Code`. For a release
build from a clean machine, switch it to `github:Hakeperty/ArcFlare-Code`.

## Package

```bash
npm run dist:win     # NSIS installer
npm run dist:mac     # .dmg (build on a Mac)
npm run dist:linux   # AppImage and .deb
```

The engine is unpacked from the app archive, because Python workers can't read
files inside it.

Releases are built by `.github/workflows/release.yml`: push a `v*` tag and it
builds on Windows, macOS and Linux and attaches the installers, `latest*.yml`
and blockmaps to a GitHub release.

## Updates

The app checks the GitHub releases 10 seconds after it starts and every 6 hours
(electron-updater, `electron/updater.js`). On Windows and the Linux AppImage it
downloads the new version in the background, then shows **ready · restart** in
the title bar. It installs when you click that, or the next time you quit,
never in the middle of a session. The macOS builds aren't signed, so
Squirrel.Mac can't replace them, and `.deb` installs belong to apt. There the
title bar says **update available** and opens the release page instead.

Settings → updates has **check now**, the current version, and a switch to turn
checking off (`desktopUpdates` in `~/.arcflare/config.json`). Development runs
(`npm run dev`) never check.

## Licence

MIT
