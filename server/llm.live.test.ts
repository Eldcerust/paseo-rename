import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import type { PaseoClient } from "@getpaseo/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sanitizeTitle } from "../shared/title";
import type { WindowMessage } from "../shared/types";
import { createCatalog, type Catalog } from "./catalog";
import { LIVE, connectLive } from "./live-client";
import { HELPER_TITLE, SCRATCH_NAME, asRunner, runTitleModel } from "./llm";
import { buildTitlePrompt } from "./prompt";

/** A cheap model per provider, since this makes a real model call for each. */
const CHEAP_MODEL: Record<string, string> = {
  claude: "claude-haiku-5-5",
  opencode: "opencode-go/deepseek-v4.1-flash",
};

const SAMPLE: WindowMessage[] = [
  { role: "user", text: "The archive button only archives the chat but the workspace row stays in the sidebar. Can you make it archive the whole session?" },
  { role: "assistant", text: "I changed the exporter so archiving a chat also archives the chat's own workspace, unless another chat still lives in it." },
  { role: "user", text: "Nice. Now add a plugin that renames chats from the last messages, with a provider I can choose." },
];

const scratchFolders = () => readdirSync(tmpdir()).filter((name) => name.startsWith("chat-title-") && !name.startsWith("chat-title-test-root-") && !name.startsWith("chat-title-live-"));

describe.skipIf(!LIVE)("a helper agent on the local daemon", () => {
  let paseo: PaseoClient;
  let catalog: Catalog;
  let foldersBefore: string[];
  const tried: string[] = [];

  beforeAll(async () => {
    paseo = await connectLive();
    catalog = createCatalog(paseo);
    foldersBefore = scratchFolders();
  }, 60_000);

  afterAll(async () => {
    await paseo?.close();
  });

  it("writes a usable one-line title through every available provider that has a known cheap model", async () => {
    const available = (await catalog.providers()).filter((provider) => provider.available);
    expect(available.length).toBeGreaterThanOrEqual(1);
    for (const provider of available) {
      const model = CHEAP_MODEL[provider.id];
      if (!model) continue;
      const resolved = await catalog.resolve({ provider: provider.id, model });
      const reply = await runTitleModel(asRunner(paseo), resolved, buildTitlePrompt({ messages: SAMPLE, currentTitle: null }), { answerWithinMs: 150_000 });
      const title = sanitizeTitle(reply);
      expect(title, `${provider.id}/${model} replied ${JSON.stringify(reply)}`).toBeDefined();
      expect(title).not.toContain("\n");
      expect(title!.length).toBeLessThanOrEqual(80);
      expect(title!, `${provider.id} title ${JSON.stringify(title)} is not about the conversation`).toMatch(/rename|title|chat|plugin|archive|workspace|provider/i);
      tried.push(provider.id);
    }
    expect(tried.length).toBeGreaterThanOrEqual(1);
  }, 400_000);

  it("leaves no helper agent or workspace behind, and adds no scratch folder but the one shared folder", async () => {
    expect(tried.length, "the first test must have run a helper").toBeGreaterThanOrEqual(1);
    const agents = await paseo.agents.list({});
    const helpers = agents.entries.map((entry) => entry.agent).filter((agent) => agent.title === HELPER_TITLE && !agent.archivedAt);
    expect(helpers.map((agent) => agent.id)).toEqual([]);
    const workspaces = await paseo.workspaces.list({});
    const leftovers = workspaces.entries.filter((workspace) => workspace.workspaceDirectory.replaceAll("\\", "/").includes(`/${SCRATCH_NAME}`));
    expect(leftovers.map((workspace) => workspace.workspaceDirectory)).toEqual([]);
    const added = scratchFolders().filter((name) => !foldersBefore.includes(name));
    expect(added.filter((name) => name !== SCRATCH_NAME)).toEqual([]);
  }, 60_000);
});
