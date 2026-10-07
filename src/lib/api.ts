// The typed contract between the UI and the main process. Every screen talks
// to the engine through these functions; electron/preload.js is the only door.

type Envelope<T> = { ok: true; value: T } | { ok: false; error: string; log?: string | null };

declare global {
  interface Window {
    arc: {
      platform: string;
      invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<Envelope<T>>;
      on(event: string, fn: (payload: any) => void): () => void;
    };
  }
}

export class ApiError extends Error {
  log: string | null;
  constructor(message: string, log?: string | null) {
    super(message);
    this.log = log ?? null;
  }
}

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const r = await window.arc.invoke<T>(channel, ...args);
  if (!r.ok) throw new ApiError(r.error, r.log);
  return r.value;
}

export const on = (event: string, fn: (payload: any) => void) => window.arc.on(event, fn);
export const platform = () => window.arc.platform;

// ------------------------------------------------------------------ types ----

export type SystemInfo = {
  platform: string;
  arch: string;
  engineVersion: string;
  gpu: { freeGb: number | null; totalGb: number | null };
  ramGb: number;
  llamaServer: string | null;
  serverRunning: boolean;
  loaded: LoadedModel | null;
  python: string | null;
  home: string;
};

export type LocalModel = {
  id: string;
  name: string;
  file: string;
  sizeGb: number;
  quant: string;
  trainCtx: number | null;
  moe: string | null;
  vision: boolean;
  bestCtx: number | null;
  fits: boolean | null;
};

export type LoadedModel = { id: string; servedId: string; port: number; ctx: number; name: string };

export type ModelProgress = {
  id: string;
  stage: "planning" | "reloading" | "server-starting" | "server-ready" | "loading" | "retry" | "loaded" | "failed";
  ms?: number;
  ctx?: number;
  reason?: "batch" | "context";
  reducedFrom?: number | null;
  error?: string;
};

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
export type ChatResult = { text: string; tokPerSec: number | null; promptTokens: number | null; outputTokens: number | null };

export type GenModel = {
  id: string;
  kind: "3d" | "tts";
  label: string;
  params: string;
  vram: number;
  note: string;
  cloning: boolean;
  instruct: boolean;
  text: boolean;
  texture: boolean;
  installed: boolean;
  weights: boolean;
  voices: string[] | null;
  defaultVoice: string | null;
};

export type Job = {
  id: string;
  kind: "3d" | "tts" | "image" | "setup" | "download";
  title: string;
  state: "running" | "done" | "failed" | "cancelled";
  stage: string;
  progress: number | null;
  log: string[];
  result: { file?: string; seconds?: number; faces?: number; ms?: number; [k: string]: unknown } | null;
  error: string | null;
  stderr?: string[] | null;
  started: number;
};

export type ImageModels = { sd: string | null; models: { path: string; name: string; sizeGb: number }[] };

export type HubModel = {
  slug: string; name: string; author: string; description: string; category: string; tags: string[];
  license: string; commercial: boolean | null; defaultSize: string; vram: string; run: string;
  runnable: boolean; featured: boolean; url: string;
  fit: "fits" | "tight" | "no" | "unknown";
  plan: { kind: "pull" | "gen" | "none"; ref?: string; id?: string };
};

export type Settings = {
  llamaServer: string; memoryProfile: string; studioVram: "auto" | "keep";
  sdcpp: string; imageModelsDir: string; comfyUrl: string; genPython: string; stopServerOnQuit: boolean;
};

export type Harness = { id: string; label: string; installed: boolean; builtin: boolean; bin: string | null };
export type StudioFile = { path: string; name: string; bytes: number; mtime: number };

// ----------------------------------------------------------------- calls ----

