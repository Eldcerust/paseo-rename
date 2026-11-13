import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoClient } from "@getpaseo/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chatTitleSettings, DEFAULT_MODEL_PREFERENCE, type ChatTitleValues } from "../shared/settings";
import { sanitizeTitle } from "../shared/title";
import { agentProviderOf, createCatalog, type ResolvedModel } from "./catalog";
import { currentEnvironment, renameAgentWithCli, runInvocation } from "./cli";
import { connectLive, LIVE } from "./live-client";
import { HELPER_TITLE, scratchFolder } from "./llm";
import { asRetitleDaemon, createRetitler } from "./retitle";
import { createStateStore } from "./state";

const SEED = "We are planning a rainwater collection system for a community greenhouse. Discuss roof gutters, a storage tank, and drip irrigation. Answer with one short sentence about this design. Text only, do not use tools or inspect files.";
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

describe.skipIf(!LIVE)("full retitler against the real daemon", () => {
  let paseo: PaseoClient;
  let root: string;
  let values: ChatTitleValues;
  let retitler: ReturnType<typeof createRetitler>;
  const agents = new Set<string>();
  const workspaces = new Set<string>();
  const targets: { id: string; workspaceId: string; model: ResolvedModel }[] = [];
  let helperIdsBefore = new Set<string>();
  let workspaceIdsBefore = new Set<string>();
  const setChatTitle = (id: string, title: string) => renameAgentWithCli(currentEnvironment(), runInvocation, id, title);
  const chatTitle = async (id: string) => (await paseo.agents.ref(id).refresh())?.agent.title;
  const workspaceTitle = async (id: string) => { const snapshot = await paseo.workspaces.ref(id).refresh(); return snapshot?.title ?? snapshot?.name; };

  async function cleanTargets() {
    const errors: string[] = [];
    for (const id of agents) {
      try { await paseo.agents.ref(id).archive(); } catch (error) { errors.push(`archive agent ${id}: ${message(error)}`); }
    }
    for (const id of workspaces) {
      // IDs are admitted only after verifying the workspace did not exist before this run.
      try { await paseo.workspaces.archive(id); } catch (error) { errors.push(`archive workspace ${id}: ${message(error)}`); }
    }
    if (errors.length) throw new Error(errors.join("\n"));
  }

  beforeAll(async () => {
    paseo = await connectLive();
    const approvedTemp = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Temp", "opencode") : tmpdir();
    mkdirSync(approvedTemp, { recursive: true });
    root = mkdtempSync(join(approvedTemp, "chat-title-e2e-"));
    values = chatTitleSettings.schema.parse({ auto: { enabled: false } });
    retitler = createRetitler({ settings: async () => values, state: createStateStore(join(root, "state.json")), scratchRoot: root });
    helperIdsBefore = new Set((await paseo.agents.list({})).entries.map(({ agent }) => agent.id));
    workspaceIdsBefore = new Set((await paseo.workspaces.list({})).entries.map((workspace) => workspace.id));
  }, 60_000);

  afterAll(async () => {
    try { if (paseo) await cleanTargets(); } finally { await paseo?.close(); }
    // Provider processes can retain directory handles; these uniquely named test folders are not recursively deleted.
  }, 90_000);

  it("generates a usable title and renames a throwaway chat and workspace through EVERY available provider", async () => {
    const catalog = createCatalog(paseo);
    const available = (await catalog.providers()).filter((provider) => provider.available);
    expect(available.length, "No provider is available on the daemon").toBeGreaterThan(0);
    const failures: string[] = [];
    const attempted: string[] = [];
    for (const provider of available) {
      attempted.push(provider.id);
      try {
        const listed = await catalog.models(provider.id);
        const preferred = DEFAULT_MODEL_PREFERENCE.find((choice) => choice.provider === provider.id && listed.some((model) => model.id === choice.model));
        const model = await catalog.resolve({ provider: provider.id, model: preferred?.model ?? listed[0].id });
        values = { ...values, model, targets: { chat: true, workspace: true } };
        const cwd = join(root, `target-${provider.id.replace(/[^a-z0-9-]/gi, "-")}`);
        mkdirSync(cwd, { recursive: true });
        const target = await paseo.agents.create({ config: { provider: agentProviderOf(model), ...(model.mode ? { modeId: model.mode } : {}), ...(model.thinking ? { thinkingOptionId: model.thinking } : {}) }, cwd, title: "Temporary greenhouse test chat", prompt: SEED, labels: { "chat-title-e2e": root } });
        agents.add(target.id);
        await target.refresh();
        if (!target.workspaceId) throw new Error("Target has no workspace");
        if (workspaceIdsBefore.has(target.workspaceId)) throw new Error("Refusing cleanup ownership of an existing workspace");
        workspaces.add(target.workspaceId);
        targets.push({ id: target.id, workspaceId: target.workspaceId, model });
        // The conversational seed is a real provider turn, not a fabricated timeline or model reply.
        const deadline = Date.now() + 120_000;
        let finished = false;
        while (Date.now() < deadline) {
          const completion = await target.waitForFinish(Math.min(10_000, deadline - Date.now()));
          if (completion.status === "permission") {
            await target.refresh();
            for (const request of target.pendingPermissions ?? []) await target.respondToPermission({ requestId: request.id, response: { behavior: "deny", message: "Text only. No tools.", interrupt: false } });
          } else if (completion.status === "error") throw new Error(completion.error ?? "Seed model failed");
          else if (completion.status === "idle") { finished = true; break; }
        }
        if (!finished) throw new Error("Seed model did not complete within 120 seconds");
        // Paseo can auto-name the new workspace from this same seed. That name may happen to
        // equal the model's next title, correctly producing "unchanged" rather than proving a
        // write. Establish explicit unrelated baselines so both rename assertions are decisive.
        await setChatTitle(target.id, "Unrelated chat verification baseline");
        await paseo.workspaces.ref(target.workspaceId).setTitle("Unrelated workspace verification baseline");
        expect(await chatTitle(target.id)).toBe("Unrelated chat verification baseline");
        expect(await workspaceTitle(target.workspaceId)).toBe("Unrelated workspace verification baseline");
        const previous = await chatTitle(target.id);
        const previousWorkspace = await workspaceTitle(target.workspaceId);
        const result = await retitler.retitle(asRetitleDaemon(paseo), { agentId: target.id, source: "manual", force: true });
        console.log(`[e2e] ${agentProviderOf(model)}: ${JSON.stringify(result)}`);
        if (result.status === "failed") {
          expect(await chatTitle(target.id), "Failed generation must not alter the chat").toBe(previous);
          expect(await workspaceTitle(target.workspaceId), "Failed generation must not alter the workspace").toBe(previousWorkspace);
          throw new Error(result.reason ?? "The retitler failed without a reason");
        }
        expect(result.status, JSON.stringify(result)).toBe("renamed");
        expect(result.chat?.status).toBe("renamed"); expect(result.workspace?.status).toBe("renamed");
        expect(result.title).toBe(sanitizeTitle(result.title ?? ""));
        expect(result.title).toMatch(/rain|water|greenhouse|gutter|tank|irrigation/i);
        expect(result.title).not.toBe(previous);
        expect(result.messages).toBeGreaterThanOrEqual(1);
        expect(await chatTitle(target.id)).toBe(result.title);
        expect(await workspaceTitle(target.workspaceId)).toBe(result.title);
      } catch (error) {
        failures.push(`${provider.id}: ${message(error)}`);
      }
    }
    expect(attempted).toEqual(available.map((provider) => provider.id));
    expect(failures, `Real provider failures (none silently skipped): ${failures.join(" | ")}`).toEqual([]);
  }, 900_000);

  it("keeps a real user-selected title on auto and honors both targets disabled without a model run", async () => {
    expect(targets.length, "The provider test must have made at least one target").toBeGreaterThan(0);
    const target = targets[0]; const title = "My personally chosen greenhouse title";
    await setChatTitle(target.id, title);
    values = { ...values, model: target.model, targets: { chat: true, workspace: true } };
    const automatic = await retitler.retitle(asRetitleDaemon(paseo), { agentId: target.id, source: "auto" });
    expect(automatic.status).toBe("skipped"); expect(automatic.reason).toContain("set by you");
    values = { ...values, targets: { chat: false, workspace: false } };
    const manual = await retitler.retitle(asRetitleDaemon(paseo), { agentId: target.id, source: "manual", force: true });
    expect(manual.status).toBe("skipped"); expect(manual.reason).toContain("Both rename targets");
    expect(await chatTitle(target.id)).toBe(title);
  }, 120_000);

  it("renames a target chat while protecting its workspace when another live chat shares it", async () => {
    expect(targets.length).toBeGreaterThan(0);
    const target = targets.find((entry) => entry.model.provider === "opencode") ?? targets[0];
    const partner = await paseo.workspaces.ref(target.workspaceId).agents.create({ config: { provider: agentProviderOf(target.model) }, title: "Test-owned workspace partner", labels: { "chat-title-e2e": root } });
    agents.add(partner.id);
    const before = await workspaceTitle(target.workspaceId);
    await setChatTitle(target.id, "Temporary unrelated test title");
    values = { ...values, model: target.model, targets: { chat: true, workspace: true } };
    const result = await retitler.retitle(asRetitleDaemon(paseo), { agentId: target.id, source: "manual", force: true });
    console.log(`[e2e] shared workspace: ${JSON.stringify(result)}`);
    expect(result.chat?.status, JSON.stringify(result)).toBe("renamed");
    expect(result.workspace?.status).toBe("skipped");
    expect(result.workspace?.detail).toContain("Another chat uses this workspace");
    expect(await workspaceTitle(target.workspaceId)).toBe(before);
    expect(await chatTitle(target.id)).toBe(result.title);
  }, 180_000);

  it("leaves no new live helper, target agent, or test-owned workspace behind", async () => {
    await cleanTargets();
    for (const id of agents) expect((await paseo.agents.ref(id).refresh())?.agent.archivedAt, `target ${id}`).toBeTruthy();
    const activeAgents = (await paseo.agents.list({})).entries.map(({ agent }) => agent);
    const helpers = activeAgents.filter((agent) => !helperIdsBefore.has(agent.id) && !agent.archivedAt && (agent.title === HELPER_TITLE || agent.cwd === scratchFolder(root)));
    expect(helpers.map((agent) => agent.id)).toEqual([]);
    const activeWorkspaces = await paseo.workspaces.list({});
    expect(activeWorkspaces.entries.filter((workspace) => workspaces.has(workspace.id) || workspace.workspaceDirectory.replaceAll("\\", "/") === scratchFolder(root).replaceAll("\\", "/")).map((workspace) => workspace.id)).toEqual([]);
    expect(retitler.busy()).toEqual([]);
  }, 120_000);
});
