// The one thing worth doing next on this machine, for the panda on Home to say.

import type { Job, LoadedModel, SystemInfo } from "./api";

export type NextStep = { text: string; cta: string; view: "jobs" | "models" | "chat" };

/**
 * What the panda in the banner says, and only when it has something to add:
 * the newest job failed, or no model is loaded and here is how much memory
 * there is to fill. Null otherwise: while setup is still open (the notices
 * under the banner cover that), while a job runs (the job list shows it) and
 * once a model is loaded (the buttons beside it say the rest).
 */
export function nextStep({ info, loaded, jobs, setupDone, ready }: {
  info: SystemInfo | null; loaded: LoadedModel | null; jobs: Job[]; setupDone: boolean | null; ready: boolean;
}): NextStep | null {
  if (!info || !ready || setupDone === false) return null;
  // Only the newest job: an old failure you have moved on from is not news.
  if (jobs[0]?.state === "failed") return { text: `${jobs[0].title} didn't work. The log says why.`, cta: "see what happened", view: "jobs" };
  if (!loaded) {
    const free = info.gpu.freeGb;
    return { text: free != null ? `You have ${free} GB of graphics memory free. Let's find a model that fits.` : "No model is loaded yet. Let's pick one.", cta: "models", view: "models" };
  }
  // A model is loaded and nothing went wrong: the buttons beside this already say "chat".
  return null;
}
