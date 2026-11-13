import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { settingsFallback, type ChatTitleValues } from "../shared/settings";
import { provisionalTitle } from "../shared/title";
import type { ResolvedModel } from "./catalog";
import { SAMPLE_CHAT, createRetitler, type RetitleDaemon } from "./retitle";
import { createStateStore } from "./state";

const AGENT = "chat-1";
const WORKSPACE = "wks-chat";
const FIRST_PROMPT = "/unlazy tree 5 develop a plugin too that would take the 10 or 20? last messages and then rename the chat";
const DEFAULT_MODEL = "opencode/opencode-go/deepseek-v4.1-flash";
const NEW_TITLE = "Rename chats from recent messages";

const CONVERSATION = [
  { role: "user", text: "message one" },
  { role: "assistant", text: "message two" },
  { role: "user", text: "message three" },
  { role: "assistant", text: "message four" },
  { role: "user", text: "message five" },
  { role: "assistant", text: "message six" },
] as const;

let folder: string;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "chat-title-test-root-"));
});
afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

interface Options {
  title?: string | null;
  archived?: boolean;
  labels?: Record<string, string>;
  cwd?: string;
  workspaceId?: string | null;
  workspaceTitle?: string;
  empty?: boolean;
  settings?: Partial<ChatTitleValues>;
  reply?: string;
  projectReply?: string;
  chats?: { id: string; title?: string | null }[];
  runFails?: string;
  projectFails?: string;
  cliFails?: boolean;
  refreshFails?: boolean;
  hold?: Promise<void>;
  helperNotice?: string;
  modelStarted?: () => void;
}

function world(options: Options = {}) {
  const state = { chat: options.title === undefined ? provisionalTitle(FIRST_PROMPT)! : options.title, workspace: options.workspaceTitle ?? "Workspace name" };
  const calls = { models: [] as { model: ResolvedModel; prompt: string }[], cli: [] as string[], workspaceSets: [] as string[], firstPromptReads: 0 };
  const rows = options.empty ? [] : CONVERSATION.map((message, index) => ({ turnId: `t${Math.floor(index / 2)}`, item: { type: message.role === "user" ? "user_message" : "assistant_message", text: message.text } }));
  const thinking = [{ id: "off" }, { id: "low" }];
  const models: Record<string, { id: string; label: string; thinkingOptions: { id: string }[] }[]> = {
    claude: [{ id: "claude-haiku-5-5", label: "Haiku 5.5", thinkingOptions: thinking }],
    opencode: [{ id: "opencode-go/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash", thinkingOptions: thinking }],
  };
  const daemon: RetitleDaemon = {
    providers: {
      snapshot: async () => ({
        entries: [
          { provider: "claude", status: "ready", enabled: true, label: "Claude" },
          { provider: "opencode", status: "ready", enabled: true, label: "OpenCode" },
          { provider: "codex", status: "unavailable", enabled: false, label: "Codex" },
        ],
      }),
      listModels: async (provider) => ({ models: models[provider] ?? [] }),
      listModes: async () => ({ modes: [{ id: "plan" }] }),
    },
    agents: {
      create: async () => {
        if (options.helperNotice) return {
          id: "notice-helper", workspaceId: "notice-workspace", pendingPermissions: [],
          refresh: async () => ({}), waitForFinish: async () => ({ status: "idle", lastMessage: options.helperNotice }),
          respondToPermission: async () => {}, archive: async () => ({}), timeline: { refetch: async () => ({ entries: [] }) },
        };
        throw new Error("the model run is injected, so no helper is created");
      },
      list: async () => ({ entries: (options.chats ?? [{ id: AGENT, title: state.chat }]).map((agent) => ({ agent: { ...agent, workspaceId: WORKSPACE } })), pageInfo: { nextCursor: null, hasMore: false } }),
      ref: (id) => ({
        refresh: async () => {
          if (options.refreshFails) throw new Error("daemon unreachable");
          if (id !== AGENT) return null;
          return { agent: { id, title: state.chat, workspaceId: options.workspaceId === undefined ? WORKSPACE : options.workspaceId, archivedAt: options.archived ? "2026-11-01T00:00:00Z" : null, cwd: options.cwd ?? "C:\\Users\\Alvin\\Documents\\Personal\\Random", labels: options.labels ?? {} } };
        },
        timeline: {
          refetch: async (request) => {
            if (request.direction === "tail" && request.limit === 1) return { entries: [], hasOlder: true, startCursor: null, epoch: "e1" };
            if (request.direction === "after") {
              calls.firstPromptReads += 1;
              return { entries: [{ turnId: "t0", item: { type: "user_message", text: FIRST_PROMPT } }], hasOlder: false, startCursor: null };
            }
            return { entries: rows, hasOlder: false, startCursor: null };
          },
        },
      }),
    },
    workspaces: {
      archive: async () => ({}),
      ref: () => ({
        async setTitle(title) {
          calls.workspaceSets.push(title ?? "");
          state.workspace = title ?? "";
          return { title };
        },
        refresh: async () => ({ title: state.workspace }),
      }),
    },
  };
  const store = createStateStore(join(folder, "state.json"));
  const retitler = createRetitler({
    settings: async () => ({ ...settingsFallback, ...options.settings }),
    state: store,
    setChatTitle: async (_id, title) => {
      calls.cli.push(title);
      if (options.cliFails) throw new Error("The Paseo command failed: agent not found");
      state.chat = title;
    },
    scratchRoot: folder,
    runModel: options.helperNotice ? undefined : async (_paseo, model, prompt) => {
      calls.models.push({ model, prompt });
      options.modelStarted?.();
      await options.hold;
      if (options.runFails) throw new Error(options.runFails);
      if (prompt.startsWith("You name projects")) {
        if (options.projectFails) throw new Error(options.projectFails);
        return options.projectReply ?? "Shared project name";
      }
      return options.reply ?? NEW_TITLE;
    },
    now: () => new Date("2026-11-13T05:00:00.000Z"),
  });
  return { daemon, retitler, store, state, calls };
}

