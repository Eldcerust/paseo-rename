import { describe, expect, it } from "vitest";
import { applyTitle, type ApplyInput, type ApplyPaseo } from "./apply";

type AgentRow = { id: string; workspaceId?: string | null; archivedAt?: string | null };

interface Options {
  /** Pages of the agent list, in order. */
  pages?: AgentRow[][];
  hasMoreOnLastPage?: boolean;
  listFails?: boolean;
  workspaceTitle?: string | null;
  workspaceSetFails?: boolean;
  workspaceKeepsOld?: boolean;
  chatTitle?: string | null;
  cliFails?: boolean;
  cliNoEffect?: boolean;
}

function fake(options: Options = {}) {
  const state = { chat: options.chatTitle ?? "old chat title", workspace: options.workspaceTitle === undefined ? "old workspace title" : options.workspaceTitle };
  const log = { cli: [] as [string, string][], workspaceSets: [] as (string | null)[], listCalls: [] as { page: { limit: number; cursor?: string } }[] };
  const pages = options.pages ?? [[{ id: "me", workspaceId: "wks-1" }]];
  const paseo: ApplyPaseo = {
    agents: {
      async list(request) {
        log.listCalls.push(request);
        if (options.listFails) throw new Error("the daemon is busy");
        const index = log.listCalls.length - 1;
        const entries = (pages[index] ?? []).map((agent) => ({ agent }));
        const last = index >= pages.length - 1;
        const more = !last || options.hasMoreOnLastPage === true;
        return { entries, pageInfo: { nextCursor: more ? `cursor-${index + 1}` : null, hasMore: more } };
      },
      ref: () => ({ refresh: async () => ({ agent: { title: state.chat } }) }),
    },
    workspaces: {
      ref: () => ({
        async setTitle(title) {
          log.workspaceSets.push(title);
          if (options.workspaceSetFails) throw new Error("workspace rename refused");
          if (!options.workspaceKeepsOld) state.workspace = title;
          return { title: state.workspace };
        },
        refresh: async () => ({ title: state.workspace }),
      }),
    },
  };
  const setChatTitle = async (agentId: string, title: string) => {
    log.cli.push([agentId, title]);
    if (options.cliFails) throw new Error("The Paseo command failed: agent not found");
    if (!options.cliNoEffect) state.chat = title;
  };
  return { deps: { paseo, setChatTitle }, log, state };
}

const input = (overrides: Partial<ApplyInput> = {}): ApplyInput => ({
  agentId: "me",
  workspaceId: "wks-1",
  title: "Rename chats from recent messages",
  currentChatTitle: "old chat title",
  targets: { chat: true, workspace: true },
  ...overrides,
});

