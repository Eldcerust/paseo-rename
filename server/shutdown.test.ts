import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "../index.server";
import { settingsFallback } from "../shared/settings";
import { retitleChat, titleTest } from "../shared/rpc";
import { DEBOUNCE_MS, type TurnEvent } from "./auto";
import { renameAgentWithCli } from "./cli";
import type { HelperAgent } from "./llm";
import type { RetitleDaemon } from "./retitle";

// Only the external title-write adapter is a mock. Entry, auto, retitler, runner and state are real.
vi.mock("./cli", async (original) => ({ ...await original<typeof import("./cli")>(), renameAgentWithCli: vi.fn(async () => {}) }));

const folders: string[] = [];
afterEach(() => {
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.clearAllMocks();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function setup() {
  const parent = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Temp", "opencode") : tmpdir();
  mkdirSync(parent, { recursive: true });
  const folder = mkdtempSync(join(parent, "chat-title-shutdown-")); folders.push(folder);
  vi.stubEnv("PASEO_HOME", folder);
  const waiting = deferred<void>(); const finish = deferred<{ status: string; lastMessage?: string }>();
  const archiveStarted = deferred<void>(); const archiveGate = deferred<void>();
  const archivedAgents: string[] = []; const archivedWorkspaces: string[] = [];
  const helper: HelperAgent = {
    id: "owned-helper", workspaceId: "owned-helper-workspace", pendingPermissions: [],
    refresh: async () => ({}),
    waitForFinish: () => { waiting.resolve(); return finish.promise; },
    respondToPermission: async () => {},
    archive: async () => { archiveStarted.resolve(); await archiveGate.promise; archivedAgents.push("owned-helper"); },
    timeline: { refetch: async () => ({ entries: [] }) },
  };
  const create = vi.fn(async () => helper); const setWorkspaceTitle = vi.fn(async (title: string | null) => ({ title }));
  const daemon: RetitleDaemon = {
    providers: {
      snapshot: async () => ({ entries: [{ provider: "opencode", status: "ready", enabled: true }] }),
      listModels: async () => ({ models: [{ id: "opencode-go/deepseek-v4.1-flash", label: "Flash" }] }),
      listModes: async () => ({ modes: [{ id: "plan" }] }),
    },
    agents: {
      create,
      list: async () => ({ entries: [{ agent: { id: "target", workspaceId: "target-workspace" } }], pageInfo: { hasMore: false } }),
      ref: (id) => ({
        refresh: async () => ({ agent: { id, title: null, workspaceId: "target-workspace" } }),
        timeline: { refetch: async () => ({ entries: [{ item: { type: "user_message", text: "Design a searchable title model picker" } }], hasOlder: false, startCursor: null }) },
      }),
    },
    workspaces: {
      archive: async (id) => { archivedWorkspaces.push(id); },
      ref: () => ({ setTitle: setWorkspaceTitle, refresh: async () => ({ title: "Original workspace title" }) }),
    },
  };
  const handlers = new Map<string, (input: any, context: { paseo: RetitleDaemon }) => Promise<any>>();
  let hook!: (event: TurnEvent, context: { paseo: RetitleDaemon }) => Promise<void>;
  const unhook = vi.fn();
  const server = {
    registerSettings: () => ({ read: async () => ({ status: "ready", values: settingsFallback }) }),
    handle: (contract: { name: string }, handler: any) => { handlers.set(contract.name, handler); },
    addHook: (_name: string, handler: typeof hook) => { hook = handler; return unhook; },
  };
  const cleanup = contribute(server as unknown as PluginServerContext);
  return { daemon, handlers, hook, cleanup, waiting, finish, archiveStarted, archiveGate, archivedAgents, archivedWorkspaces, create, setWorkspaceTitle, unhook };
}

describe("graceful shutdown through the real services", () => {
  it("drains an active manual helper and a queued sample together without creating a second helper after disposal", async () => {
    const w = setup();
    const manual = w.handlers.get(retitleChat.name)!({ agentId: "target", force: true }, { paseo: w.daemon });
    await w.waiting.promise;
    const sample = w.handlers.get(titleTest.name)!({}, { paseo: w.daemon }).catch((error: Error) => error);
    await new Promise((resolve) => setImmediate(resolve));
    const cleanup = w.cleanup(); await w.archiveStarted.promise;
    expect(w.create).toHaveBeenCalledTimes(1);
    w.archiveGate.resolve(); await cleanup;
    expect(await manual).toMatchObject({ status: "skipped", reason: "The rename was cancelled." });
    expect(await sample).toMatchObject({ message: "The rename was cancelled." });
    expect(w.create).toHaveBeenCalledTimes(1);
    expect(w.archivedAgents).toEqual(["owned-helper"]); expect(w.archivedWorkspaces).toEqual(["owned-helper-workspace"]);
    w.finish.resolve({ status: "idle", lastMessage: "Ignored after cleanup" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(renameAgentWithCli).not.toHaveBeenCalled(); expect(w.setWorkspaceTitle).not.toHaveBeenCalled();
  });

  it.each([
    ["manual", "resolve"], ["manual", "reject"],
    ["sample", "resolve"], ["sample", "reject"],
    ["auto", "resolve"], ["auto", "reject"],
  ] as const)("cancels and drains %s, then safely observes a late provider %s without a title write", async (path, late) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const w = setup(); let request: Promise<any> | undefined;
    if (path === "auto") {
      await w.hook({ agent: { id: "target", workspaceId: "target-workspace", parentAgentId: null, cwd: "C:/test-target", title: null }, outcome: { kind: "completed" } }, { paseo: w.daemon });
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    } else {
      const contract = path === "manual" ? retitleChat : titleTest;
      request = w.handlers.get(contract.name)!(path === "manual" ? { agentId: "target", force: true } : {}, { paseo: w.daemon }).catch((error: Error) => error);
    }
    await w.waiting.promise;
    let exited = false; const drain = w.cleanup(); expect(w.cleanup()).toBe(drain);
    const stopped = drain.then(() => { exited = true; });
    await w.archiveStarted.promise; await new Promise((resolve) => setImmediate(resolve));
    expect(exited, "Cleanup cannot exit while helper archival is pending").toBe(false);
    w.archiveGate.resolve(); await stopped;
    if (path === "manual") expect(await request).toMatchObject({ status: "skipped", reason: "The rename was cancelled." });
    if (path === "sample") expect(await request).toMatchObject({ message: "The rename was cancelled." });
    expect(w.archivedAgents).toEqual(["owned-helper"]); expect(w.archivedWorkspaces).toEqual(["owned-helper-workspace"]);
    expect(w.unhook).toHaveBeenCalledTimes(1);
    if (late === "resolve") w.finish.resolve({ status: "idle", lastMessage: "This late title must not be applied" });
    else w.finish.reject(new Error("Late provider rejection after shutdown"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(renameAgentWithCli).not.toHaveBeenCalled(); expect(w.setWorkspaceTitle).not.toHaveBeenCalled();
    await expect(w.handlers.get(titleTest.name)!({}, { paseo: w.daemon })).rejects.toThrow("stopping");
    await expect(w.handlers.get(retitleChat.name)!({ agentId: "target" }, { paseo: w.daemon })).rejects.toThrow("stopping");
    expect(w.create).toHaveBeenCalledTimes(1);
  });
});
