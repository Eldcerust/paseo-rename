import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoClient } from "@getpaseo/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { settingsFallback } from "../shared/settings";
import { applyChatTitle, asApplyChat } from "./apply";
import { agentProviderOf, createCatalog } from "./catalog";
import { currentEnvironment, renameAgentWithCli, runInvocation } from "./cli";
import { LIVE, connectLive } from "./live-client";
import { applyProjectTitle } from "./project-apply";
import { createProjectTitles } from "./project-title";
import { createStateStore } from "./state";

/** Throwaway chats made for this test only. They get no prompt, so no model is called. */
const FOLDER = join(tmpdir(), "chat-title-live-apply");

describe.skipIf(!LIVE)("applying titles on the local daemon", () => {
  let paseo: PaseoClient;
  let first: { id: string; workspaceId: string };
  const made: string[] = [];
  const workspaces = new Set<string>();
  const suffix = Math.random().toString(36).slice(2, 8);
  const setChatTitle = (agentId: string, title: string) => renameAgentWithCli(currentEnvironment(), runInvocation, agentId, title);
  const chatTitle = async (id: string) => (await paseo.agents.ref(id).refresh())?.agent.title;
  const workspaceTitle = async (id: string) => {
    const workspace = await paseo.workspaces.ref(id).refresh();
    return workspace?.title ?? workspace?.name;
  };

  beforeAll(async () => {
    paseo = await connectLive();
    mkdirSync(FOLDER, { recursive: true });
    const model = await createCatalog(paseo).resolve({ provider: "", model: "" });
    // An ordinary workspace, not a background one: the daemon's chat list leaves background agents out,
    // and "another chat shares this workspace" is about the chats a person can see.
    const agent = await paseo.agents.create({ config: { provider: agentProviderOf(model), modeId: model.mode }, cwd: FOLDER, title: `chat-title live test ${suffix}` });
    made.push(agent.id);
    await agent.refresh();
    if (!agent.workspaceId) throw new Error("the throwaway chat has no workspace");
    first = { id: agent.id, workspaceId: agent.workspaceId };
    workspaces.add(agent.workspaceId);
  }, 120_000);

  afterAll(async () => {
    for (const id of made) await paseo.agents.ref(id).archive().catch(() => undefined);
    for (const id of workspaces) await paseo.workspaces.archive(id).catch(() => undefined);
    await paseo?.close();
  }, 60_000);

  it("renames a real chat through the Paseo command and the daemon reports it", async () => {
    const title = `Live rename ${suffix}`;
    const result = await applyChatTitle(
      { paseo: asApplyChat(paseo), setChatTitle },
      { agentId: first.id, title, currentChatTitle: await chatTitle(first.id) ?? null, enabled: true },
    );
    expect(result).toEqual({ status: "renamed" });
    expect(await chatTitle(first.id)).toBe(title);
  }, 90_000);

  it("carries quotes, ampersands, percent signs, pipes and non-ASCII text through the real command unchanged", async () => {
    const title = `Fix "archive" & 100% | done ^ <now> é 修复 ${suffix}`;
    const result = await applyChatTitle(
      { paseo: asApplyChat(paseo), setChatTitle },
      { agentId: first.id, title, currentChatTitle: await chatTitle(first.id) ?? null, enabled: true },
    );
    expect(result).toEqual({ status: "renamed" });
    expect(await chatTitle(first.id)).toBe(title);
  }, 90_000);

  it("names a real shared workspace from both live chats through the daemon", async () => {
    const second = await paseo.workspaces.ref(first.workspaceId).agents.create({ config: { provider: agentProviderOf(await createCatalog(paseo).resolve({ provider: "", model: "" })) }, title: `chat-title live partner ${suffix}` });
    made.push(second.id);
    const projectTitle = `Shared workspace ${suffix}`;
    const result = await applyProjectTitle(
      paseo,
      {
        settings: settingsFallback,
        state: createStateStore(join(FOLDER, "state.json")),
        titles: createProjectTitles(),
        // A live project test does not spend a second real model call; the census and workspace write are real.
        runModel: async () => projectTitle,
        model: { provider: "opencode", model: "unused" },
      },
      { agentId: first.id, chatTitle: `Live rename ${suffix}`, workspaceId: first.workspaceId, source: "manual" },
    );
    expect(result.workspace).toEqual({ status: "renamed", detail: "Named from 2 live chats." });
    expect(await workspaceTitle(first.workspaceId)).toBe(projectTitle);
  }, 90_000);
});
