import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { createRenameActions, commandStore } from "../client/commands";
import { retitleChat, titleJobStatus } from "../shared/rpc";
import type { RetitleResult } from "../shared/types";
import { createJobs } from "./jobs";

afterEach(() => vi.useRealTimers());
const result = (id: string): RetitleResult => ({ agentId: id, status: "renamed", title: `Title ${id}`, at: new Date(0).toISOString(), chat: { status: "renamed" }, workspace: { status: "renamed" } });

function connect(jobs: ReturnType<typeof createJobs>, run: (agentId: string) => Promise<RetitleResult>) {
  const paseo = {};
  const rpc = vi.fn(async (contract, input) => {
    const parsed = contract.input.parse(input);
    const response = contract.name === retitleChat.name ? jobs.startRetitle(parsed.agentId, () => run(parsed.agentId))
      : contract.name === titleJobStatus.name ? jobs.status(parsed.jobId) : undefined;
    return contract.output.parse(JSON.parse(JSON.stringify(response)));
  });
  return { paseo, rpc, actions: createRenameActions({ paseo, rpc } as unknown as PluginClientContext) };
}

describe("coordinator: serialized jobs through actual client observers and wire schemas", () => {
  it("keeps two caller identities pending beyond 30 seconds and reports each actual target outcome", async () => {
    vi.useFakeTimers(); const jobs = createJobs(); let release!: (r: RetitleResult) => void;
    const work = new Promise<RetitleResult>((resolve) => { release = resolve; });
    const run = vi.fn((id: string) => id === "a" ? work : Promise.resolve({ ...result(id), workspace: { status: "failed" as const, detail: "Workspace denied" } }));
    const h = connect(jobs, run);
    let firstDone = false;
    const a = h.actions.rename("a").then(() => { firstDone = true; });
    const b = h.actions.rename("b"); const bFailure = expect(b).rejects.toThrow("Workspace: failed (Workspace denied)");
    await vi.advanceTimersByTimeAsync(40_001);
    expect(firstDone).toBe(false); expect(run).toHaveBeenCalledTimes(1);
    expect(commandStore(h.paseo).forAgent("a")?.pending).toBe(true); expect(commandStore(h.paseo).forAgent("b")?.pending).toBe(true);
    release(result("a")); await vi.advanceTimersByTimeAsync(2500); await a; await bFailure;
    expect(commandStore(h.paseo).forAgent("a")).toMatchObject({ pending: false, message: expect.stringContaining("Title a") });
    expect(commandStore(h.paseo).forAgent("b")).toMatchObject({ pending: false, message: expect.stringContaining("Workspace denied") });
    h.actions.dispose(); jobs.stop(); await jobs.idle(); expect(vi.getTimerCount()).toBe(0);
  });
  it("never reports a cancelled job as success even if a pre-abort write result was retained", async () => {
    vi.useFakeTimers(); const jobs = createJobs(); let release!: (r: RetitleResult) => void;
    const h = connect(jobs, () => new Promise((resolve) => { release = resolve; }));
    const waiting = h.actions.rename("a"); const failure = expect(waiting).rejects.toThrow("plugin stopped");
    await vi.advanceTimersByTimeAsync(10); jobs.stop(); release(result("a"));
    await vi.advanceTimersByTimeAsync(2500); await failure;
    expect(commandStore(h.paseo).forAgent("a")).toMatchObject({ pending: false, message: expect.stringContaining("Check Recent outcomes") });
    h.actions.dispose(); await jobs.idle(); expect(vi.getTimerCount()).toBe(0);
  });
});
