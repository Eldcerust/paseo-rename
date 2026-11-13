import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import contribute from "../index.server";
import { retitleChat, setTitleChatAuto, titleChatAuto } from "../shared/rpc";
import { chatTitleSettings } from "../shared/settings";
import { DEBOUNCE_MS } from "./auto";

/**
 * The real server entry, the real trigger, the real retitle service and a real state file, with only the daemon
 * faked. A chat "reaches the model" when the retitle service asks the daemon for it, which is recorded in `refreshed`.
 */
let folder: string;
let previousHome: string | undefined;
const stops: (() => Promise<void>)[] = [];
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "chat-auto-integration-"));
  previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = folder;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  vi.useRealTimers();
  if (previousHome === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previousHome;
  rmSync(folder, { recursive: true, force: true });
});

function world() {
  const values = chatTitleSettings.schema.parse({});
  const refreshed: string[] = [];
  const paseo = {
    providers: {
      snapshot: async () => ({ entries: [{ provider: "claude", status: "ready", enabled: true }] }),
      listModels: async () => ({ models: [{ id: "claude-haiku-5-5", label: "Haiku" }] }),
      listModes: async () => ({ modes: [] }),
    },
    agents: {
      create: async () => { throw new Error("model reached"); },
      list: async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null } }),
      ref: (id: string) => ({
        refresh: async () => { refreshed.push(id); return { agent: { id, title: null, workspaceId: null } }; },
        timeline: { refetch: async () => ({ entries: [{ item: { type: "user_message", text: "Design a model picker" } }], hasOlder: false, startCursor: null }) },
      }),
    },
    workspaces: { archive: async () => ({}), ref: () => ({ refresh: async () => null, setTitle: async (title: string) => ({ title }) }) },
  };
  function boot() {
    const handlers = new Map<string, (input: unknown, context: unknown) => Promise<any>>();
    const hooks = new Map<string, (event: unknown, context: unknown) => Promise<void>>();
    const server = {
      registerSettings: () => ({ read: async () => ({ status: "ready", values }) }),
      handle: (contract: { name: string }, handler: (input: unknown, context: unknown) => Promise<any>) => handlers.set(contract.name, handler),
      addHook: (name: string, handler: (event: unknown, context: unknown) => Promise<void>) => { hooks.set(name, handler); return () => hooks.delete(name); },
    };
    const cleanup = contribute(server as never);
    const stop = async () => { await cleanup(); };
    stops.push(stop);
    return {
      stop,
      read: (agentId: string) => handlers.get(titleChatAuto.name)!({ agentId }, { paseo }),
      set: (agentId: string, enabled: boolean) => handlers.get(setTitleChatAuto.name)!({ agentId, enabled }, { paseo }),
      manual: (agentId: string) => handlers.get(retitleChat.name)!({ agentId, force: true }, { paseo }),
      turn: (id: string) => hooks.get("agent.turn.after")!({ agent: { id, workspaceId: null, parentAgentId: null, cwd: folder, title: null }, outcome: { kind: "completed" } }, { paseo }),
    };
  }
  return { values, refreshed, boot };
}

/** Lets the debounce fire and real file work finish. The timers that are faked are only setTimeout and clearTimeout. */
async function settle(done: () => boolean = () => false) {
  await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
  const started = Date.now();
  while (!done() && Date.now() - started < 3000) await new Promise((resolve) => setImmediate(resolve));
  for (let index = 0; index < 50; index++) await new Promise((resolve) => setImmediate(resolve));
}

describe("per-chat automatic renaming through the real server entry", () => {
  it("renames nothing on a fresh install, however many turns finish", async () => {
    const w = world(); const server = w.boot();
    await server.turn("a"); await server.turn("a"); await server.turn("b");
    await server.set("control", true); await server.turn("control");
    await settle(() => w.refreshed.includes("control"));
    expect(w.refreshed).toContain("control");
    expect(w.refreshed).not.toContain("a"); expect(w.refreshed).not.toContain("b");
    // The turns of chats that are off are not even stored.
    const file = join(folder, "plugin-data", "chat-title", "state.json");
    const saved = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    expect(saved.agents?.a).toBeUndefined(); expect(saved.agents?.b).toBeUndefined(); expect(saved.agents?.control).toBeDefined();
  });

  it("starts every chat off and reports the host master switch and interval", async () => {
    const w = world(); const server = w.boot();
    expect(await server.read("a")).toEqual({ agentId: "a", enabled: false, allowed: true, everyTurns: 4 });
    expect(await server.set("a", true)).toMatchObject({ enabled: true });
    expect(await server.read("a")).toMatchObject({ enabled: true }); expect(await server.read("b")).toMatchObject({ enabled: false });
  });

  it("renames a chat after its next completed turn once it is switched on, and only that chat", async () => {
    const w = world(); const server = w.boot();
    await server.set("on", true);
    await server.turn("on"); await server.turn("off");
    await settle(() => w.refreshed.includes("on"));
    expect(w.refreshed).toContain("on"); expect(w.refreshed).not.toContain("off");
  });

  it("remembers the choice when the plugin is reloaded", async () => {
    const w = world(); const first = w.boot();
    await first.set("a", true); await first.stop();
    const second = w.boot();
    expect(await second.read("a")).toMatchObject({ enabled: true });
    await second.turn("a"); await settle(() => w.refreshed.includes("a"));
    expect(w.refreshed).toContain("a");
  });

  it("drops a rename that is waiting when its chat is switched off", async () => {
    const w = world(); const server = w.boot();
    await server.set("a", true); await server.turn("a"); await server.set("a", false);
    await server.set("control", true); await server.turn("control");
    await settle(() => w.refreshed.includes("control"));
    expect(w.refreshed).toContain("control"); expect(w.refreshed).not.toContain("a");
  });

  it("does not rename a switched-on chat while the host master switch is off", async () => {
    const w = world(); const server = w.boot();
    w.values.auto.enabled = false;
    await server.set("a", true); await server.turn("a"); await settle();
    expect(w.refreshed).toEqual([]);
    expect(await server.read("a")).toMatchObject({ enabled: true, allowed: false });
    w.values.auto.enabled = true; await server.turn("a"); await settle(() => w.refreshed.includes("a"));
    expect(w.refreshed).toContain("a");
  });

  it("lets a person rename a chat by hand whatever its switch says", async () => {
    const w = world(); const server = w.boot();
    expect(await server.read("a")).toMatchObject({ enabled: false });
    const ack = await server.manual("a");
    expect(ack).toMatchObject({ kind: "retitle", agentId: "a" });
    await settle(() => w.refreshed.includes("a"));
    expect(w.refreshed).toContain("a"); expect(await server.read("a")).toMatchObject({ enabled: false });
  });
});
