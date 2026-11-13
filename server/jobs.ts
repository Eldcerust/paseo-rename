import { randomUUID } from "node:crypto";
import { jobAckSchema, jobSnapshotSchema, sampleResultSchema, type JobAck, type JobSnapshot, type JobStatus, type SampleResult } from "../shared/jobs";
import { retitleResultSchema, type RetitleResult } from "../shared/types";

export const JOB_RETENTION_MS = 15 * 60_000;
export const MAX_JOBS = 100;
export const MAX_PENDING_JOBS = 20;
const cancelled = "The plugin stopped before this title job completed. Check Recent outcomes before retrying.";
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
type Run = (signal: AbortSignal) => Promise<RetitleResult | SampleResult>;
interface OwnedJob { snapshot: JobSnapshot; run?: Run; settle(): void }

/** FIFO, in-memory request ownership; terminal data is never pressure-evicted before its TTL. */
export function createJobs({ now = Date.now, id = randomUUID, maxJobs = MAX_JOBS, maxPending = MAX_PENDING_JOBS, retentionMs = JOB_RETENTION_MS }: {
  now?: () => number; id?: () => string; maxJobs?: number; maxPending?: number; retentionMs?: number;
} = {}) {
  for (const value of [maxJobs, maxPending, retentionMs]) if (!Number.isSafeInteger(value) || value < 1) throw new Error("Job limits must be positive whole numbers.");
  const lifetime = new AbortController();
  const records = new Map<string, OwnedJob>();
  const pending = new Set<Promise<void>>();
  const activeChats = new Map<string, string>();
  const queue: OwnedJob[] = [];
  let running = false;
  let stopped = false;
  const at = () => new Date(now()).toISOString();
  const prune = () => {
    for (const [key, record] of records) if ("expiresAt" in record.snapshot && Date.parse(record.snapshot.expiresAt) <= now()) records.delete(key);
  };
  const complete = (record: OwnedJob, data: object) => {
    record.snapshot = jobSnapshotSchema.parse({ ...record.snapshot, ...data, updatedAt: at(), expiresAt: new Date(now() + retentionMs).toISOString() });
    record.run = undefined; // Retain the outcome, not the SDK/request closure, for the history TTL.
    if (record.snapshot.kind === "retitle") activeChats.delete(record.snapshot.agentId);
    record.settle();
  };
  async function pump() {
    if (running || stopped) return;
    const record = queue.shift();
    if (!record) return;
    running = true;
    record.snapshot = { ...record.snapshot, state: "running", updatedAt: at() } as JobSnapshot;
    try {
      const value = await record.run!(lifetime.signal);
      if (record.snapshot.kind === "retitle") {
        const result = retitleResultSchema.parse(value);
        if (result.agentId !== record.snapshot.agentId) throw new Error("The title job returned a result for a different chat.");
        if (lifetime.signal.aborted) complete(record, { state: "failed", error: cancelled, result });
        else if (result.status === "failed") complete(record, { state: "failed", result, error: result.reason || "The rename failed." });
        else complete(record, { state: "succeeded", result });
      } else {
        const result = sampleResultSchema.parse(value);
        complete(record, lifetime.signal.aborted ? { state: "failed", error: cancelled } : { state: "succeeded", result });
      }
    } catch (error) {
      complete(record, { state: "failed", error: lifetime.signal.aborted ? cancelled : message(error) || "The title job failed." });
    } finally {
      running = false;
      void pump();
    }
  }
  function start(ack: Omit<Extract<JobAck, { kind: "retitle" }>, "jobId"> | Omit<Extract<JobAck, { kind: "sample" }>, "jobId">, run: Run): JobAck {
    if (stopped) throw new Error("Chat titles is stopping. Try again after the plugin is active.");
    if (ack.kind === "retitle" && activeChats.has(ack.agentId)) throw new Error(`A rename of this chat is already running (job ${activeChats.get(ack.agentId)}). Check its current outcome before retrying.`);
    prune();
    if (pending.size >= maxPending) throw new Error("Too many title jobs are pending. Wait for an existing job to finish before retrying.");
    if (records.size >= maxJobs) throw new Error("Title job history is full. Results are retained until expiry; wait before starting another job.");
    const jobId = id();
    if (!jobId || records.has(jobId)) throw new Error("Could not allocate a unique title job ID.");
    const identity = jobAckSchema.parse({ ...ack, jobId });
    const snapshot = jobSnapshotSchema.parse({ ...identity, state: "queued", createdAt: at(), updatedAt: at() });
    let settle!: () => void;
    const owned = new Promise<void>((resolve) => { settle = resolve; });
    pending.add(owned);
    owned.then(() => pending.delete(owned));
    const record: OwnedJob = { snapshot, run, settle };
    records.set(jobId, record);
    if (identity.kind === "retitle") activeChats.set(identity.agentId, jobId);
    queue.push(record);
    // Ownership and completion promise exist before the caller receives this acknowledgement.
    queueMicrotask(() => { void pump(); });
    return identity;
  }
  return {
    startRetitle(agentId: string, run: (signal: AbortSignal) => Promise<RetitleResult>) { return start({ kind: "retitle", agentId }, run) as Extract<JobAck, { kind: "retitle" }>; },
    startSample(run: (signal: AbortSignal) => Promise<SampleResult>) { return start({ kind: "sample" }, run) as Extract<JobAck, { kind: "sample" }>; },
    status(jobId: string): JobStatus {
      prune();
      const record = records.get(jobId);
      return record ? { found: true, job: jobSnapshotSchema.parse(record.snapshot) } : { found: false, jobId, error: "This title job is unknown or expired, or the plugin restarted. Check Recent outcomes before starting another rename." };
    },
    stop() {
      if (stopped) return;
      stopped = true;
      lifetime.abort();
      for (const record of queue.splice(0)) complete(record, { state: "failed", error: cancelled });
    },
    async idle() { await Promise.all([...pending]); },
  };
}
