// Every slow thing in one list: downloads, setups, generations — with logs,
// cancel, and the file each one made.

import { api, type Job } from "../lib/api";
import { EmptyState, JobStatus, Panel, ViewHead } from "../ui/kit";

export function Jobs({ jobs }: { jobs: Job[] }) {
  return (
    <div className="page">
      <ViewHead index="07" label="jobs" title="Jobs">
        Downloads, setups and generations from this session. They keep running when you switch screens.
      </ViewHead>
      {jobs.length === 0 && (
        <EmptyState seed="no-jobs" title="Nothing running">
          Generate something in the Studio or download a model, and it shows up here with its progress and log.
        </EmptyState>
      )}
      <div className="col" style={{ gap: 12 }}>
        {jobs.map((j) => (
          <Panel key={j.id} title={`${j.kind} · ${j.id}`} right={
            <div className="row">
              {j.state === "running" && <button className="btn sm danger" onClick={() => api.cancelJob(j.id)}>cancel</button>}
              {j.result?.file && (
                <>
                  <button className="btn sm" onClick={() => api.reveal(String(j.result!.file))}>reveal</button>
                  <button className="btn sm" onClick={() => api.saveAs(String(j.result!.file))}>save as…</button>
                </>
              )}
            </div>
          }>
            <JobStatus job={j} />
            {j.result?.file && <div className="mono dim" style={{ fontSize: 12, marginTop: 6 }}>{String(j.result.file)}</div>}
            {j.log.length > 0 && <div className="log" style={{ marginTop: 8 }}>{j.log.slice(-30).join("\n")}</div>}
          </Panel>
        ))}
      </div>
    </div>
  );
}
