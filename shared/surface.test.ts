import { describe, expect, it, vi } from "vitest";
import { modelsFor, providersOf } from "../client/model-pick";
import { boundedInteger, settingsWithModel } from "../client/settings-values";
import { createCatalog, agentProviderOf, type CatalogSource } from "../server/catalog";
import { retitleChat, titleJobStatus, titleModels, titleOverview, titleProviders, titleTest } from "./rpc";
import { chatTitleSettings } from "./settings";

const prefixed = [{ id: "openai/title-small", label: "Title Small" }, { id: "anthropic/title-fast", label: "Title Fast" }];
const flat = [{ id: "claude-haiku-5-5", label: "Haiku" }];
const source: CatalogSource = { providers: {
  snapshot: async () => ({ entries: [{ provider: "opencode", status: "ready", enabled: true }, { provider: "claude", status: "ready", enabled: true }] }),
  listModels: async (provider) => ({ models: provider === "claude" ? flat : prefixed }),
  listModes: async () => ({ modes: [{ id: "plan" }] }),
} };

describe("joined client/settings/server surfaces", () => {
  it("validates numeric field drafts at every UI/schema boundary", () => {
    for (const [min, max] of [[4, 40], [200, 4000], [1, 50]]) {
      expect(boundedInteger(String(min), min, max)).toBe(min);
      expect(boundedInteger(` ${max} `, min, max)).toBe(max);
      for (const text of ["", " ", "1.5", "NaN", "1e2", "-1", String(min - 1), String(max + 1), "9007199254740992"]) expect(boundedInteger(text, min, max), text).toBeUndefined();
    }
  });
  it("requires a complete model selection without mutating unrelated settings", () => {
    const original = chatTitleSettings.schema.parse({ targets: { chat: false, workspace: true } });
    expect(() => settingsWithModel(original, "opencode", "")).toThrow("both");
    expect(() => settingsWithModel(original, "", "a-model")).toThrow("both");
    const next = settingsWithModel(original, " opencode ", " openai/title-small ");
    expect(next.model).toEqual({ provider: "opencode", model: "openai/title-small" });
    expect(next.targets).toEqual(original.targets); expect(next.auto).toEqual(original.auto);
    expect(original.model).toEqual({ provider: "", model: "" });
  });
  it("passes a searched prefixed model through the settings schema into catalog resolution", async () => {
    const catalog = createCatalog(source);
    const models = titleModels.output.parse({ models: await catalog.models("opencode") }).models;
    expect(providersOf(models).map((p) => p.id)).toEqual(["anthropic", "openai"]);
    const picked = modelsFor(models, "openai", "title small")[0];
    const settings = settingsWithModel(chatTitleSettings.schema.parse({}), "opencode", picked.id);
    expect(agentProviderOf(await catalog.resolve(settings.model))).toBe("opencode/openai/title-small");
  });
  it("does not add a fake sub-provider to a flat catalog selection", async () => {
    const catalog = createCatalog(source);
    const selected = modelsFor(await catalog.models("claude"), undefined, "haiku")[0];
    const settings = settingsWithModel(chatTitleSettings.schema.parse({}), "claude", selected.id);
    expect(await catalog.resolve(settings.model)).toEqual({ provider: "claude", model: selected.id, mode: "plan" });
  });
  it("resolves default settings and preserves independent targets and window bounds", async () => {
    const values = chatTitleSettings.schema.parse({ targets: { chat: false, workspace: true }, window: { messages: 40, charsPerMessage: 4000 } });
    expect(agentProviderOf(await createCatalog(source).resolve(values.model))).toBe("claude/claude-haiku-5-5");
    expect(values.targets).toEqual({ chat: false, workspace: true });
    expect(chatTitleSettings.schema.safeParse({ window: { messages: 41 } }).success).toBe(false);
  });
  it("round-trips every real RPC through its input and output contract", () => {
    const outcome = { agentId: "a", status: "renamed", title: "Archive workspace", previous: null, chat: { status: "renamed" }, workspace: { status: "skipped", detail: "Shared workspace" }, model: "claude/claude-haiku-5-5", messages: 10, at: "2026-11-13T00:00:00Z" };
    const roundtrip = (schema: { parse(value: unknown): unknown }, value: unknown) => expect(schema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
    const ack = { jobId: "retitle-request", kind: "retitle", agentId: "a" };
    roundtrip(retitleChat.input, { agentId: "a", force: true }); roundtrip(retitleChat.output, ack);
    roundtrip(titleJobStatus.input, { jobId: ack.jobId });
    roundtrip(titleJobStatus.output, { found: true, job: { ...ack, state: "succeeded", createdAt: outcome.at, updatedAt: outcome.at, expiresAt: outcome.at, result: outcome } });
    roundtrip(titleOverview.input, {}); roundtrip(titleOverview.output, { recent: [outcome], busy: ["a"], defaultModel: "claude/claude-haiku-5-5" });
    roundtrip(titleProviders.input, {}); roundtrip(titleProviders.output, { providers: [{ id: "claude", label: "Claude", available: true }, { id: "disabled", label: "Disabled", available: false, error: "Not installed" }] });
    roundtrip(titleModels.input, { provider: "opencode" }); roundtrip(titleModels.output, { models: prefixed });
    const sample = { jobId: "sample-request", kind: "sample" };
    roundtrip(titleTest.input, {}); roundtrip(titleTest.output, sample);
    roundtrip(titleJobStatus.output, { found: true, job: { ...sample, state: "succeeded", createdAt: outcome.at, updatedAt: outcome.at, expiresAt: outcome.at, result: { title: "Archive workspace", model: "claude/claude-haiku-5-5", ms: 120 } } });
    expect(retitleChat.input.safeParse({ agentId: "" }).success).toBe(false);
    expect(titleTest.output.safeParse({ title: "Title", model: "x", ms: -1 }).success).toBe(false);
  });
  it("wires all public contracts and the modern automatic hook in the real server entry", async () => {
    const { default: contribute } = await import("../index.server");
    const handlers = new Map(); const unhook = vi.fn();
    const server = {
      registerSettings: vi.fn(() => ({ read: async () => ({ status: "ready", values: chatTitleSettings.schema.parse({}) }) })),
      handle: vi.fn((contract, handler) => handlers.set(contract.name, handler)),
      addHook: vi.fn(() => unhook),
    };
    const cleanup = contribute(server as never);
    expect(server.registerSettings).toHaveBeenCalledWith(chatTitleSettings);
    expect([...handlers.keys()].sort()).toEqual([retitleChat, titleJobStatus, titleOverview, titleProviders, titleModels, titleTest].map((rpc) => rpc.name).sort());
    expect(server.addHook).toHaveBeenCalledWith("agent.turn.after", expect.any(Function));
    const providers = titleProviders.output.parse(await handlers.get(titleProviders.name)({}, { paseo: source }));
    expect(providers.providers.map((p) => p.id)).toContain("claude");
    expect(titleModels.output.parse(await handlers.get(titleModels.name)({ provider: "opencode" }, { paseo: source })).models).toEqual(prefixed);
    await cleanup(); expect(unhook).toHaveBeenCalledOnce();
  });
});
