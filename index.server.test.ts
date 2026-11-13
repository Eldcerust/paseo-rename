import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "./index.server";
import { settingsFallback } from "./shared/settings";
import { retitleChat, titleModels, titleOverview, titleProviders, titleTest } from "./shared/rpc";

const f = vi.hoisted(() => ({ retitle: vi.fn(), overview: vi.fn(), test: vi.fn(), providers: vi.fn(), models: vi.fn(), onTurnEnded: vi.fn(), stop: vi.fn(), idle: vi.fn(), settings: undefined as undefined | (() => Promise<unknown>) }));
vi.mock("./server/retitle", () => ({ createRetitler: (deps: { settings: () => Promise<unknown> }) => { f.settings = deps.settings; return { ...f, catalog: () => ({ providers: f.providers, models: f.models }) }; } }));
vi.mock("./server/auto", () => ({ createAuto: () => f }));
vi.mock("./server/state", () => ({ createStateStore: () => ({}), statePath: () => "not-used" }));
beforeEach(() => vi.clearAllMocks());

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
    const w = setup(); expect(w.handlers.size).toBe(5); expect(await f.settings!()).toEqual(settingsFallback);
    const paseo = {}; f.retitle.mockResolvedValue({ status: "unchanged" });
    await w.handlers.get(retitleChat.name)!({ agentId: "chat", force: true }, { paseo });
    expect(f.retitle).toHaveBeenCalledWith(paseo, { agentId: "chat", force: true, source: "manual", signal: expect.any(AbortSignal) });
    f.providers.mockResolvedValue(["a"]); f.models.mockResolvedValue(["m"]);
    expect(await w.handlers.get(titleProviders.name)!({}, { paseo })).toEqual({ providers: ["a"] });
    expect(await w.handlers.get(titleModels.name)!({ provider: "p" }, { paseo })).toEqual({ models: ["m"] }); expect(f.models).toHaveBeenCalledWith("p");
    await w.handlers.get(titleOverview.name)!({}, { paseo }); expect(f.overview).toHaveBeenCalledWith(paseo);
    await w.handlers.get(titleTest.name)!({}, { paseo }); expect(f.test).toHaveBeenCalledWith(paseo, { signal: expect.any(AbortSignal) });
  });
  it("wires the modern completed-turn hook and releases it on teardown", async () => {
    const w = setup(); const event = { outcome: { kind: "completed" } }; const paseo = {};
    expect(w.server.addHook).toHaveBeenCalledWith("agent.turn.after", expect.any(Function));
    await w.hook(event, { paseo }); expect(f.onTurnEnded).toHaveBeenCalledWith(event, paseo);
    await w.cleanup!(); expect(w.unhook).toHaveBeenCalledTimes(1); expect(f.stop).toHaveBeenCalledTimes(1); expect(f.idle).toHaveBeenCalledTimes(1);
  });
  it("fails closed for invalid settings instead of enabling automatic renames with defaults", async () => { setup(false); await expect(f.settings!()).rejects.toThrow("could not be read"); });

  it("coordinator: cleanup drains manual rename and sample RPCs before letting the plugin exit", async () => {
    const w = setup(); const paseo = {};
    let releaseRename!: () => void; let releaseSample!: () => void;
    f.retitle.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseRename = resolve; }));
    f.test.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseSample = resolve; }));
    const rename = w.handlers.get(retitleChat.name)!({ agentId: "chat" }, { paseo });
    const sample = w.handlers.get(titleTest.name)!({}, { paseo });
    let exited = false;
    const cleanup = Promise.resolve(w.cleanup!()).then(() => { exited = true; });
    await new Promise((resolve) => setImmediate(resolve));
    const exitedBeforeRequestsSettled = exited;
    releaseRename(); releaseSample();
    await Promise.all([rename, sample, cleanup]);
    expect(exitedBeforeRequestsSettled, "In-flight helpers need time to cancel and archive before process shutdown").toBe(false);
    expect(f.test.mock.lastCall?.[1]).toMatchObject({ signal: expect.any(AbortSignal) });
  });

  it("makes teardown idempotent and rejects every RPC after disposal", async () => {
    const w = setup(); const cleanup = w.cleanup!(); expect(w.cleanup!()).toBe(cleanup); await cleanup;
    for (const contract of [retitleChat, titleTest, titleOverview, titleProviders, titleModels]) {
      await expect(w.handlers.get(contract.name)!({ agentId: "chat", provider: "p" }, { paseo: {} })).rejects.toThrow("stopping");
    }
    await w.hook({}, { paseo: {} });
    expect(f.retitle).not.toHaveBeenCalled(); expect(f.test).not.toHaveBeenCalled(); expect(f.onTurnEnded).not.toHaveBeenCalled();
    expect(w.unhook).toHaveBeenCalledTimes(1); expect(f.stop).toHaveBeenCalledTimes(1);
  });

  it("still drains other requests when one RPC rejects", async () => {
    const w = setup(); let release!: () => void;
    f.retitle.mockRejectedValueOnce(new Error("model failed"));
    f.test.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const rename = w.handlers.get(retitleChat.name)!({ agentId: "chat" }, { paseo: {} }).catch((error: Error) => error);
    const sample = w.handlers.get(titleTest.name)!({}, { paseo: {} });
    let settled = false; const cleanup = w.cleanup!().then(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve)); expect(settled).toBe(false);
    release(); await Promise.all([sample, cleanup]); expect(await rename).toMatchObject({ message: "model failed" });
  });
});
