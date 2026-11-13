import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { settingsFallback } from "../shared/settings";
import { sanitizeTitle } from "../shared/title";
import { applyChatTitle } from "./apply";
import type { ResolvedModel } from "./catalog";
import { renameAgentWithCli, type CliEnvironment, type Invocation, type RunCli } from "./cli";
import { runTitleModel, type HelperAgent, type RunnerPaseo } from "./llm";
import { applyProjectTitle, type ProjectSource } from "./project-apply";
import { createProjectTitles } from "./project-title";
import { createStateStore } from "./state";

const MODEL: ResolvedModel = { provider: "opencode", model: "opencode-go/deepseek-v4.1-flash", thinking: "low", mode: "plan" };
const CHAT = { id: "chat-1", workspaceId: "wks-chat" };
const HELPER_WORKSPACE = "wks-helper";

let scratchRoot: string;
beforeEach(() => {
  scratchRoot = mkdtempSync(join(tmpdir(), "chat-title-test-root-"));
});
afterEach(() => {
  rmSync(scratchRoot, { recursive: true, force: true });
});

/** A daemon with a helper that answers `reply`, and one chat in its own workspace. */
function daemon(reply: string, options: { cliFails?: boolean } = {}) {
  const state = { chatTitle: "old chat title", workspaceTitle: "old workspace title" };
  const log = { archivedAgents: 0, archivedWorkspaces: [] as string[], cli: [] as string[], renamedWorkspaces: [] as string[] };
  const helper: HelperAgent = {
    id: "helper-1",
    workspaceId: HELPER_WORKSPACE,
    pendingPermissions: [],
    async refresh() {},
    waitForFinish: async () => ({ status: "idle", lastMessage: reply }),
    async respondToPermission() {},
    async archive() {
      log.archivedAgents += 1;
      return {};
    },
    timeline: { refetch: async () => ({ entries: [] }) },
  };
  const runner: RunnerPaseo = {
    providers: { snapshot: async () => ({ entries: [] }), listModels: async () => ({ models: [] }), listModes: async () => ({ modes: [] }) },
    agents: { create: async () => helper },
    workspaces: {
      async archive(id) {
        log.archivedWorkspaces.push(id);
        return {};
      },
    },
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
          log.renamedWorkspaces.push(title ?? "");
          state.workspaceTitle = title ?? "";
          return { title };
        },
        refresh: async () => ({ title: state.workspaceTitle }),
      }),
    },
  };
  const setChatTitle = async (_agentId: string, title: string) => {
    log.cli.push(title);
    if (options.cliFails) throw new Error("The Paseo command failed: agent not found");
    state.chatTitle = title;
  };
  return { runner, apply, setChatTitle, state, log };
}

async function generateAndApply(d: ReturnType<typeof daemon>) {
  const reply = await runTitleModel(d.runner, MODEL, "the prompt", { scratchRoot });
  const title = sanitizeTitle(reply);
  if (!title) throw new Error(`unusable reply: ${reply}`);
  const chat = await applyChatTitle({ paseo: d.apply, setChatTitle: d.setChatTitle }, { agentId: CHAT.id, title, currentChatTitle: d.state.chatTitle, enabled: true });
  const project = await applyProjectTitle(
    d.apply,
    {
      settings: settingsFallback,
      state: createStateStore(join(scratchRoot, "state.json")),
      titles: createProjectTitles(),
      runModel: async () => { throw new Error("a one-chat project must reuse the chat title"); },
      model: MODEL,
    },
    { agentId: CHAT.id, chatTitle: title, workspaceId: CHAT.workspaceId, source: "manual" },
  );
  return { title, result: { chat, workspace: project.workspace } };
}

describe("model reply to applied title", () => {
  it("turns a decorated model reply into a clean title on both the chat and its workspace", async () => {
    const d = daemon('Title: "**Rename chats from recent messages.**"\n\nThis covers the plugin discussion.');
    const { title, result } = await generateAndApply(d);
    expect(title).toBe("Rename chats from recent messages");
    expect(result).toEqual({ chat: { status: "renamed" }, workspace: { status: "renamed" } });
    expect(d.state).toEqual({ chatTitle: title, workspaceTitle: title });
  });

  it("archives only the helper's workspace and renames only the chat's own", async () => {
    const d = daemon("Rename chats from recent messages");
    await generateAndApply(d);
    expect(d.log.archivedAgents).toBe(1);
    expect(d.log.archivedWorkspaces).toEqual([HELPER_WORKSPACE]);
    expect(d.log.renamedWorkspaces).toEqual(["Rename chats from recent messages"]);
  });

  it("does not let a failed chat rename undo or block the workspace rename, and the helper is still archived", async () => {
    const d = daemon("Rename chats from recent messages", { cliFails: true });
    const { result } = await generateAndApply(d);
    expect(result.chat).toEqual({ status: "failed", detail: "The Paseo command failed: agent not found" });
    expect(result.workspace).toEqual({ status: "renamed" });
    expect(d.state.chatTitle).toBe("old chat title");
    expect(d.log.archivedAgents).toBe(1);
  });

  it("hands the sanitised title to the real command finder as one untouched argument", async () => {
    const app = "C:\\Program Files\\Paseo\\Paseo.exe";
    const resources = "C:\\Program Files\\Paseo\\resources";
    const files = new Set([app, `${resources}\\app.asar`, `${resources}\\app.asar.unpacked\\dist\\daemon\\node-entrypoint-runner.js`]);
    const environment: CliEnvironment = { platform: "win32", execPath: app, env: {}, exists: (path) => files.has(path) };
    const invocations: Invocation[] = [];
    const run: RunCli = async (invocation) => {
      invocations.push(invocation);
      return { status: 0, stdout: "", stderr: "" };
    };
    const d = daemon('Fix "archive" & 100% | done');
    // The fake daemon only shows the new title once the command has been run for it.
    const setChatTitle = async (agentId: string, title: string) => {
      await renameAgentWithCli(environment, run, agentId, title);
      d.state.chatTitle = title;
    };
    const reply = await runTitleModel(d.runner, MODEL, "the prompt", { scratchRoot });
    const title = sanitizeTitle(reply)!;
    const result = await applyChatTitle({ paseo: d.apply, setChatTitle }, { agentId: CHAT.id, title, currentChatTitle: "old chat title", enabled: true });
    expect(result).toEqual({ status: "renamed" });
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.shell).toBe(false);
    expect(invocations[0]?.args.slice(-5)).toEqual(["agent", "update", CHAT.id, "--name", 'Fix "archive" & 100% | done']);
  });
});
