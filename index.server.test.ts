import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "./index.server";
import { settingsFallback } from "./shared/settings";
import { retitleChat, setTitleChatAuto, titleChatAuto, titleJobStatus, titleModels, titleOverview, titleProviders, titleTest } from "./shared/rpc";

const f = vi.hoisted(() => ({ retitle: vi.fn(), overview: vi.fn(), test: vi.fn(), providers: vi.fn(), models: vi.fn(), onTurnEnded: vi.fn(), stop: vi.fn(), idle: vi.fn(), chatAuto: vi.fn(), setChatAuto: vi.fn(), settings: undefined as undefined | (() => Promise<unknown>) }));
vi.mock("./server/retitle", () => ({ createRetitler: (deps: { settings: () => Promise<unknown> }) => { f.settings = deps.settings; return { ...f, catalog: () => ({ providers: f.providers, models: f.models }) }; } }));
vi.mock("./server/auto", () => ({ createAuto: () => f }));
vi.mock("./server/state", () => ({ createStateStore: () => ({ chatAuto: f.chatAuto, setChatAuto: f.setChatAuto }), statePath: () => "not-used" }));
beforeEach(() => vi.resetAllMocks());
const result = { agentId: "chat", status: "unchanged", at: new Date(0).toISOString() };
const sampleResult = { title: "Sample title", model: "provider/model", ms: 10 };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup(ready = true) {
  const handlers = new Map<string, (input: any, context: any) => any>();
  let hook: any;
  const unhook = vi.fn();
  const server = {
    registerSettings: vi.fn(() => ({ read: async () => ready ? { status: "ready", values: settingsFallback } : { status: "invalid", error: "bad document" } })),
    handle: (contract: { name: string }, handler: any) => { handlers.set(contract.name, handler); },
    addHook: vi.fn((name, handler) => { hook = handler; return unhook; }),
  };
  const cleanup = contribute(server as unknown as PluginServerContext);
  return { server, handlers, cleanup, unhook, hook };
}

