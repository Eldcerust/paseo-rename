import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "../index.server";
import { retitleChat, titleJobStatus, titleTest } from "../shared/rpc";
import { settingsFallback } from "../shared/settings";
import { createJobs, JOB_RETENTION_MS } from "./jobs";
import type { RetitleResult } from "../shared/types";

const fake = vi.hoisted(() => ({ retitle: vi.fn(), test: vi.fn(), stop: vi.fn(), idle: vi.fn() }));
vi.mock("./retitle", () => ({ createRetitler: () => ({ retitle: fake.retitle, test: fake.test }) }));
vi.mock("./auto", () => ({ createAuto: () => ({ stop: fake.stop, idle: fake.idle }) }));
vi.mock("./state", () => ({ createStateStore: () => ({}), statePath: () => "unused" }));
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

describe("entry RPC deadline regression", () => {
  it.each(["retitle", "sample"] as const)("acknowledges %s before a simulated 30-second host deadline while generation is still pending", async (kind) => {
    vi.useFakeTimers();
    let release!: (result: any) => void;
    const generation = new Promise<any>((resolve) => { release = resolve; });
    (kind === "retitle" ? fake.retitle : fake.test).mockReturnValueOnce(generation);
    const handlers = new Map<string, (input: any, context: any) => any>();
    const server = {
      registerSettings: () => ({ read: async () => ({ status: "ready", values: settingsFallback }) }),
      handle: (contract: { name: string }, handler: any) => handlers.set(contract.name, handler),
      addHook: () => () => {},
    };
    const cleanup = contribute(server as unknown as PluginServerContext);
    let acknowledged = false; let ack: any;
    const request = handlers.get(kind === "retitle" ? retitleChat.name : titleTest.name)!(kind === "retitle" ? { agentId: "slow-chat", force: true } : {}, { paseo: {} }).then((value: any) => { acknowledged = true; ack = value; });
    await vi.advanceTimersByTimeAsync(30_001);
    const acknowledgedBeforeDeadline = acknowledged;
    const pendingStatus = ack ? await handlers.get(titleJobStatus.name)!({ jobId: ack.jobId }, { paseo: {} }) : undefined;
    release(kind === "retitle" ? { agentId: "slow-chat", status: "unchanged", at: new Date().toISOString() } : { title: "Slow sample", model: "provider/model", ms: 30_001 });
    await request; await cleanup();
    expect(acknowledgedBeforeDeadline, "A generation held beyond the daemon's fixed RPC deadline must already have a job acknowledgement").toBe(true);
    expect(ack).toMatchObject({ kind, jobId: expect.any(String) });
    expect(pendingStatus).toMatchObject({ found: true, job: { ...ack, state: "running" } });
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const outcome = (agentId = "a"): RetitleResult => ({ agentId, status: "renamed", title: "Own job title", chat: { status: "renamed" }, at: new Date(0).toISOString() });
const sample = { title: "Sample title", model: "provider/model", ms: 100 };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("owned title jobs", () => {
  it("owns queued work before acknowledgement and exposes running then terminal snapshots", async () => {
    const jobs = createJobs(); const work = deferred<RetitleResult>(); const run = vi.fn(() => work.promise);
    const ack = jobs.startRetitle("a", run);
    expect(jobs.status(ack.jobId)).toMatchObject({ found: true, job: { ...ack, state: "queued" } });
    expect(run).not.toHaveBeenCalled();
    await tick(); expect(jobs.status(ack.jobId)).toMatchObject({ job: { state: "running" } });
    let drained = false; const idle = jobs.idle().then(() => { drained = true; }); await tick(); expect(drained).toBe(false);
    work.resolve(outcome()); await idle;
    expect(jobs.status(ack.jobId)).toMatchObject({ job: { ...ack, state: "succeeded", result: outcome(), expiresAt: expect.any(String) } });
  });
  it("executes FIFO once, isolating queued samples and different chats by unique request IDs", async () => {
    const jobs = createJobs(); const work = deferred<RetitleResult>(); const order: string[] = [];
    const a = jobs.startRetitle("a", () => { order.push("a"); return work.promise; });
    const b = jobs.startSample(async () => { order.push("sample"); return sample; });
    const c = jobs.startRetitle("c", async () => { order.push("c"); return outcome("c"); });
    expect(new Set([a.jobId, b.jobId, c.jobId]).size).toBe(3);
    await tick(); expect(order).toEqual(["a"]); expect(jobs.status(b.jobId)).toMatchObject({ job: { state: "queued", kind: "sample" } });
    work.resolve(outcome()); await jobs.idle(); expect(order).toEqual(["a", "sample", "c"]);
    expect(jobs.status(b.jobId)).toMatchObject({ job: { ...b, state: "succeeded", result: sample } });
    expect(jobs.status(c.jobId)).toMatchObject({ job: { ...c, result: outcome("c") } });
    expect(jobs.status(a.jobId)).toMatchObject({ job: { result: outcome() } });
  });
  it("rejects active duplicates, then admits a fresh request with a distinct ID after completion", async () => {
    const jobs = createJobs(); const work = deferred<RetitleResult>();
    const a = jobs.startRetitle("a", () => work.promise);
    expect(() => jobs.startRetitle("a", async () => outcome())).toThrow("already running");
    await tick(); expect(() => jobs.startRetitle("a", async () => outcome())).toThrow(a.jobId);
    work.resolve(outcome()); await jobs.idle();
    const b = jobs.startRetitle("a", async () => outcome()); expect(b.jobId).not.toBe(a.jobId); await jobs.idle();
    expect(jobs.status(a.jobId).found).toBe(true);
  });
  it("retains thrown errors and continues draining later jobs without unhandled rejection", async () => {
    const jobs = createJobs();
    const a = jobs.startSample(() => { throw new Error("Provider quota exhausted"); });
    const b = jobs.startSample(async () => sample); await jobs.idle();
    expect(jobs.status(a.jobId)).toMatchObject({ job: { state: "failed", error: "Provider quota exhausted" } });
    expect(jobs.status(b.jobId)).toMatchObject({ job: { state: "succeeded", result: sample } });
  });
  it("preserves an asynchronous provider rejection through shutdown and drains its owned promise", async () => {
    const jobs = createJobs(); const work = deferred<typeof sample>();
    const ack = jobs.startSample(() => work.promise); await tick(); jobs.stop();
    let exited = false; const drain = jobs.idle().then(() => { exited = true; }); await tick(); expect(exited).toBe(false);
    work.reject(new Error("Provider rejected after abort")); await drain;
    expect(jobs.status(ack.jobId)).toMatchObject({ job: { state: "failed", error: expect.stringContaining("stopped") } });
  });
  it("starts terminal retention at completion, not at admission after a long queue wait", async () => {
    let now = 0; const jobs = createJobs({ now: () => now, retentionMs: 100 }); const work = deferred<RetitleResult>();
    jobs.startRetitle("a", () => work.promise); const ack = jobs.startSample(async () => sample); await tick();
    now = 10_000; work.resolve(outcome()); await jobs.idle();
    now = 10_099; expect(jobs.status(ack.jobId)).toMatchObject({ job: { state: "succeeded", result: sample } });
    now = 10_100; expect(jobs.status(ack.jobId).found).toBe(false);
  });
  it("keeps full model-failure and partial-target outcomes for the terminal formatter", async () => {
    const jobs = createJobs(); const failed = { ...outcome(), status: "failed" as const, reason: "No model", chat: { status: "failed" as const, detail: "CLI refused" } };
    const a = jobs.startRetitle("a", async () => failed);
    const partial = { ...outcome("b"), workspace: { status: "failed" as const, detail: "Read-only workspace" } };
    const b = jobs.startRetitle("b", async () => partial); await jobs.idle();
    expect(jobs.status(a.jobId)).toMatchObject({ job: { state: "failed", error: "No model", result: failed } });
    expect(jobs.status(b.jobId)).toMatchObject({ job: { state: "succeeded", result: partial } });
  });
  it("reports unknown, expired and restarted job identities without starting work", async () => {
    let now = 0; const jobs = createJobs({ now: () => now }); const run = vi.fn(async () => sample);
    expect(jobs.status("missing")).toMatchObject({ found: false, jobId: "missing", error: expect.stringContaining("restarted") });
    const ack = jobs.startSample(run); await jobs.idle();
    expect(createJobs().status(ack.jobId).found).toBe(false);
    now = JOB_RETENTION_MS - 1; expect(jobs.status(ack.jobId).found).toBe(true);
    now++; expect(jobs.status(ack.jobId)).toMatchObject({ found: false, jobId: ack.jobId }); expect(run).toHaveBeenCalledTimes(1);
  });
  it("bounds pending admission without evicting active or queued jobs, even past terminal TTL", async () => {
    let now = 0; const jobs = createJobs({ now: () => now, maxPending: 2 }); const work = deferred<RetitleResult>();
    const a = jobs.startRetitle("a", () => work.promise); const b = jobs.startSample(async () => sample);
    expect(() => jobs.startSample(async () => sample)).toThrow("Too many");
    now = JOB_RETENTION_MS * 2; await tick();
    expect(jobs.status(a.jobId)).toMatchObject({ job: { state: "running" } }); expect(jobs.status(b.jobId)).toMatchObject({ job: { state: "queued" } });
    work.resolve(outcome()); await jobs.idle(); const c = jobs.startSample(async () => sample); await jobs.idle(); expect(jobs.status(c.jobId).found).toBe(true);
  });
  it("rejects history pressure instead of silently deleting unexpired errors, reclaiming only expired results", async () => {
    let now = 0; const jobs = createJobs({ maxJobs: 1, retentionMs: 100, now: () => now });
    const a = jobs.startSample(async () => { throw new Error("Important provider error"); }); await jobs.idle();
    expect(() => jobs.startSample(async () => sample)).toThrow("history is full");
    expect(jobs.status(a.jobId)).toMatchObject({ job: { error: "Important provider error" } });
    now = 100; const b = jobs.startSample(async () => sample); await jobs.idle();
    expect(jobs.status(a.jobId).found).toBe(false); expect(jobs.status(b.jobId).found).toBe(true);
  });
  it("stop cancels queued jobs without running them and waits for active abort cleanup", async () => {
    const jobs = createJobs(); const work = deferred<RetitleResult>(); const queued = vi.fn(async () => sample); let signal!: AbortSignal;
    const a = jobs.startRetitle("a", (s) => { signal = s; return work.promise; }); const b = jobs.startSample(queued);
    await tick(); jobs.stop(); jobs.stop(); expect(signal.aborted).toBe(true);
    expect(jobs.status(b.jobId)).toMatchObject({ job: { state: "failed", error: expect.stringContaining("stopped") } });
    expect(() => jobs.startSample(queued)).toThrow("stopping");
    let exited = false; const idle = jobs.idle().then(() => { exited = true; }); await tick(); expect(exited).toBe(false);
    const result = { ...outcome(), status: "skipped" as const, reason: "The rename was cancelled." }; work.resolve(result); await idle;
    expect(jobs.status(a.jobId)).toMatchObject({ job: { state: "failed", result, error: expect.stringContaining("stopped") } }); expect(queued).not.toHaveBeenCalled();
  });
  it("stop before the pump runs terminalizes and drains all acknowledged work without invoking callbacks", async () => {
    const jobs = createJobs(); const run = vi.fn(async () => sample); const ack = jobs.startSample(run);
    jobs.stop(); await jobs.idle(); expect(run).not.toHaveBeenCalled(); expect(jobs.status(ack.jobId)).toMatchObject({ job: { state: "failed" } });
  });
  it.each([undefined, { title: "Wrong shape" }, { ...outcome("other") }])("captures malformed/wrong-chat execution results as observable terminal errors: %j", async (value) => {
    const jobs = createJobs(); const ack = jobs.startRetitle("a", async () => value as RetitleResult); await jobs.idle();
    expect(jobs.status(ack.jobId)).toMatchObject({ job: { state: "failed", error: expect.any(String) } });
  });
  it("rejects malformed identity before registering ownership and never overwrites a retained request ID", async () => {
    const jobs = createJobs({ id: () => "fixed" });
    expect(() => jobs.startRetitle("", async () => outcome())).toThrow(); await jobs.idle();
    const a = jobs.startSample(async () => sample); await jobs.idle();
    expect(() => jobs.startSample(async () => sample)).toThrow("unique"); expect(jobs.status(a.jobId)).toMatchObject({ job: { result: sample } });
  });
  it("returns detached snapshots so a status consumer cannot mutate retained outcomes", async () => {
    const jobs = createJobs(); const ack = jobs.startRetitle("a", async () => outcome()); await jobs.idle();
    const status = jobs.status(ack.jobId); if (status.found && status.job.kind === "retitle" && status.job.state === "succeeded") status.job.result.chat!.status = "failed";
    expect(jobs.status(ack.jobId)).toMatchObject({ job: { result: { chat: { status: "renamed" } } } });
  });
});
