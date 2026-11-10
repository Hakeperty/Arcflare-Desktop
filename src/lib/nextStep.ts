// The one thing worth doing next on this machine, for the panda on Home to say.

import type { Job, LoadedModel, SystemInfo } from "./api";

export type NextStep = { text: string; cta: string; view: "jobs" | "models" | "chat" };

/**
 * What the panda in the banner says: the one thing worth doing next on this
 * machine right now, and the screen that does it. Null while setup is still
 * open (the notices under the banner cover that) or nothing is known yet.
 */
export function nextStep({ info, loaded, jobs, setupDone, ready }: {
  info: SystemInfo | null; loaded: LoadedModel | null; jobs: Job[]; setupDone: boolean | null; ready: boolean;
}): NextStep | null {
  if (!info || !ready || setupDone === false) return null;
  const running = jobs.find((j) => j.state === "running");
  if (running) {
    const pct = running.progress != null ? ` ${Math.round(running.progress)}%` : "";
    return { text: `Working on it: ${running.title}${pct}.`, cta: "watch", view: "jobs" };
  }
  // Only the newest job: an old failure you have moved on from is not news.
  if (jobs[0]?.state === "failed") return { text: `${jobs[0].title} didn't work. The log says why.`, cta: "see what happened", view: "jobs" };
  if (!loaded) {
    const free = info.gpu.freeGb;
    return { text: free != null ? `You have ${free} GB of graphics memory free. Let's find a model that fits.` : "No model is loaded yet. Let's pick one.", cta: "models", view: "models" };
  }
  return { text: `${loaded.name} is loaded and listening. Ask it something.`, cta: "chat", view: "chat" };
}