describe("server entry", () => {
  it("registers the shared settings and every RPC", async () => {
    const w = setup(); expect(w.handlers.size).toBe(8); expect(await f.settings!()).toEqual(settingsFallback);
    const paseo = {}; f.retitle.mockResolvedValue(result); f.test.mockResolvedValue(sampleResult);
    const rename = await w.handlers.get(retitleChat.name)!({ agentId: "chat", force: true }, { paseo });
    expect(rename).toMatchObject({ kind: "retitle", agentId: "chat", jobId: expect.any(String) });
    expect(f.retitle).toHaveBeenCalledWith(paseo, { agentId: "chat", force: true, source: "manual", signal: expect.any(AbortSignal) });
    f.providers.mockResolvedValue(["a"]); f.models.mockResolvedValue(["m"]);
    expect(await w.handlers.get(titleProviders.name)!({}, { paseo })).toEqual({ providers: ["a"] });
    expect(await w.handlers.get(titleModels.name)!({ provider: "p" }, { paseo })).toEqual({ models: ["m"] }); expect(f.models).toHaveBeenCalledWith("p");
    await w.handlers.get(titleOverview.name)!({}, { paseo }); expect(f.overview).toHaveBeenCalledWith(paseo);
    const sample = await w.handlers.get(titleTest.name)!({}, { paseo }); await tick();
    expect(sample).toMatchObject({ kind: "sample", jobId: expect.any(String) }); expect(sample.jobId).not.toBe(rename.jobId);
    expect(f.test).toHaveBeenCalledWith(paseo, { signal: expect.any(AbortSignal) });
    expect(await w.handlers.get(titleJobStatus.name)!({ jobId: rename.jobId }, {})).toMatchObject({ found: true, job: { ...rename, state: "succeeded", result } });
    expect(await w.handlers.get(titleJobStatus.name)!({ jobId: sample.jobId }, {})).toMatchObject({ found: true, job: { ...sample, state: "succeeded", result: sampleResult } });
    await w.cleanup();
  });
  it("wires the modern completed-turn hook and releases it on teardown", async () => {
    const w = setup(); const event = { outcome: { kind: "completed" } }; const paseo = {};
    expect(w.server.addHook).toHaveBeenCalledWith("agent.turn.after", expect.any(Function));
    await w.hook(event, { paseo }); expect(f.onTurnEnded).toHaveBeenCalledWith(event, paseo);
    await w.cleanup!(); expect(w.unhook).toHaveBeenCalledTimes(1); expect(f.stop).toHaveBeenCalledTimes(1); expect(f.idle).toHaveBeenCalledTimes(1);
  });
  it("reads a chat switch together with the host master switch and interval", async () => {
    const w = setup(); f.chatAuto.mockResolvedValue(true);
    expect(await w.handlers.get(titleChatAuto.name)!({ agentId: "chat" }, {})).toEqual({ agentId: "chat", enabled: true, allowed: settingsFallback.auto.enabled, everyTurns: settingsFallback.auto.everyTurns });
    expect(f.chatAuto).toHaveBeenCalledWith("chat"); await w.cleanup();
  });
  it("writes a chat switch, then answers with what is stored", async () => {
    const w = setup(); f.setChatAuto.mockResolvedValue(true); f.chatAuto.mockResolvedValue(true);
    expect(await w.handlers.get(setTitleChatAuto.name)!({ agentId: "chat", enabled: true }, {})).toMatchObject({ agentId: "chat", enabled: true });
    expect(f.setChatAuto).toHaveBeenCalledWith("chat", true); await w.cleanup();
  });
  it("saves nothing when the settings cannot be read, and refuses both switch calls after teardown", async () => {
    const bad = setup(false);
    await expect(bad.handlers.get(setTitleChatAuto.name)!({ agentId: "chat", enabled: true }, {})).rejects.toThrow("could not be read");
    expect(f.setChatAuto).not.toHaveBeenCalled(); await bad.cleanup();
    const w = setup(); await w.cleanup();
    await expect(w.handlers.get(titleChatAuto.name)!({ agentId: "chat" }, {})).rejects.toThrow("stopping");
    await expect(w.handlers.get(setTitleChatAuto.name)!({ agentId: "chat", enabled: true }, {})).rejects.toThrow("stopping");
  });
  it("fails closed for invalid settings instead of enabling automatic renames with defaults", async () => { const w = setup(false); await expect(f.settings!()).rejects.toThrow("could not be read"); await w.cleanup(); });

  it.each(["retitle", "sample"] as const)("coordinator: cleanup drains the acknowledged %s background job before letting the plugin exit", async (kind) => {
    const w = setup(); const paseo = {};
    let release!: (value: unknown) => void;
    const run = kind === "retitle" ? f.retitle : f.test;
    run.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const ack = await w.handlers.get(kind === "retitle" ? retitleChat.name : titleTest.name)!(kind === "retitle" ? { agentId: "chat" } : {}, { paseo });
    await tick();
    expect(ack).toMatchObject({ kind, jobId: expect.any(String) });
    let exited = false;
    const cleanup = Promise.resolve(w.cleanup!()).then(() => { exited = true; });
    await tick();
    const exitedBeforeRequestsSettled = exited;
    expect(run.mock.lastCall?.[1]).toMatchObject({ signal: expect.any(AbortSignal) });
    expect(run.mock.lastCall?.[1].signal.aborted).toBe(true);
    release(kind === "retitle" ? result : sampleResult); await cleanup;
    expect(exitedBeforeRequestsSettled, "In-flight helpers need time to cancel and archive before process shutdown").toBe(false);
  });

  it("makes teardown idempotent and rejects every RPC after disposal", async () => {
    const w = setup(); const cleanup = w.cleanup!(); expect(w.cleanup!()).toBe(cleanup); await cleanup;
    for (const contract of [retitleChat, titleTest, titleJobStatus, titleOverview, titleProviders, titleModels]) {
      await expect(w.handlers.get(contract.name)!({ agentId: "chat", provider: "p" }, { paseo: {} })).rejects.toThrow("stopping");
    }
    await w.hook({}, { paseo: {} });
    expect(f.retitle).not.toHaveBeenCalled(); expect(f.test).not.toHaveBeenCalled(); expect(f.onTurnEnded).not.toHaveBeenCalled();
    expect(w.unhook).toHaveBeenCalledTimes(1); expect(f.stop).toHaveBeenCalledTimes(1);
  });

  it("still drains other owned requests when one generation rejects", async () => {
    const w = setup(); let release!: () => void;
    f.retitle.mockRejectedValueOnce(new Error("model failed"));
    f.test.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const rename = await w.handlers.get(retitleChat.name)!({ agentId: "chat" }, { paseo: {} });
    const sample = await w.handlers.get(titleTest.name)!({}, { paseo: {} }); await tick();
    expect(sample).toMatchObject({ kind: "sample" });
    expect(await w.handlers.get(titleJobStatus.name)!({ jobId: rename.jobId }, {})).toMatchObject({ job: { state: "failed", error: "model failed" } });
    let settled = false; const cleanup = w.cleanup!().then(() => { settled = true; });
    await tick(); expect(settled).toBe(false);
    release(); await cleanup;
  });

  it("closes admission if disposal races an as-yet-unstarted acknowledgement and drains safely", async () => {
    const w = setup(); const request = w.handlers.get(retitleChat.name)!({ agentId: "chat" }, { paseo: {} });
    const rejected = expect(request).rejects.toThrow("stopping"); const cleanup = w.cleanup();
    await rejected; await cleanup; expect(f.retitle).not.toHaveBeenCalled();
  });

  it("installs the drain promise before abort listeners can re-enter teardown", async () => {
    const w = setup(); let reentered: Promise<void> | undefined; let release!: () => void;
    f.test.mockImplementationOnce((_paseo, { signal }: { signal: AbortSignal }) => new Promise<void>((resolve) => {
      release = resolve; signal.addEventListener("abort", () => { reentered = w.cleanup(); }, { once: true });
    }));
    await w.handlers.get(titleTest.name)!({}, { paseo: {} }); await tick();
    const cleanup = w.cleanup(); expect(reentered).toBe(cleanup); release(); await cleanup;
    expect(w.unhook).toHaveBeenCalledTimes(1); expect(f.stop).toHaveBeenCalledTimes(1);
  });
});
