import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobSnapshot, JobStatus } from "../shared/jobs";
import { observeJob } from "./jobs";
import { commandStore, createRenameActions } from "./commands";
import type { PluginClientContext } from "@getpaseo/plugin/client";

afterEach(() => vi.useRealTimers());
const sample = { jobId: "mine", kind: "sample" as const };
const times = { createdAt: "2026-11-13T00:00:00Z", updatedAt: "2026-11-13T00:00:00Z" };
const terminal: JobSnapshot = { ...sample, ...times, expiresAt: "2026-11-13T00:15:00Z", state: "succeeded", result: { title: "Sample title", model: "p/m", ms: 40_000 } };
const response = (job: JobSnapshot): JobStatus => ({ found: true, job });
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe("owned job observation", () => {
  it("validates the start acknowledgement against the caller's actual intent, not just its generic type", async () => {
    const status = vi.fn();
    await expect(observeJob<"sample">(async () => ({ jobId: "wrong", kind: "retitle", agentId: "a" } as any), status, { kind: "sample", signal: new AbortController().signal })).rejects.toThrow("acknowledged a different");
    await expect(observeJob<"retitle">(async () => ({ jobId: "wrong", kind: "retitle", agentId: "b" }), status, { kind: "retitle", agentId: "a", signal: new AbortController().signal })).rejects.toThrow("acknowledged a different");
    expect(status).not.toHaveBeenCalled();
  });
  it("does not accept a missing-job report for another caller", async () => {
    await expect(observeJob<"sample">(async () => sample, async () => ({ found: false, jobId: "other", error: "Missing" }), { signal: new AbortController().signal, kind: "sample" })).rejects.toThrow("different title job");
  });
  it("explains that a status transport failure does not prove remote cancellation", async () => {
    await expect(observeJob<"sample">(async () => sample, async () => { throw new Error("Disconnected"); }, { signal: new AbortController().signal, kind: "sample" })).rejects.toThrow("may still finish on the host");
  });
  it("does not treat an acknowledgement or queued/running status as a result, even after the old deadline", async () => {
    vi.useFakeTimers(); const controller = new AbortController();
    let job: JobSnapshot = { ...sample, ...times, state: "queued" };
    const status = vi.fn(async () => response(job)); let finished = false;
    const waiting = observeJob<"sample">(async () => sample, status, { signal: controller.signal, kind: "sample" }).then((value) => { finished = true; return value; });
    await vi.advanceTimersByTimeAsync(15_000); expect(finished).toBe(false);
    job = { ...sample, ...times, state: "running" };
    await vi.advanceTimersByTimeAsync(20_001); expect(finished).toBe(false);
    job = terminal;
    await vi.advanceTimersByTimeAsync(2500); expect((await waiting).state).toBe("succeeded");
    expect(status.mock.calls.length).toBeLessThan(25);
    expect(status).toHaveBeenCalledWith({ jobId: "mine" });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("returns an honest terminal failure for the caller to display", async () => {
    const failed: JobSnapshot = { ...sample, ...times, expiresAt: "later", state: "failed", error: "Quota exhausted" };
    expect(await observeJob<"sample">(async () => sample, async () => response(failed), { signal: new AbortController().signal, kind: "sample" })).toEqual(failed);
  });
  it("reports plugin restart or expiration without starting another generation", async () => {
    const start = vi.fn(async () => sample);
    await expect(observeJob<"sample">(start, async () => ({ found: false, jobId: "mine", error: "Plugin restarted: check outcomes" }), { signal: new AbortController().signal, kind: "sample" })).rejects.toThrow("Plugin restarted");
    expect(start).toHaveBeenCalledTimes(1);
  });
  it.each([
    { ...terminal, jobId: "someone-else" },
    { jobId: "mine", kind: "retitle", agentId: "a", ...times, state: "running" },
  ] as JobSnapshot[])("rejects a mismatched result identity %#", async (job) => {
    await expect(observeJob<"sample">(async () => sample, async () => response(job), { signal: new AbortController().signal, kind: "sample" })).rejects.toThrow("different title job");
  });
  it("rejects a retitle for another chat even when its job ID matches", async () => {
    await expect(observeJob<"retitle">(async () => ({ jobId: "mine", kind: "retitle", agentId: "a" }), async () => response({ jobId: "mine", kind: "retitle", agentId: "b", ...times, state: "running" }), { signal: new AbortController().signal, kind: "retitle", agentId: "a" })).rejects.toThrow("different title job");
  });
  it("cancels the delay and removes polling timers on disposal", async () => {
    vi.useFakeTimers(); const controller = new AbortController();
    const status = vi.fn(async () => response({ ...sample, ...times, state: "running" }));
    const waiting = observeJob<"sample">(async () => sample, status, { signal: controller.signal, kind: "sample" });
    const failure = expect(waiting).rejects.toThrow("may still finish");
    await tick(); controller.abort(); await failure;
    await vi.advanceTimersByTimeAsync(20_000); expect(status).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it("stops waiting during an unresponsive start and consumes a late rejection", async () => {
    const controller = new AbortController(); let reject!: (e: Error) => void;
    const start = new Promise<typeof sample>((_, fail) => { reject = fail; });
    const status = vi.fn(); const waiting = observeJob<"sample">(() => start, status, { signal: controller.signal, kind: "sample" });
    const failure = expect(waiting).rejects.toThrow("Stopped waiting"); controller.abort(); await failure;
    reject(new Error("Late transport rejection")); await tick(); expect(status).not.toHaveBeenCalled();
  });
  it("stops waiting during an unresponsive status without leaking a timer", async () => {
    vi.useFakeTimers(); const controller = new AbortController();
    const waiting = observeJob<"sample">(async () => sample, () => new Promise(() => {}), { signal: controller.signal, kind: "sample" });
    const failure = expect(waiting).rejects.toThrow("Stopped waiting"); await tick(); controller.abort(); await failure; expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds total observation, even when a status call never resolves", async () => {
    vi.useFakeTimers(); const waiting = observeJob<"sample">(async () => sample, () => new Promise(() => {}), { signal: new AbortController().signal, kind: "sample", timeoutMs: 1000 });
    const failure = expect(waiting).rejects.toThrow("taking longer"); await vi.advanceTimersByTimeAsync(1001); await failure; expect(vi.getTimerCount()).toBe(0);
  });
  it("does not submit after the owner has already stopped", async () => {
    const controller = new AbortController(); controller.abort(); const start = vi.fn();
    await expect(observeJob<"sample">(start, vi.fn(), { signal: controller.signal, kind: "sample" })).rejects.toThrow("Stopped waiting"); expect(start).not.toHaveBeenCalled();
  });
  it("shares duplicate protection across tool/command actions and clears state on shutdown", async () => {
    vi.useFakeTimers(); const paseo = {};
    const rpc = vi.fn(async (contract) => contract.name === "chat-title.retitle" ? { jobId: "mine", kind: "retitle", agentId: "a" } : response({ jobId: "mine", kind: "retitle", agentId: "a", ...times, state: "running" }));
    const actions = createRenameActions({ paseo, rpc } as unknown as PluginClientContext);
    const waiting = actions.rename("a"); const failure = expect(waiting).rejects.toThrow("Stopped waiting");
    await tick(); await expect(actions.rename("a")).rejects.toThrow("already running");
    expect(commandStore(paseo).forAgent("a")?.pending).toBe(true);
    actions.dispose(); actions.dispose(); await failure; expect(commandStore(paseo).snapshot()).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
    await expect(actions.rename("b")).rejects.toThrow("no longer active");
  });
});
