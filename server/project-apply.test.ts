import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { settingsFallback, type ChatTitleValues } from "../shared/settings";
import type { CensusAgent } from "./census";
import { applyProjectTitle, type ProjectSource } from "./project-apply";
import { createProjectTitles } from "./project-title";
import { createStateStore } from "./state";

const AGENT = "a";
const WORKSPACE = "wks-1";
const SHARED: CensusAgent[] = [
  { id: AGENT, workspaceId: WORKSPACE, title: "Alpha" },
  { id: "b", workspaceId: WORKSPACE, title: "Beta" },
];

let folder: string;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "chat-title-project-apply-"));
});
afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

interface Options {
  chats?: CensusAgent[];
  workspaceTitle?: string | null;
  settings?: Partial<ChatTitleValues>;
  reply?: string;
  refusePages?: boolean;
  setFails?: boolean;
  keepOldTitle?: boolean;
  duringModel?: (workspace: { title: string | null }) => void;
  firstPrompts?: Record<string, string>;
}

function world(options: Options = {}) {
  const workspace = { title: options.workspaceTitle === undefined ? "Old project" : options.workspaceTitle };
  const calls = { list: 0, prompts: [] as string[], sets: [] as string[], refreshes: 0 };
  const rows = options.chats ?? [{ id: AGENT, workspaceId: WORKSPACE, title: "Alpha" }];
  const source: ProjectSource = {
    agents: {
      list: async () => {
        calls.list += 1;
        if (options.refusePages) return { entries: [], pageInfo: { hasMore: true, nextCursor: "same" } };
        return { entries: rows.map((agent) => ({ agent })), pageInfo: { hasMore: false } };
      },
      ref: (id) => ({
        refresh: async () => ({ agent: { id, title: rows.find((agent) => agent.id === id)?.title ?? null } }),
        timeline: {
          refetch: async (request) => {
            if (request.direction === "tail") return { entries: [], hasOlder: true, startCursor: null, epoch: "e1" };
            const prompt = options.firstPrompts?.[id];
            return {
              entries: prompt ? [{ turnId: "t0", item: { type: "user_message", text: prompt } }] : [],
              hasOlder: false,
              startCursor: null,
            };
          },
        },
      }),
    },
    workspaces: {
      ref: () => ({
        refresh: async () => {
          calls.refreshes += 1;
          return { title: workspace.title };
        },
        setTitle: async (title) => {
          if (options.setFails) throw new Error("workspace write refused");
          calls.sets.push(title);
          workspace.title = options.keepOldTitle ? workspace.title : title;
          return { title: workspace.title };
        },
      }),
    },
  };
  const state = createStateStore(join(folder, "state.json"));
  const deps = {
    settings: { ...settingsFallback, ...options.settings },
    state,
    titles: createProjectTitles(),
    runModel: async (_model: unknown, prompt: string) => {
      calls.prompts.push(prompt);
      options.duringModel?.(workspace);
      return options.reply ?? "Shared release work";
    },
    model: { provider: "opencode", model: "cheap" },
    now: () => new Date("2026-11-13T05:00:00.000Z"),
  };
  return { source, deps, state, workspace, calls };
}

const input = (overrides: Partial<Parameters<typeof applyProjectTitle>[2]> = {}) => ({
  agentId: AGENT,
  chatTitle: "Fresh chat title",
  workspaceId: WORKSPACE,
  source: "manual" as const,
  ...overrides,
});

