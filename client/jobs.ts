import { jobAckSchema, type JobAck, type JobSnapshot, type JobStatus } from "../shared/jobs";

export const JOB_WAIT_MS = 35 * 60_000; // Twenty serialized 90-second helpers plus cleanup margin.
export const observationStopped = "Stopped waiting for the title job. It may still finish on the host; check Recent outcomes before retrying.";

/** Stop observing promptly, even when an already-sent IPC request cannot be cancelled. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason ?? new Error(observationStopped)); };
    const done = () => signal.removeEventListener("abort", abort);
    promise.then((value) => { done(); resolve(value); }, (error) => { done(); reject(error); });
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

async function remote<T>(promise: Promise<T>, signal: AbortSignal, recovery: string): Promise<T> {
  try { return await abortable(promise, signal); }
  catch (error) {
    if (signal.aborted) throw error;
    throw new Error(`${error instanceof Error ? error.message : String(error)}. The title job may still finish on the host; ${recovery}`);
  }
}

/** Poll only this acknowledgement, never the latest result for a chat or another caller. */
export async function observeJob<K extends JobAck["kind"]>(
  start: () => Promise<Extract<JobAck, { kind: K }>>,
  status: (input: { jobId: string }) => Promise<JobStatus>,
  { signal, kind, agentId, timeoutMs = JOB_WAIT_MS }: { signal: AbortSignal; kind: K; agentId?: string; timeoutMs?: number },
): Promise<Extract<JobSnapshot, { kind: K; state: "succeeded" | "failed" }>> {
  const lifetime = new AbortController();
  const recovery = kind === "sample" ? "wait for pending jobs to finish before testing the model again. Sample results are not saved as rename outcomes." : "check Recent outcomes before retrying.";
  const stop = () => lifetime.abort(new Error(`Stopped waiting for the title job. It may still finish on the host; ${recovery}`));
  const timer = setTimeout(() => lifetime.abort(new Error(`The title job is taking longer than expected. It may still finish on the host; ${recovery}`)), timeoutMs);
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  try {
    lifetime.signal.throwIfAborted();
    const ack: JobAck = jobAckSchema.parse(await remote(start(), lifetime.signal, recovery));
    lifetime.signal.throwIfAborted();
    if (ack.kind !== kind || (ack.kind === "retitle" && ack.agentId !== agentId)) throw new Error("The host acknowledged a different title job. Check Recent outcomes before retrying.");
    let interval = 500;
    while (true) {
      lifetime.signal.throwIfAborted();
      const current = await remote(status({ jobId: ack.jobId }), lifetime.signal, recovery);
      lifetime.signal.throwIfAborted();
      if (!current.found) {
        if (current.jobId !== ack.jobId) throw new Error("The host returned a different title job. Check Recent outcomes before retrying.");
        throw new Error(kind === "sample" ? current.error.replace(/check Recent outcomes before (starting another rename|retrying)\./i, recovery) : current.error);
      }
      const job = current.job;
      if (job.jobId !== ack.jobId || job.kind !== ack.kind || (ack.kind === "retitle" && job.kind === "retitle" && ack.agentId !== job.agentId)) throw new Error("The host returned a different title job. Check Recent outcomes before retrying.");
      if (job.state === "succeeded" || job.state === "failed") return job as Extract<JobSnapshot, { kind: K; state: "succeeded" | "failed" }>;
      await delay(interval, lifetime.signal);
      interval = Math.min(2500, interval * 1.5);
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
  }
}
