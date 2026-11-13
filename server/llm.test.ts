import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedModel } from "./catalog";
import { HELPER_LABEL, HELPER_TITLE, SCRATCH_NAME, isHelperAgent, runTitleModel, scratchFolder, type HelperAgent, type HelperCreate, type RunnerPaseo } from "./llm";

type Wait = { status: string; error?: string | null; lastMessage?: string | null };

interface Script {
  waits?: Wait[];
  /** Used once the scripted waits run out. */
  then?: Wait;
  permissions?: { id: string }[];
  tail?: { type: string; text?: string }[];
  workspaceId?: string | null;
  archiveFails?: boolean;
  createFails?: boolean;
  delayMs?: number;
}

function fakeRunner(script: Script = {}) {
  const log = { created: [] as HelperCreate[], existedAtCreate: false, emptyAtCreate: false, archivedAgents: 0, archivedWorkspaces: [] as string[], denied: [] as { requestId: string; interrupt: boolean; behavior: string }[], waits: 0, active: 0, maxActive: 0 };
  const agent: HelperAgent = {
    id: "helper-1",
    workspaceId: script.workspaceId === undefined ? "wks-helper" : script.workspaceId,
    get pendingPermissions() {
      return script.permissions ?? [];
    },
    async refresh() {},
    async waitForFinish() {
      log.waits += 1;
      if (script.delayMs) await new Promise((resolve) => setTimeout(resolve, script.delayMs));
      const result = script.waits?.shift() ?? script.then ?? { status: "idle", lastMessage: "Fix the archive button" };
      log.active -= 1;
      return result;
    },
    async respondToPermission({ requestId, response }) {
      log.denied.push({ requestId, interrupt: response.interrupt, behavior: response.behavior });
    },
    async archive() {
      log.archivedAgents += 1;
      if (script.archiveFails) throw new Error("archive failed");
      return {};
    },
    timeline: { refetch: async () => ({ entries: (script.tail ?? []).map((item) => ({ item })) }) },
  };
  const paseo: RunnerPaseo = {
    providers: { snapshot: async () => ({ entries: [] }), listModels: async () => ({ models: [] }), listModes: async () => ({ modes: [] }) },
    agents: {
      async create(options) {
        log.created.push(options);
        log.active += 1;
        log.maxActive = Math.max(log.maxActive, log.active);
        log.existedAtCreate = existsSync(options.cwd);
        log.emptyAtCreate = log.existedAtCreate && readdirSync(options.cwd).length === 0;
        if (script.createFails) throw new Error("the daemon refused the agent");
        return agent;
      },
    },
    workspaces: {
      async archive(workspaceId) {
        log.archivedWorkspaces.push(workspaceId);
        if (script.archiveFails) throw new Error("workspace archive failed");
        return {};
      },
    },
  };
  return { paseo, log, agent };
}

const model: ResolvedModel = { provider: "opencode", model: "opencode-go/deepseek-v4.1-flash", thinking: "low", mode: "plan" };

let scratchRoot: string;
beforeEach(() => {
  scratchRoot = mkdtempSync(join(tmpdir(), "chat-title-test-root-"));
});
afterEach(() => {
  rmSync(scratchRoot, { recursive: true, force: true });
});
const run = (paseo: RunnerPaseo, extra: Parameters<typeof runTitleModel>[3] = {}, resolved: ResolvedModel = model) => runTitleModel(paseo, resolved, "the prompt", { scratchRoot, ...extra });

