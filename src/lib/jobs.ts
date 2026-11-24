// Following one job. "job:update" events only reach listeners that are
// already subscribed, and a job can finish before the screen that started it
// has subscribed: a generation that fails at once (a missing binary, a
// workflow ComfyUI rejects) sends its last event before the call that started
// it has even returned. So after subscribing, the job's current state is
// fetched once as well.

import { api, on, type Job } from "./api";
import { follow } from "./order";

/** Call `cb` with the job's state now and on every change. Returns the unsubscribe. */
export function watchJob(id: string, cb: (j: Job) => void): () => void {
  return follow((fn) => on("job:update", (j: Job) => { if (j.id === id) fn(j); }),
    () => api.jobs().then((all) => all.find((x) => x.id === id)), cb);
}

/** Resolve with the job once it is done; reject when it fails or is cancelled. */
export function waitForJob(jobId: string, onUpdate?: (j: Job) => void): Promise<Job> {
  return new Promise((resolve, reject) => {
    const off = watchJob(jobId, (j) => {
      if (onUpdate) onUpdate(j);
      if (j.state === "done") { off(); resolve(j); }
      else if (j.state === "failed" || j.state === "cancelled") {
        off();
        reject(new Error(j.state === "cancelled" ? "cancelled" : j.error || "the job failed"));
      }
    });
  });
}