describe("applyTitle", () => {
  it("does not admit either title write when already cancelled", async () => {
    const { deps, log, state } = fake(); const controller = new AbortController(); controller.abort();
    const before = { ...state };
    const result = await applyTitle(deps, input({ signal: controller.signal }));
    expect(result).toEqual({ chat: { status: "skipped", detail: "The rename was cancelled." }, workspace: { status: "skipped", detail: "The rename was cancelled." } });
    expect(log.cli).toEqual([]); expect(log.workspaceSets).toEqual([]); expect(log.listCalls).toEqual([]); expect(state).toEqual(before);
  });

  it("does not start a workspace write after cancellation during its title refresh", async () => {
    const { deps, log } = fake(); const controller = new AbortController(); const ref = deps.paseo.workspaces.ref;
    let entered!: () => void; const refreshing = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    deps.paseo.workspaces.ref = (id) => { const workspace = ref(id); return { ...workspace, refresh: async () => { entered(); await gate; return workspace.refresh(); } }; };
    const pending = applyTitle(deps, input({ signal: controller.signal, targets: { chat: false, workspace: true } }));
    await refreshing; controller.abort(); release();
    expect((await pending).workspace).toEqual({ status: "skipped", detail: "The rename was cancelled." });
    expect(log.workspaceSets).toEqual([]); expect(log.cli).toEqual([]);
  });

  it("renames the chat and, when it is alone there, its workspace, and checks the daemon shows both", async () => {
    const { deps, log, state } = fake();
    const result = await applyTitle(deps, input());
    expect(result).toEqual({ chat: { status: "renamed" }, workspace: { status: "renamed" } });
    expect(log.cli).toEqual([["me", "Rename chats from recent messages"]]);
    expect(log.workspaceSets).toEqual(["Rename chats from recent messages"]);
    expect(state.chat).toBe("Rename chats from recent messages");
  });

  it("does not run the command when the chat already has the title", async () => {
    const { deps, log } = fake();
    const result = await applyTitle(deps, input({ currentChatTitle: "Rename chats from recent messages" }));
    expect(result.chat).toEqual({ status: "unchanged" });
    expect(log.cli).toEqual([]);
  });

  it("leaves the chat alone when that target is off, and still renames the workspace", async () => {
    const { deps, log } = fake();
    const result = await applyTitle(deps, input({ targets: { chat: false, workspace: true } }));
    expect(result.chat).toEqual({ status: "skipped", detail: "Turned off in the settings." });
    expect(result.workspace.status).toBe("renamed");
    expect(log.cli).toEqual([]);
  });

  it("leaves the workspace alone when that target is off, without even listing chats", async () => {
    const { deps, log } = fake();
    const result = await applyTitle(deps, input({ targets: { chat: true, workspace: false } }));
    expect(result.workspace).toEqual({ status: "skipped", detail: "Turned off in the settings." });
    expect(result.chat.status).toBe("renamed");
    expect(log.listCalls).toEqual([]);
  });

  it("skips the workspace when another unarchived chat lives in it, ignoring archived chats and other workspaces", async () => {
    const { deps, log } = fake({ pages: [[{ id: "me", workspaceId: "wks-1" }, { id: "gone", workspaceId: "wks-1", archivedAt: "2026-11-01T00:00:00Z" }, { id: "elsewhere", workspaceId: "wks-2" }, { id: "partner", workspaceId: "wks-1" }]] });
    const result = await applyTitle(deps, input());
    expect(result.workspace).toEqual({ status: "skipped", detail: "Another chat uses this workspace, so its name was left alone." });
    expect(log.workspaceSets).toEqual([]);
    expect(result.chat.status).toBe("renamed");
  });

  it("says how many other chats share the workspace", async () => {
    const { deps } = fake({ pages: [[{ id: "a", workspaceId: "wks-1" }, { id: "b", workspaceId: "wks-1" }]] });
    expect((await applyTitle(deps, input())).workspace.detail).toBe("2 other chats use this workspace, so its name was left alone.");
  });

  it("reads every page of chats before deciding the workspace is not shared", async () => {
    const { deps, log } = fake({ pages: [[{ id: "me", workspaceId: "wks-1" }], [{ id: "late partner", workspaceId: "wks-1" }]] });
    const result = await applyTitle(deps, input());
    expect(result.workspace.status).toBe("skipped");
    expect(log.listCalls.map((call) => call.page)).toEqual([{ limit: 200 }, { limit: 200, cursor: "cursor-1" }]);
  });

  it("does not guess when there are too many pages of chats to read", async () => {
    const { deps, log } = fake({ pages: Array.from({ length: 10 }, () => [] as AgentRow[]), hasMoreOnLastPage: true });
    const result = await applyTitle(deps, input());
    expect(result.workspace).toEqual({ status: "skipped", detail: "There are too many chats to check whether the workspace is shared." });
    expect(log.listCalls).toHaveLength(10);
  });

  it("skips the workspace for a chat that has none", async () => {
    const { deps } = fake();
    expect((await applyTitle(deps, input({ workspaceId: null }))).workspace).toEqual({ status: "skipped", detail: "The chat has no workspace." });
  });

  it("reports a workspace that already has the title as unchanged and does not set it again", async () => {
    const { deps, log } = fake({ workspaceTitle: "Rename chats from recent messages" });
    expect((await applyTitle(deps, input())).workspace).toEqual({ status: "unchanged" });
    expect(log.workspaceSets).toEqual([]);
  });

  it("reports a failed command for the chat and still renames the workspace", async () => {
    const { deps } = fake({ cliFails: true });
    const result = await applyTitle(deps, input());
    expect(result.chat).toEqual({ status: "failed", detail: "The Paseo command failed: agent not found" });
    expect(result.workspace.status).toBe("renamed");
  });

  it("does not call a rename done when the daemon does not show the new chat title", async () => {
    const { deps } = fake({ cliNoEffect: true });
    const result = await applyTitle(deps, input());
    expect(result.chat).toEqual({ status: "failed", detail: "The command finished, but the daemon does not show the new title." });
  });

  it("reports a failed workspace rename and still renames the chat", async () => {
    const { deps } = fake({ workspaceSetFails: true });
    const result = await applyTitle(deps, input());
    expect(result.workspace).toEqual({ status: "failed", detail: "workspace rename refused" });
    expect(result.chat.status).toBe("renamed");
  });

  it("does not call a workspace rename done when the daemon kept the old title", async () => {
    const { deps } = fake({ workspaceKeepsOld: true });
    expect((await applyTitle(deps, input())).workspace).toEqual({ status: "failed", detail: "The daemon did not keep the new workspace title." });
  });

  it("does not rename the workspace when the list of chats cannot be read", async () => {
    const { deps, log } = fake({ listFails: true });
    const result = await applyTitle(deps, input());
    expect(result.workspace).toEqual({ status: "failed", detail: "the daemon is busy" });
    expect(log.workspaceSets).toEqual([]);
  });
});
