// The first-run wizard's own calls (electron/setup.js). Kept apart from
// api.ts so the wizard's contract is in one place.

import { ApiError } from "./api";

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const r = await window.arc.invoke<T>(channel, ...args);
  if (!r.ok) throw new ApiError(r.error, r.log);
  return r.value;
}

export type GpuVendor = "nvidia" | "amd" | "intel" | "apple" | "unknown";

export type SetupState = {
  done: boolean;
  /** ARCFLARE_FORCE_SETUP=1: show the wizard even after it was finished. */
  forced: boolean;
  /** Development preview of the "no llama.cpp" path. */
  pretendNoEngine: boolean;
  gpu: { name: string | null; vendor: GpuVendor };
  build: { backend: string; file: string; why: string; folder: string };
  releases: string;
};

export const setup = {
  state: () => call<SetupState>("setup:state"),
  /** Search again for llama-server; remembers it when found. */
  find: () => call<string | null>("setup:find"),
  /** Create and open the folder ArcFlare looks in for a llama.cpp build. */
  folder: () => call<string>("setup:folder"),
  done: (done: boolean) => call<boolean>("setup:done", done),
};