describe("runTitleModel", () => {
  it("returns the model's text from a read-only helper made on the chosen provider and model", async () => {
    const { paseo, log } = fakeRunner();
    expect(await run(paseo)).toBe("Fix the archive button");
    expect(log.created).toHaveLength(1);
    const created = log.created[0]!;
    expect(created.config).toEqual({ provider: "opencode/opencode-go/deepseek-v4.1-flash", modeId: "plan", thinkingOptionId: "low" });
    expect(created.prompt).toBe("the prompt");
    expect(created.title).toBe(HELPER_TITLE);
    expect(created.labels).toEqual(HELPER_LABEL);
    expect(created.background).toBe(true);
    expect(created.cwd).toBe(scratchFolder(scratchRoot));
  });

  it("leaves out the mode and thinking level when the model has none", async () => {
    const { paseo, log } = fakeRunner();
    await run(paseo, {}, { provider: "claude", model: "claude-haiku-4-5" });
    expect(log.created[0]!.config).toEqual({ provider: "claude/claude-haiku-4-5" });
  });

  it("works in one empty scratch folder that it makes, reuses and leaves in place", async () => {
    const { paseo, log } = fakeRunner();
    await run(paseo);
    await run(paseo);
    expect(log.existedAtCreate).toBe(true);
    expect(log.emptyAtCreate).toBe(true);
    expect(log.created[0]!.cwd).toBe(log.created[1]!.cwd);
    expect(readdirSync(scratchRoot)).toEqual([SCRATCH_NAME]);
    expect(readdirSync(log.created[0]!.cwd)).toEqual([]);
  });

  it("runs one helper at a time, in the order asked", async () => {
    const { paseo, log } = fakeRunner({ delayMs: 20, waits: [{ status: "idle", lastMessage: "one" }, { status: "idle", lastMessage: "two" }, { status: "idle", lastMessage: "three" }] });
    const results = await Promise.all([run(paseo), run(paseo), run(paseo)]);
    expect(results).toEqual(["one", "two", "three"]);
    expect(log.maxActive).toBe(1);
    expect(log.archivedAgents).toBe(3);
  });

  it("does not let a failed run block the next one", async () => {
    const { paseo } = fakeRunner({ waits: [{ status: "error", error: "model not found" }, { status: "idle", lastMessage: "second works" }] });
    const [first, second] = await Promise.allSettled([run(paseo), run(paseo)]);
    expect(first.status).toBe("rejected");
    expect(second).toEqual({ status: "fulfilled", value: "second works" });
  });

  it("archives the helper and the workspace Paseo made for it", async () => {
    const { paseo, log } = fakeRunner();
    await run(paseo);
    expect(log.archivedAgents).toBe(1);
    expect(log.archivedWorkspaces).toEqual(["wks-helper"]);
  });

  it("does not try to archive a workspace the helper does not have", async () => {
    const { paseo, log } = fakeRunner({ workspaceId: null });
    await run(paseo);
    expect(log.archivedAgents).toBe(1);
    expect(log.archivedWorkspaces).toEqual([]);
  });

  it("refuses every permission request and still returns the reply that follows", async () => {
    const { paseo, log } = fakeRunner({ waits: [{ status: "permission" }, { status: "permission" }], permissions: [{ id: "p1" }] });
    expect(await run(paseo)).toBe("Fix the archive button");
    expect(log.denied).toEqual([
      { requestId: "p1", interrupt: false, behavior: "deny" },
      { requestId: "p1", interrupt: false, behavior: "deny" },
    ]);
  });

  it("gives up when the model keeps asking for tools, and still cleans up", async () => {
    const { paseo, log } = fakeRunner({ then: { status: "permission" }, permissions: [{ id: "p1" }, { id: "p2" }] });
    await expect(run(paseo)).rejects.toThrow("The model kept asking to use tools.");
    expect(log.archivedAgents).toBe(1);
    expect(log.archivedWorkspaces).toEqual(["wks-helper"]);
  });

  it("times out with a clear message and still cleans up", async () => {
    const { paseo, log } = fakeRunner({ then: { status: "timeout" }, delayMs: 15 });
    await expect(run(paseo, { answerWithinMs: 60 })).rejects.toThrow("The model did not answer in time.");
    expect(log.waits).toBeGreaterThan(1);
    expect(log.archivedAgents).toBe(1);
    expect(log.archivedWorkspaces).toEqual(["wks-helper"]);
  });

  it("passes on the message of an agent error", async () => {
    const { paseo } = fakeRunner({ waits: [{ status: "error", error: "model not found" }] });
    await expect(run(paseo)).rejects.toThrow("model not found");
  });

  it("rejects the observed Claude quota notice even when the daemon reports idle, and still cleans up", async () => {
    const notice = "You've hit your 5-hour limit · resets 12:50pm (Asia/Jakarta)";
    const { paseo, log } = fakeRunner({ waits: [{ status: "idle", lastMessage: notice }] });
    await expect(run(paseo)).rejects.toThrow(notice);
    expect(log.archivedAgents).toBe(1);
    expect(log.archivedWorkspaces).toEqual(["wks-helper"]);
  });

  it("rejects a quota notice read from the assistant timeline fallback", async () => {
    const { paseo } = fakeRunner({ waits: [{ status: "idle", lastMessage: null }], tail: [{ type: "assistant_message", text: "You've hit your usage limit. Try again later." }] });
    await expect(run(paseo)).rejects.toThrow("usage limit");
  });

  it("does not reject a legitimate title about implementing rate limits", async () => {
    const { paseo } = fakeRunner({ waits: [{ status: "idle", lastMessage: "Fix rate limit handling in the API" }] });
    expect(await run(paseo)).toBe("Fix rate limit handling in the API");
  });

  it("reads the last assistant message from the timeline when the finish result has no text", async () => {
    const { paseo } = fakeRunner({ waits: [{ status: "idle", lastMessage: "  " }], tail: [{ type: "assistant_message", text: "earlier" }, { type: "tool_call" }, { type: "assistant_message", text: "Rename chats from recent messages" }] });
    expect(await run(paseo)).toBe("Rename chats from recent messages");
  });

  it("says so when the model sent no reply at all", async () => {
    const { paseo } = fakeRunner({ waits: [{ status: "idle", lastMessage: null }], tail: [{ type: "reasoning", text: "thinking" }] });
    await expect(run(paseo)).rejects.toThrow("The model sent no reply.");
  });

  it("still tries to archive both when archiving fails, and reports the model's error rather than the archive error", async () => {
    const { paseo, log } = fakeRunner({ waits: [{ status: "error", error: "rate limited" }], archiveFails: true });
    await expect(run(paseo)).rejects.toThrow("rate limited");
    expect(log.archivedAgents).toBe(1);
    expect(log.archivedWorkspaces).toEqual(["wks-helper"]);
  });

  it("archives nothing when the helper could not be created", async () => {
    const { paseo, log } = fakeRunner({ createFails: true });
    await expect(run(paseo)).rejects.toThrow("the daemon refused the agent");
    expect(log.archivedAgents).toBe(0);
    expect(log.archivedWorkspaces).toEqual([]);
  });

  it("does not start a helper for a rename that was already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const { paseo, log } = fakeRunner();
    await expect(run(paseo, { signal: controller.signal })).rejects.toThrow("The rename was cancelled.");
    expect(log.created).toHaveLength(0);
  });

  it("stops waiting and archives the helper when cancelled during the wait", async () => {
    const controller = new AbortController();
    const { paseo, log } = fakeRunner({ then: { status: "timeout" }, delayMs: 15 });
    const pending = run(paseo, { signal: controller.signal });
    setTimeout(() => controller.abort(), 40);
    await expect(pending).rejects.toThrow("The rename was cancelled.");
    expect(log.archivedAgents).toBe(1);
    expect(log.archivedWorkspaces).toEqual(["wks-helper"]);
  });

  it("coordinator: cancellation archives promptly even when the provider's finish wait is still pending", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const { paseo, log } = fakeRunner({ delayMs: 10_000 });
      const pending = run(paseo, { signal: controller.signal }).catch((error: Error) => error);
      await vi.advanceTimersByTimeAsync(20);
      expect(log.waits).toBe(1);
      controller.abort();
      await vi.advanceTimersByTimeAsync(20);
      const archivedPromptly = log.archivedAgents;
      await vi.advanceTimersByTimeAsync(10_000);
      await pending;
      expect(archivedPromptly, "Paseo gives plugin cleanup only a two-second graceful shutdown window").toBe(1);
      expect(log.archivedWorkspaces).toEqual(["wks-helper"]);
    } finally { vi.useRealTimers(); }
  });

  it.each(["resolve", "reject"] as const)("observes a late provider %s after cancellation and removes its abort listener", async (outcome) => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const { paseo, log, agent } = fakeRunner();
    let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
    let resolveWait!: (result: Wait) => void; let rejectWait!: (error: Error) => void;
    agent.waitForFinish = () => { entered(); return new Promise<Wait>((resolve, reject) => { resolveWait = resolve; rejectWait = reject; }); };
    const pending = run(paseo, { signal: controller.signal }).catch((error: Error) => error);
    await started; controller.abort();
    expect(await pending).toMatchObject({ message: "The rename was cancelled." });
    expect(log.archivedAgents).toBe(1); expect(log.archivedWorkspaces).toEqual(["wks-helper"]);
    expect(remove.mock.calls.filter(([event]) => event === "abort")).toHaveLength(add.mock.calls.filter(([event]) => event === "abort").length);
    if (outcome === "resolve") resolveWait({ status: "idle", lastMessage: "A late title that must not escape" });
    else rejectWait(new Error("provider rejected after archive"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(log.archivedAgents).toBe(1);
  });

  it("removes the abort listener when a provider finishes normally", async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const { paseo, log } = fakeRunner();
    expect(await run(paseo, { signal: controller.signal })).toBe("Fix the archive button");
    expect(add.mock.calls.filter(([event]) => event === "abort")).toHaveLength(1);
    expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0][1]);
    controller.abort(); expect(log.archivedAgents).toBe(1);
  });

  it.each(["sync", "async"] as const)("removes the abort listener on a %s provider failure", async (kind) => {
    const controller = new AbortController(); const { paseo, log, agent } = fakeRunner();
    const add = vi.spyOn(controller.signal, "addEventListener"); const remove = vi.spyOn(controller.signal, "removeEventListener");
    agent.waitForFinish = () => { if (kind === "sync") throw new Error("provider broke"); return Promise.reject(new Error("provider broke")); };
    await expect(run(paseo, { signal: controller.signal })).rejects.toThrow("provider broke");
    expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0][1]);
    expect(log.archivedAgents).toBe(1); controller.abort(); expect(log.archivedAgents).toBe(1);
  });

  it.each(["timeline", "permission refresh"] as const)("cancels a pending %s observation without starting more work", async (stage) => {
    const controller = new AbortController();
    const { paseo, log, agent } = fakeRunner({ waits: [{ status: stage === "timeline" ? "idle" : "permission", lastMessage: null }] });
    let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
    let rejectLate!: (error: Error) => void;
    const held = new Promise<never>((_resolve, reject) => { rejectLate = reject; });
    if (stage === "timeline") agent.timeline.refetch = () => { entered(); return held; };
    else agent.refresh = () => { entered(); return held; };
    const pending = run(paseo, { signal: controller.signal }).catch((error: Error) => error);
    await started; controller.abort();
    expect(await pending).toMatchObject({ message: "The rename was cancelled." });
    expect(log.archivedAgents).toBe(1); expect(log.denied).toEqual([]);
    rejectLate(new Error("late observation failure"));
    await new Promise((resolve) => setImmediate(resolve));
  });

  it("keeps the serialized slot until a cancelled helper has actually finished archiving", async () => {
    const controller = new AbortController(); const { paseo, log, agent } = fakeRunner();
    let entered!: () => void; const waiting = new Promise<void>((resolve) => { entered = resolve; });
    let releaseArchive!: () => void; const archiveGate = new Promise<void>((resolve) => { releaseArchive = resolve; });
    let archiveEntered!: () => void; const archiving = new Promise<void>((resolve) => { archiveEntered = resolve; });
    let finishLate!: (result: Wait) => void; let waits = 0;
    agent.waitForFinish = () => ++waits === 1 ? (entered(), new Promise<Wait>((resolve) => { finishLate = resolve; })) : Promise.resolve({ status: "idle", lastMessage: "Second title" });
    const originalArchive = agent.archive;
    agent.archive = async () => { archiveEntered(); await archiveGate; return originalArchive(); };
    const first = run(paseo, { signal: controller.signal }).catch((error: Error) => error);
    await waiting; const second = run(paseo); controller.abort(); await archiving;
    expect(log.created).toHaveLength(1);
    releaseArchive(); expect(await first).toBeInstanceOf(Error); expect(await second).toBe("Second title");
    expect(log.created).toHaveLength(2); expect(log.archivedAgents).toBe(2);
    finishLate({ status: "idle", lastMessage: "Ignored late first title" });
    await new Promise((resolve) => setImmediate(resolve));
  });

  it("drains a pending creation so a helper returned after cancellation is still archived", async () => {
    const controller = new AbortController(); const { paseo, log } = fakeRunner();
    let entered!: () => void; const creating = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const create = paseo.agents.create;
    paseo.agents.create = async (options) => { entered(); await gate; return create(options); };
    let settled = false;
    const pending = run(paseo, { signal: controller.signal }).catch((error: Error) => error).then((result) => { settled = true; return result; });
    await creating; controller.abort(); await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false); release();
    expect(await pending).toMatchObject({ message: "The rename was cancelled." });
    expect(log.waits).toBe(0); expect(log.archivedAgents).toBe(1);
  });
});