describe("retitle", () => {
  it.each(["manual", "auto"] as const)("does not apply a late model completion after %s cancellation", async (source) => {
    const controller = new AbortController(); let release!: () => void; let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const w = world({ hold: new Promise<void>((resolve) => { release = resolve; }), modelStarted: started });
    const pending = w.retitler.retitle(w.daemon, { agentId: AGENT, source, signal: controller.signal });
    await entered; controller.abort(); release();
    expect(await pending).toMatchObject({ status: "skipped", reason: "The rename was cancelled." });
    expect(w.calls.cli).toEqual([]); expect(w.calls.workspaceSets).toEqual([]); expect(w.retitler.busy()).toEqual([]);
  });

  it("refuses a rename already cancelled before admission without calling a model", async () => {
    const w = world(); const controller = new AbortController(); controller.abort();
    expect(await w.retitler.retitle(w.daemon, { agentId: AGENT, source: "manual", signal: controller.signal })).toMatchObject({ status: "skipped", reason: "The rename was cancelled." });
    expect(w.calls.models).toEqual([]); expect(w.calls.cli).toEqual([]);
  });

  it("rechecks cancellation after the post-model title refresh", async () => {
    const w = world(); const controller = new AbortController(); const ref = w.daemon.agents.ref;
    let entered!: () => void; const refreshing = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); let reads = 0;
    w.daemon.agents.ref = (id) => { const target = ref(id); return { ...target, refresh: async () => { if (++reads === 2) { entered(); await gate; } return target.refresh(); } }; };
    const pending = w.retitler.retitle(w.daemon, { agentId: AGENT, source: "manual", signal: controller.signal });
    await refreshing; controller.abort(); release();
    expect(await pending).toMatchObject({ status: "skipped", reason: "The rename was cancelled." });
    expect(w.calls.cli).toEqual([]); expect(w.calls.workspaceSets).toEqual([]);
  });

  it("writes the chat first, then leaves the workspace alone when cancelled during the chat census", async () => {
    const w = world(); const controller = new AbortController();
    let entered!: () => void; const checking = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); const list = w.daemon.agents.list;
    w.daemon.agents.list = async (options) => { entered(); await gate; return list(options); };
    const pending = w.retitler.retitle(w.daemon, { agentId: AGENT, source: "manual", signal: controller.signal });
    await checking; controller.abort(); release();
    const result = await pending;
    expect(result.chat).toEqual({ status: "renamed" });
    expect(result.workspace).toEqual({ status: "skipped", detail: "The rename was cancelled." });
    expect(w.calls.cli).toEqual([NEW_TITLE]); expect(w.calls.workspaceSets).toEqual([]);
  });
  it("leaves both titles untouched when the real helper runner receives an idle quota notice", async () => {
    const notice = "You've hit your 5-hour limit · resets 12:50pm (Asia/Jakarta)";
    const w = world({ helperNotice: notice });
    const before = { ...w.state };
    const result = await w.retitler.retitle(w.daemon, { agentId: AGENT, source: "manual", force: true });
    expect(result.status).toBe("failed");
    expect(result.reason).toContain(notice);
    expect(w.state).toEqual(before);
    expect(w.calls.cli).toEqual([]); expect(w.calls.workspaceSets).toEqual([]);
    expect((await w.store.recent())[0]).toMatchObject({ status: "failed", reason: expect.stringContaining(notice) });
  });
  it("renames the chat and its workspace on request and reports what it did", async () => {
    const w = world();
    const result = await w.retitler.retitle(w.daemon, { agentId: AGENT, source: "manual" });
    expect(result).toEqual({
      agentId: AGENT,
      status: "renamed",
      title: NEW_TITLE,
      previous: provisionalTitle(FIRST_PROMPT),
      model: DEFAULT_MODEL,
      messages: 6,
      chat: { status: "renamed" },
      workspace: { status: "renamed" },
      at: "2026-11-13T05:00:00.000Z",
    });
    expect(w.state).toEqual({ chat: NEW_TITLE, workspace: NEW_TITLE });
    expect(await w.store.get(AGENT)).toEqual({ title: NEW_TITLE, workspaceTitle: NEW_TITLE, turns: 0, renamedAt: "2026-11-13T05:00:00.000Z" });
    expect((await w.store.recent()).map((entry) => entry.status)).toEqual(["renamed"]);
  });

  it("names a shared project from every live chat in one summary", async () => {
    const w = world({ chats: [{ id: AGENT, title: "Alpha" }, { id: "b", title: "Beta" }], projectReply: "Shared project work" });
    const result = await w.retitler.retitle(w.daemon, { agentId: AGENT, source: "manual" });
    expect(result.chat).toEqual({ status: "renamed" });
    expect(result.workspace).toEqual({ status: "renamed", detail: "Named from 2 live chats." });
    expect(w.state).toEqual({ chat: NEW_TITLE, workspace: "Shared project work" });
    expect(w.calls.models).toHaveLength(2);
    expect(w.calls.models[1]?.prompt).toContain("You name projects");
    expect(w.calls.models[1]?.prompt).toContain('title: "Beta"');
    expect(await w.store.workspace(WORKSPACE)).toMatchObject({ title: "Shared project work" });
  });

  it("keeps a renamed chat when the project summary fails", async () => {
    const w = world({ chats: [{ id: AGENT, title: "Alpha" }, { id: "b", title: "Beta" }], projectFails: "project model down" });
    const result = await w.retitler.retitle(w.daemon, { agentId: AGENT, source: "manual" });
    expect(result.chat).toEqual({ status: "renamed" });
    expect(result.workspace).toEqual({ status: "failed", detail: "project model down" });
    expect(result.status).toBe("renamed");
    expect(w.state.chat).toBe(NEW_TITLE);
    expect(await w.store.workspace(WORKSPACE)).toBeUndefined();
  });

  it("still names the project when the chat command fails", async () => {
    const w = world({ chats: [{ id: AGENT, title: "Alpha" }, { id: "b", title: "Beta" }], cliFails: true, projectReply: "Shared project work" });
    const result = await w.retitler.retitle(w.daemon, { agentId: AGENT, source: "manual" });
    expect(result.chat).toEqual({ status: "failed", detail: "The Paseo command failed: agent not found" });
    expect(result.workspace).toEqual({ status: "renamed", detail: "Named from 2 live chats." });
    expect(result.status).toBe("renamed");
    expect(w.state.workspace).toBe("Shared project work");
    expect(await w.store.workspace(WORKSPACE)).toMatchObject({ title: "Shared project work" });
  });

  it("on its own, renames a chat whose title is still the one Paseo made from the first prompt", async () => {
    const w = world();
    const result = await w.retitler.retitle(w.daemon, { agentId: AGENT, source: "auto" });
    expect(result.status).toBe("renamed");
    expect(w.calls.firstPromptReads).toBe(1);
  });

  it("on its own, renames a chat whose title it wrote earlier without reading the first prompt", async () => {
    const w = world({ title: "Earlier title from this plugin" });
    await w.store.update(AGENT, (memory) => ({ ...memory, title: "Earlier title from this plugin", turns: 4 }));
    const result = await w.retitler.retitle(w.daemon, { agentId: AGENT, source: "auto" });
    expect(result.status).toBe("renamed");
    expect(w.calls.firstPromptReads).toBe(0);
    expect((await w.store.get(AGENT)).turns).toBe(4); // The automatic queue owns its turn counter.
  });

  it("on its own, leaves a title a person typed alone, says why, and does not call the model", async () => {
    const w = world({ title: "My own notes on the relay" });
    const result = await w.retitler.retitle(w.daemon, { agentId: AGENT, source: "auto" });
    expect(result).toMatchObject({ status: "skipped", previous: "My own notes on the relay" });
    expect(result.reason).toContain("set by you");
    expect(w.calls.models).toEqual([]);
    expect(w.calls.cli).toEqual([]);
    expect(await w.store.recent()).toEqual([]);
  });

  it("on its own, treats a title this plugin wrote and a person then edited as theirs", async () => {
    const w = world({ title: "Earlier title from this plugin (mine)" });
    await w.store.update(AGENT, (memory) => ({ ...memory, title: "Earlier title from this plugin" }));
    expect((await w.retitler.retitle(w.daemon, { agentId: AGENT, source: "auto" })).status).toBe("skipped");
  });

  it("when a person asks, replaces even a title they typed", async () => {
    const w = world({ title: "My own notes on the relay" });
    const result = await w.retitler.retitle(w.daemon, { agentId: AGENT, source: "manual" });
    expect(result).toMatchObject({ status: "renamed", previous: "My own notes on the relay", title: NEW_TITLE });
  });

  it("keeps the title and says so when the model's reply is not usable", async () => {
    const w = world({ reply: "I'm sorry, but I can't write a title for this." });
    const result = await w.retitler.retitle(w.daemon, { agentId: AGENT, source: "manual" });
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("could not be used as a title");
    expect(w.calls.cli).toEqual([]);
    expect(w.state.chat).toBe(provisionalTitle(FIRST_PROMPT));
    expect(await w.store.get(AGENT)).toEqual({ turns: 0 });
    expect((await w.store.recent())[0]?.status).toBe("failed");
  });

  it("reports a model error without throwing", async () => {
    const w = world({ runFails: "model not found" });
    const result = await w.retitler.retitle(w.daemon, { agentId: AGENT, source: "manual" });
    expect(result).toMatchObject({ status: "failed", reason: "model not found" });
  });

  it("does not overwrite a person's rename while the model is running", async () => {
    let release!: () => void;
    const w = world({ hold: new Promise<void>((resolve) => { release = resolve; }) });
    const result = w.retitler.retitle(w.daemon, { agentId: AGENT, source: "auto" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    w.state.chat = "I picked this while it was thinking"; release();
    expect(await result).toMatchObject({ status: "skipped", reason: expect.stringContaining("changed while") }); expect(w.calls.cli).toEqual([]);
  });

  it("does not call the model when both targets are off", async () => {
    const w = world({ settings: { targets: { chat: false, workspace: false } } });
    expect(await w.retitler.retitle(w.daemon, { agentId: AGENT, source: "manual" })).toMatchObject({ status: "skipped" }); expect(w.calls.models).toEqual([]);
  });

  it("skips helper chats, archived chats and chats with no messages", async () => {
    const reasons = {
      helperTitle: (await run({ title: "[Chat titles] naming a chat" })).reason,
      helperLabel: (await run({ labels: { "chat-title": "helper" } })).reason,
      archived: (await run({ archived: true })).reason,
      empty: (await run({ empty: true })).reason,
    };
    expect(reasons).toEqual({
      helperTitle: "This is a helper chat made by this plugin.",
      helperLabel: "This is a helper chat made by this plugin.",
      archived: "The chat is archived.",
      empty: "The chat has no messages yet.",
    });
    async function run(options: Options) {
      const w = world(options);
      const result = await w.retitler.retitle(w.daemon, { agentId: AGENT, source: "manual" });
      expect(result.status).toBe("skipped");
      expect(w.calls.models).toEqual([]);
      return result;
    }
  });

  it("answers a second request for a chat that is already being retitled with a skip, and frees the chat afterwards", async () => {
    let release!: () => void;
    const w = world({ hold: new Promise<void>((resolve) => (release = resolve)) });
    const first = w.retitler.retitle(w.daemon, { agentId: AGENT, source: "manual" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(w.retitler.busy()).toEqual([AGENT]);
    const second = await w.retitler.retitle(w.daemon, { agentId: AGENT, source: "manual" });
    expect(second).toMatchObject({ status: "skipped", reason: "A rename of this chat is already running." });
    release();
    expect((await first).status).toBe("renamed");
    expect(w.retitler.busy()).toEqual([]);
    expect(w.calls.models).toHaveLength(1);
  });

  it("on its own, leaves a workspace alone that a person renamed since this plugin wrote it, but a person asking renames it", async () => {
    const w = world({ title: "Earlier title from this plugin", workspaceTitle: "Their own workspace name" });
    await w.store.update(AGENT, (memory) => ({ ...memory, title: "Earlier title from this plugin", workspaceTitle: "Earlier title from this plugin" }));
    const automatic = await w.retitler.retitle(w.daemon, { agentId: AGENT, source: "auto" });
    expect(automatic.chat).toEqual({ status: "renamed" });
    expect(automatic.workspace).toEqual({ status: "skipped", detail: "The workspace was renamed by you, so automatic renaming leaves it alone." });
    expect(w.calls.workspaceSets).toEqual([]);
    const manual = await w.retitler.retitle(w.daemon, { agentId: AGENT, source: "manual", force: true });
    expect(manual.workspace?.status).toBe("renamed");
  });

  it("reports unchanged, and still restarts the turn count, when the model gives the title the chat already has", async () => {
    const w = world({ title: NEW_TITLE, workspaceTitle: NEW_TITLE });
    await w.store.update(AGENT, (memory) => ({ ...memory, turns: 7 }));
    const result = await w.retitler.retitle(w.daemon, { agentId: AGENT, source: "manual" });
    expect(result.status).toBe("unchanged");
    expect(w.calls.cli).toEqual([]);
    expect(await w.store.get(AGENT)).toMatchObject({ title: NEW_TITLE, workspaceTitle: NEW_TITLE, turns: 0 });
  });

  it("follows the settings: window size, targets and the chosen model", async () => {
    const w = world({ settings: { window: { messages: 4, charsPerMessage: 600 }, targets: { chat: false, workspace: true }, model: { provider: "claude", model: "claude-haiku-5-5" } } });
    const result = await w.retitler.retitle(w.daemon, { agentId: AGENT, source: "manual" });
    expect(result.messages).toBe(4);
    expect(result.model).toBe("claude/claude-haiku-5-5");
    expect(w.calls.models[0]?.prompt).toContain("message three");
    expect(w.calls.models[0]?.prompt).not.toContain("message two");
    expect(w.calls.models[0]?.model).toMatchObject({ provider: "claude", model: "claude-haiku-5-5", thinking: "off", mode: "plan" });
    expect(result.chat).toEqual({ status: "skipped", detail: "Turned off in the settings." });
    expect(result.workspace).toEqual({ status: "renamed" });
    expect(w.calls.cli).toEqual([]);
  });

  it("says so when the chosen provider is not available, without asking any model", async () => {
    const w = world({ settings: { model: { provider: "codex", model: "gpt-x" } } });
    const result = await w.retitler.retitle(w.daemon, { agentId: AGENT, source: "manual" });
    expect(result.status).toBe("failed");
    expect(result.reason).toContain('The provider "Codex" is not available');
    expect(w.calls.models).toEqual([]);
  });

  it("never throws, even when the daemon cannot be reached", async () => {
    const w = world({ refreshFails: true });
    expect(await w.retitler.retitle(w.daemon, { agentId: AGENT, source: "manual" })).toMatchObject({ status: "failed", reason: "daemon unreachable" });
    expect(w.retitler.busy()).toEqual([]);
  });

  it("reports a chat the daemon does not know as failed", async () => {
    const w = world();
    expect(await w.retitler.retitle(w.daemon, { agentId: "no-such-chat", source: "manual" })).toMatchObject({ status: "failed", reason: "The chat was not found." });
  });
});

describe("overview and test", () => {
  it("does not return a sample title from a model that completes after cancellation", async () => {
    const controller = new AbortController(); let release!: () => void; let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const w = world({ hold: new Promise<void>((resolve) => { release = resolve; }), modelStarted: started });
    const pending = w.retitler.test(w.daemon, { signal: controller.signal }).catch((error: Error) => error);
    await entered; controller.abort(); release();
    expect(await pending).toMatchObject({ message: "The rename was cancelled." });
    expect(w.calls.cli).toEqual([]); expect(w.calls.workspaceSets).toEqual([]);
  });

  it("does not generate an already-cancelled sample", async () => {
    const w = world(); const controller = new AbortController(); controller.abort();
    await expect(w.retitler.test(w.daemon, { signal: controller.signal })).rejects.toThrow("cancelled");
    expect(w.calls.models).toEqual([]);
  });
  it("lists recent results newest first, the chats in progress, and the model used by default", async () => {
    const w = world({ title: "My own notes" });
    await w.retitler.retitle(w.daemon, { agentId: AGENT, source: "manual" });
    await w.retitler.retitle(w.daemon, { agentId: "no-such-chat", source: "manual" });
    const overview = await w.retitler.overview(w.daemon);
    expect(overview.recent.map((entry) => entry.status)).toEqual(["failed", "renamed"]);
    expect(overview.busy).toEqual([]);
    expect(overview.defaultModel).toBe(DEFAULT_MODEL);
  });

  it("writes a title for a sample chat with the chosen model and says which model and how long", async () => {
    const w = world({ settings: { model: { provider: "claude", model: "claude-haiku-5-5" } } });
    const result = await w.retitler.test(w.daemon);
    expect(result).toMatchObject({ title: NEW_TITLE, model: "claude/claude-haiku-5-5" });
    expect(result.ms).toBeGreaterThanOrEqual(0);
    for (const message of SAMPLE_CHAT) expect(w.calls.models[0]?.prompt).toContain(message.text);
    expect(w.calls.cli).toEqual([]);
  });

  it("fails the test when the model's reply is unusable", async () => {
    const w = world({ reply: "..." });
    await expect(w.retitler.test(w.daemon)).rejects.toThrow("could not be used as a title");
  });
});
