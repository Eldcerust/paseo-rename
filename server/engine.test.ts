import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { settingsFallback, windowDefaults } from "../shared/settings";
import { sanitizeTitle } from "../shared/title";
import type { TimelineEntryLike } from "../shared/window";
import { applyChatTitle } from "./apply";
import type { ResolvedModel } from "./catalog";
import { runTitleModel, type HelperAgent, type RunnerPaseo } from "./llm";
import { readWindow, type TimelinePage, type TimelineSource } from "./messages";
import { applyProjectTitle, type ProjectSource } from "./project-apply";
import { createProjectTitles } from "./project-title";
import { buildTitlePrompt } from "./prompt";
import { createStateStore } from "./state";

const MODEL: ResolvedModel = { provider: "claude", model: "claude-haiku-5-5", thinking: "off", mode: "plan" };
const CHAT = { id: "chat-1", workspaceId: "wks-chat" };

let scratchRoot: string;
beforeEach(() => {
  scratchRoot = mkdtempSync(join(tmpdir(), "chat-title-test-root-"));
});
afterEach(() => {
  rmSync(scratchRoot, { recursive: true, force: true });
});

const user = (text: string, turnId: string): TimelineEntryLike => ({ turnId, item: { type: "user_message", text } });
const reply = (text: string, turnId: string): TimelineEntryLike => ({ turnId, item: { type: "assistant_message", text } });
const tool = (turnId: string): TimelineEntryLike => ({ turnId, item: { type: "tool_call" } });

function chatOf(turns: number, toolRowsPerTurn: number): TimelineEntryLike[] {
  const rows: TimelineEntryLike[] = [];
  for (let turn = 1; turn <= turns; turn++) {
    rows.push(user(`Question ${turn}`, `t${turn}`));
    for (let i = 0; i < toolRowsPerTurn; i++) rows.push(tool(`t${turn}`));
    rows.push(reply(`Answer ${turn}`, `t${turn}`));
  }
  return rows;
}

function pagesOf(rows: TimelineEntryLike[], size: number): TimelinePage[] {
  const pages: TimelinePage[] = [];
  for (let end = rows.length; end > 0; end -= size) {
    const start = Math.max(0, end - size);
    pages.push({ entries: rows.slice(start, end), hasOlder: start > 0, startCursor: { epoch: "e", seq: start } });
  }
  return pages;
}

/** A daemon: the chat's timeline, a helper whose answer is computed from the prompt it was given, and a chat plus workspace to rename. */
function daemon(rows: TimelineEntryLike[], answer: (prompt: string) => string, pageSize = 60) {
  const pages = pagesOf(rows, pageSize);
  let call = 0;
  const state = { chatTitle: "/unlazy tree 5 develop a plugin too that would take the 10 o", workspaceTitle: "Add chat auto-rename plugin" };
  const seen = { prompts: [] as string[], cli: [] as string[] };
  const timeline: TimelineSource = { agents: { ref: () => ({ timeline: { refetch: async () => pages[call++] ?? { entries: [], hasOlder: false, startCursor: null } } }) } };
  const runner: RunnerPaseo = {
    providers: { snapshot: async () => ({ entries: [] }), listModels: async () => ({ models: [] }), listModes: async () => ({ modes: [] }) },
    agents: {
      async create(options) {
        seen.prompts.push(options.prompt);
        const helper: HelperAgent = {
          id: "helper",
          workspaceId: "wks-helper",
          pendingPermissions: [],
          async refresh() {},
          waitForFinish: async () => ({ status: "idle", lastMessage: answer(options.prompt) }),
          async respondToPermission() {},
          archive: async () => ({}),
          timeline: { refetch: async () => ({ entries: [] }) },
        };
        return helper;
      },
    },
    workspaces: { archive: async () => ({}) },
  };
  const apply: ProjectSource = {
    agents: {
      list: async () => ({ entries: [{ agent: { id: CHAT.id, workspaceId: CHAT.workspaceId, title: state.chatTitle } }], pageInfo: { nextCursor: null, hasMore: false } }),
      ref: () => ({
        refresh: async () => ({ agent: { id: CHAT.id, title: state.chatTitle } }),
        timeline: { refetch: async () => ({ entries: [], hasOlder: false, startCursor: null }) },
      }),
    },
    workspaces: {
      ref: () => ({
        async setTitle(title) {
          state.workspaceTitle = title ?? "";
          return { title };
        },
        refresh: async () => ({ title: state.workspaceTitle }),
      }),
    },
  };
  const setChatTitle = async (_id: string, title: string) => {
    seen.cli.push(title);
    state.chatTitle = title;
  };
  return { timeline, runner, apply, setChatTitle, state, seen };
}