describe("isHelperAgent", () => {
  it("recognises the helper by its title", () => {
    expect(isHelperAgent({ title: HELPER_TITLE, cwd: "C:\\somewhere\\else" })).toBe(true);
  });

  it("recognises the helper by its scratch folder, whatever the letter case of the path", () => {
    expect(isHelperAgent({ title: null, cwd: scratchFolder() })).toBe(true);
    expect(isHelperAgent({ title: null, cwd: scratchFolder().toUpperCase() })).toBe(true);
    expect(isHelperAgent({ title: null, cwd: scratchFolder(scratchRoot) }, scratchRoot)).toBe(true);
  });

  it("does not take a folder with a similar name elsewhere, or an ordinary chat, for a helper", () => {
    expect(isHelperAgent({ title: "Fix the bug", cwd: join(tmpdir(), "nested", SCRATCH_NAME) })).toBe(false);
    expect(isHelperAgent({ title: "Fix the bug", cwd: join(tmpdir(), `${SCRATCH_NAME}-2`) })).toBe(false);
    expect(isHelperAgent({ title: "Fix the bug", cwd: "C:\\Users\\Alvin\\Documents\\Personal\\Random" })).toBe(false);
    expect(isHelperAgent({ title: undefined, cwd: undefined })).toBe(false);
    expect(isHelperAgent({ title: "[Chat] unrelated", cwd: null })).toBe(false);
  });
});