export const api = {
  systemInfo: () => call<SystemInfo>("sys:info"),
  settings: () => call<Settings>("settings:get"),
  saveSettings: (patch: Partial<Settings>) => call<boolean>("settings:set", patch),

  models: () => call<LocalModel[]>("models:list"),
  loadModel: (id: string, opts?: { ctx?: number }) => call<LoadedModel>("models:load", id, opts ?? {}),
  unloadModel: () => call<void>("models:unload"),

  chat: (requestId: string, payload: { messages: ChatMessage[]; temperature?: number; maxTokens?: number }) =>
    call<ChatResult>("chat:send", requestId, payload),
  stopChat: (requestId: string) => call<void>("chat:stop", requestId),
  planEdit: (req: { instruction: string; selection: unknown; ops: string[] }) => call<unknown[] | null>("edit:plan", req),

  genStatus: () => call<GenModel[]>("gen:status"),
  genSetup: (id: string, opts?: { torch?: string; torchFrom?: string; texture?: boolean }) => call<Job>("gen:setup", id, opts ?? {}),
  gen3d: (opts: { model: string; image?: string; prompt?: string; steps?: number; octree?: number; faces?: number; seed?: number; texture?: boolean }) =>
    call<Job>("gen:3d", opts),
  tts: (opts: { model: string; text: string; voice?: string; ref?: string; refText?: string; lang?: string; instruct?: string; speed?: number }) =>
    call<Job>("gen:tts", opts),

  imageModels: () => call<ImageModels>("image:models"),
  generateImage: (opts: {
    backend: "sdcpp" | "comfy"; model?: string; workflow?: string; prompt: string; negative?: string;
    width?: number; height?: number; steps?: number; cfg?: number; seed?: number; sampler?: string;
    initImage?: string; strength?: number; lowVram?: boolean;
  }) => call<Job>("image:generate", opts),
  comfyStatus: () => call<{ up: boolean; version?: string; devices?: string[]; error?: string }>("comfy:status"),

  jobs: () => call<Job[]>("jobs:list"),
  cancelJob: (id: string) => call<void>("jobs:cancel", id),

  hub: (refresh?: boolean) => call<{ source: string; url: string; ageText: string; freeGb: number | null; models: HubModel[] }>("hub:catalogue", !!refresh),
  hubInstall: (slug: string, model: HubModel) => call<Job>("hub:install", slug, model),

  harnesses: () => call<Harness[]>("harness:list"),
  launchHarness: (id: string, modelId?: string) => call<boolean>("harness:launch", id, modelId),

  pickFile: (opts?: { directory?: boolean; filters?: { name: string; extensions: string[] }[]; title?: string }) =>
    call<string | null>("files:pick", opts ?? {}),
  saveAs: (src: string, opts?: { filters?: { name: string; extensions: string[] }[] }) => call<string | null>("files:saveAs", src, opts ?? {}),
  writeBytes: (name: string, bytes: ArrayBuffer) => call<string>("files:writeBytes", name, bytes),
  reveal: (p: string) => call<boolean>("files:reveal", p),
  openStudioFolder: () => call<void>("files:openStudio"),
  studioFiles: (kind: "image" | "mesh" | "audio") => call<StudioFile[]>("files:list", kind),
  openExternal: (url: string) => call<boolean>("open:external", url),
};

/** A URL the page can load a local file from (images, meshes, audio). */
export function fileUrl(p: string, bust?: number): string {
  // A fixed host and the path as a query parameter: arcfile is a "standard"
  // scheme, and a Windows drive letter in the path part would parse as a host.
  return `arcfile://local/?p=${encodeURIComponent(p)}${bust ? `&v=${bust}` : ""}`;
}

export const uid = () => Math.random().toString(36).slice(2, 10);

// ------------------------------------------------------------ phone (rc) ----

export type RcTurn = { role: "user" | "assistant"; content: string; from?: "phone" | "desktop" };
export type RcStatus = {
  on: boolean; connected: boolean; clients: number; relay: string; link: string; keyHint: string;
  qrSvg: string; note: string; busy: boolean; history: RcTurn[];
};
export type RcTurnEvent =
  | { phase: "start"; requestId: string; text: string; from: "phone" | "desktop" }
  | { phase: "done"; requestId: string; text: string; tokPerSec: number | null }
  | { phase: "error"; requestId: string; error: string };

export const rc = {
  start: () => call<RcStatus>("rc:start"),
  stop: () => call<RcStatus>("rc:stop"),
  status: () => call<RcStatus>("rc:status"),
  say: (text: string) => call<boolean>("rc:say", text),
  clear: () => call<boolean>("rc:clear"),
};