/** The engine, assembled from its parts the way the retitle leaf is specified to call them. */
async function run(d: ReturnType<typeof daemon>) {
  const window = await readWindow(d.timeline, CHAT.id, windowDefaults);
  const currentTitle = d.state.chatTitle;
  const prompt = buildTitlePrompt({ messages: window.messages, currentTitle });
  const title = sanitizeTitle(await runTitleModel(d.runner, MODEL, prompt, { scratchRoot }));
  if (!title) return { title, window, result: undefined };
  const chat = await applyChatTitle({ paseo: d.apply, setChatTitle: d.setChatTitle }, { agentId: CHAT.id, title, currentChatTitle: currentTitle, enabled: true });
  const state = createStateStore(join(scratchRoot, "state.json"));
  const project = await applyProjectTitle(
    d.apply,
    {
      settings: settingsFallback,
      state,
      titles: createProjectTitles(),
      runModel: async () => { throw new Error("a one-chat project must reuse the chat title"); },
      model: MODEL,
      now: () => new Date("2026-11-13T05:00:00.000Z"),
    },
    { agentId: CHAT.id, chatTitle: title, workspaceId: CHAT.workspaceId, source: "manual" },
  );
  return { title, window, result: { chat, workspace: project.workspace } };
}

describe("engine: timeline to applied title", () => {
  it("shows the model only the last ten messages and the current title, and applies what it answers to the chat and its workspace", async () => {
    const d = daemon(chatOf(8, 30), () => "Rename chats from recent messages");
    const { title, window, result } = await run(d);
    expect(window.messages).toHaveLength(10);
    const prompt = d.seen.prompts[0]!;
    expect(prompt).toContain("[user] Question 4");
    expect(prompt).toContain("[assistant] Answer 8");
    expect(prompt).not.toContain("Question 3");
    expect(prompt).not.toContain("Answer 3");
    expect(prompt).toContain('currently titled: "/unlazy tree 5 develop a plugin too that would take the 10 o"');
    expect(title).toBe("Rename chats from recent messages");
    expect(result).toEqual({ chat: { status: "renamed" }, workspace: { status: "renamed" } });
    expect(d.state).toEqual({ chatTitle: title, workspaceTitle: title });
  });

  it("leaves the chat's own title untouched when the model says the current title still fits", async () => {
    const d = daemon(chatOf(3, 5), (prompt) => /currently titled: "(.*)"/.exec(prompt)?.[1] ?? "");
    const { result } = await run(d);
    expect(result?.chat).toEqual({ status: "unchanged" });
    expect(d.seen.cli).toEqual([]);
  });

  it("applies nothing when the model's reply is not a usable title", async () => {
    const d = daemon(chatOf(3, 5), () => "I'm sorry, but I can't write a title for this.");
    const { title, result } = await run(d);
    expect(title).toBeUndefined();
    expect(result).toBeUndefined();
    expect(d.seen.cli).toEqual([]);
    expect(d.state.chatTitle).toBe("/unlazy tree 5 develop a plugin too that would take the 10 o");
  });

  it("still finds ten messages in a chat that is almost all tool rows, by paging back", async () => {
    const d = daemon(chatOf(40, 80), () => "Long agent session");
    const { window } = await run(d);
    expect(window.messages).toHaveLength(10);
    expect(d.seen.prompts[0]).toContain("[assistant] Answer 40");
    expect(d.seen.prompts[0]).toContain("[user] Question 36");
  });

  it("keeps a short chat whole", async () => {
    const d = daemon(chatOf(1, 2), () => "First question");
    const { window } = await run(d);
    expect(window.messages.map((message) => message.text)).toEqual(["Question 1", "Answer 1"]);
    expect(window.reachedStart).toBe(true);
  });
});