describe("applyProjectTitle", () => {
  it("does nothing when the workspace target is off, without listing chats or calling a model", async () => {
    const w = world({ settings: { targets: { chat: true, workspace: false } } });
    expect(await applyProjectTitle(w.source, w.deps, input())).toEqual({ workspace: { status: "skipped", detail: "Turned off in the settings." }, chats: 0 });
    expect(w.calls.list).toBe(0);
    expect(w.calls.prompts).toEqual([]);
  });

  it("skips a chat with no workspace", async () => {
    const w = world();
    expect((await applyProjectTitle(w.source, w.deps, input({ workspaceId: null }))).workspace).toEqual({ status: "skipped", detail: "The chat has no workspace." });
  });

  it("skips rather than guesses when the agent directory cannot be read to the end", async () => {
    const w = world({ refusePages: true });
    const result = await applyProjectTitle(w.source, w.deps, input());
    expect(result.workspace.status).toBe("skipped");
    expect(result.workspace.detail).toContain("too many chats");
    expect(w.calls.prompts).toEqual([]);
  });

  it("reuses the chat title for a single live chat without another model run", async () => {
    const w = world();
    const result = await applyProjectTitle(w.source, w.deps, input({ chatTitle: "Fresh chat title" }));
    expect(result).toEqual({ workspace: { status: "renamed" }, title: "Fresh chat title", chats: 1 });
    expect(w.calls.sets).toEqual(["Fresh chat title"]);
    expect(w.calls.prompts).toEqual([]);
    expect(await w.state.workspace(WORKSPACE)).toEqual({ title: "Fresh chat title", at: "2026-11-13T05:00:00.000Z" });
  });

  it("summarises two live chats and says how many it used", async () => {
    const w = world({ chats: [{ id: AGENT, workspaceId: WORKSPACE, title: "Alpha" }, { id: "b", workspaceId: WORKSPACE, title: "Beta" }] });
    const result = await applyProjectTitle(w.source, w.deps, input());
    expect(result).toEqual({ workspace: { status: "renamed", detail: "Named from 2 live chats." }, title: "Shared release work", chats: 2 });
    expect(w.calls.prompts).toHaveLength(1);
    expect(w.calls.prompts[0]).toContain('title: "Beta"');
    expect(w.calls.sets).toEqual(["Shared release work"]);
  });

  it("says how many of a large project's chats the summary used", async () => {
    const chats = Array.from({ length: 15 }, (_, index) => ({ id: index === 0 ? AGENT : `chat-${index}`, workspaceId: WORKSPACE, title: `Chat ${index}` }));
    const w = world({ chats });
    const result = await applyProjectTitle(w.source, w.deps, input());
    expect(result.chats).toBe(15);
    expect(result.workspace.detail).toBe("Named from 12 of 15 live chats.");
  });

  it("asks for a project-wide name when more than two chats are live", async () => {
    const w = world({ chats: [
      { id: AGENT, workspaceId: WORKSPACE, title: "Alpha" },
      { id: "b", workspaceId: WORKSPACE, title: "Beta" },
      { id: "c", workspaceId: WORKSPACE, title: "Gamma" },
    ] });
    const result = await applyProjectTitle(w.source, w.deps, input());
    expect(result.chats).toBe(3);
    expect(w.calls.prompts[0]).toContain("Name the project from all 3 chats, not any single chat.");
    expect(result.workspace.detail).toBe("Named from 3 live chats.");
  });

  it("leaves a person's project name alone automatically, but a manual rename replaces it", async () => {
    const automatic = world({ chats: SHARED, workspaceTitle: "My project name" });
    await automatic.state.setWorkspace(WORKSPACE, "Earlier plugin name");
    const held = await applyProjectTitle(automatic.source, automatic.deps, input({ source: "auto" }));
    expect(held.workspace).toEqual({ status: "skipped", detail: "The workspace was renamed by you, so automatic renaming leaves it alone." });
    expect(automatic.calls.prompts).toEqual([]);
    expect(automatic.calls.sets).toEqual([]);

    const manual = world({ chats: SHARED, workspaceTitle: "My project name" });
    await manual.state.setWorkspace(WORKSPACE, "Earlier plugin name");
    expect((await applyProjectTitle(manual.source, manual.deps, input())).workspace.status).toBe("renamed");
    expect(manual.calls.sets).toEqual(["Shared release work"]);
  });

  it("seeds the hold from the older per-chat workspace memory", async () => {
    const w = world({ workspaceTitle: "My project name" });
    await w.state.update(AGENT, (memory) => ({ ...memory, workspaceTitle: "Earlier plugin name" }));
    expect((await applyProjectTitle(w.source, w.deps, input({ source: "auto" }))).workspace.status).toBe("skipped");
    expect(w.calls.prompts).toEqual([]);
  });

  it("does not overwrite a project renamed while the summary was running", async () => {
    const w = world({ chats: SHARED, duringModel: (workspace) => { workspace.title = "Picked during the model run"; } });
    const result = await applyProjectTitle(w.source, w.deps, input({ source: "auto" }));
    expect(result.workspace).toEqual({ status: "skipped", detail: "The workspace was renamed while the project title was being written, so it was left alone." });
    expect(w.calls.sets).toEqual([]);
  });

  it("reports an already-correct project name as unchanged and remembers it", async () => {
    const w = world({ chats: SHARED, workspaceTitle: "Shared release work" });
    const result = await applyProjectTitle(w.source, w.deps, input());
    expect(result.workspace).toEqual({ status: "unchanged" });
    expect(w.calls.sets).toEqual([]);
    expect(await w.state.workspace(WORKSPACE)).toEqual({ title: "Shared release work", at: "2026-11-13T05:00:00.000Z" });
  });

  it("reports a daemon that does not keep the new name as failed and does not remember it", async () => {
    const w = world({ keepOldTitle: true });
    const result = await applyProjectTitle(w.source, w.deps, input());
    expect(result.workspace).toEqual({ status: "failed", detail: "The daemon did not keep the new project name." });
    expect(await w.state.workspace(WORKSPACE)).toBeUndefined();
  });

  it("reports a throwing write without throwing and does not remember the name", async () => {
    const w = world({ setFails: true });
    const result = await applyProjectTitle(w.source, w.deps, input());
    expect(result.workspace).toEqual({ status: "failed", detail: "workspace write refused" });
    expect(await w.state.workspace(WORKSPACE)).toBeUndefined();
  });

  it("includes a chat the directory has not listed yet", async () => {
    const w = world({ chats: [{ id: "b", workspaceId: WORKSPACE, title: "Beta" }] });
    const result = await applyProjectTitle(w.source, w.deps, input({ chatTitle: "Fresh alpha" }));
    expect(result.chats).toBe(2);
    expect(w.calls.prompts[0]).toContain('title: "Fresh alpha"');
    expect(w.calls.prompts[0]).toContain('title: "Beta"');
  });

  it("stops before reading anything when the rename was cancelled", async () => {
    const w = world();
    const controller = new AbortController();
    controller.abort();
    expect((await applyProjectTitle(w.source, w.deps, input({ signal: controller.signal }))).workspace).toEqual({ status: "skipped", detail: "The rename was cancelled." });
    expect(w.calls.list).toBe(0);
  });
});
