import { describe, expect, it } from "vitest";
import { agentProviderOf, createCatalog, lowestThinking, readOnlyMode, type CatalogSource } from "./catalog";

const thinking = (...ids: string[]) => ids.map((id) => ({ id }));

function fakeSource(overrides: { missing?: string[]; modelsError?: string; emptyFor?: string; unavailable?: string[] } = {}) {
  const calls = { snapshot: 0, models: [] as string[], modes: [] as string[] };
  const down = new Set(overrides.unavailable ?? []);
  const entries = [
    { provider: "claude", status: down.has("claude") ? "unavailable" : "ready", enabled: !down.has("claude"), label: "Claude" },
    { provider: "codex", status: "unavailable", enabled: false, label: "Codex" },
    { provider: "opencode", status: down.has("opencode") ? "unavailable" : "ready", enabled: !down.has("opencode"), label: "OpenCode" },
    { provider: "pi", status: "error", enabled: true, label: "Pi", error: "binary crashed" },
    { provider: "hermes", status: "loading", enabled: true, label: "Hermes" },
  ];
  const catalogue: Record<string, { id: string; label: string; thinkingOptions: { id: string }[] }[]> = {
    claude: [
      { id: "claude-haiku-5-5", label: "Haiku 5.5", thinkingOptions: thinking("off", "low", "high") },
      { id: "claude-opus-5-5", label: "Opus 5.5", thinkingOptions: thinking("low", "medium", "high") },
    ],
    opencode: [
      { id: "opencode-go/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash", thinkingOptions: thinking("low", "high", "max") },
      { id: "opencode/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash", thinkingOptions: thinking("low", "high", "max") },
      { id: "openrouter/some/model", label: "Some model", thinkingOptions: [] },
    ],
  };
  const missing = new Set(overrides.missing ?? []);
  const source: CatalogSource = {
    providers: {
      async snapshot() {
        calls.snapshot += 1;
        return { entries };
      },
      async listModels(provider) {
        calls.models.push(provider);
        if (overrides.modelsError) return { error: overrides.modelsError };
        if (overrides.emptyFor === provider) return { models: [] };
        return { models: (catalogue[provider] ?? []).filter((model) => !missing.has(model.id)) };
      },
      async listModes(provider) {
        calls.modes.push(provider);
        return { modes: provider === "claude" ? [{ id: "default", label: "Always Ask" }, { id: "plan", label: "Plan Mode" }] : [{ id: "build" }, { id: "plan" }] };
      },
    },
  };
  return { source, calls };
}

describe("providers", () => {
  it("lists available providers first, with labels, and says why the others are not", async () => {
    const { source } = fakeSource();
    const providers = await createCatalog(source).providers();
    expect(providers.map((provider) => [provider.id, provider.available])).toEqual([
      ["claude", true],
      ["opencode", true],
      ["codex", false],
      ["pi", false],
      ["hermes", false],
    ]);
    expect(providers[0]).toEqual({ id: "claude", label: "Claude", available: true });
    expect(providers.find((provider) => provider.id === "codex")?.error).toBe("Not installed, or turned off in Paseo");
    expect(providers.find((provider) => provider.id === "pi")?.error).toBe("binary crashed");
    expect(providers.find((provider) => provider.id === "hermes")?.error).toBe("Not ready (loading)");
  });
});

describe("models", () => {
  it("lists a provider's models with their thinking levels", async () => {
    const { source } = fakeSource();
    const models = await createCatalog(source).models("claude");
    expect(models).toEqual([
      { id: "claude-haiku-5-5", label: "Haiku 5.5", thinking: ["off", "low", "high"] },
      { id: "claude-opus-5-5", label: "Opus 5.5", thinking: ["low", "medium", "high"] },
    ]);
  });

  it("says so when the daemon reports an error or lists nothing", async () => {
    await expect(createCatalog(fakeSource({ modelsError: "provider timed out" }).source).models("claude")).rejects.toThrow("Could not list the models of claude: provider timed out");
    await expect(createCatalog(fakeSource({ emptyFor: "opencode" }).source).models("opencode")).rejects.toThrow("opencode lists no models");
  });
});

describe("lowestThinking and readOnlyMode", () => {
  it("prefers off, then none, then minimal, then low, else the first level listed", () => {
    expect(lowestThinking(["low", "high", "max"])).toBe("low");
    expect(lowestThinking(["high", "off", "low"])).toBe("off");
    expect(lowestThinking(["none", "low", "max"])).toBe("none");
    expect(lowestThinking(["minimal", "high"])).toBe("minimal");
    expect(lowestThinking(["medium", "high"])).toBe("medium");
    expect(lowestThinking([])).toBeUndefined();
  });

  it("picks plan, else a mode named like plan or read-only, else none", () => {
    expect(readOnlyMode([{ id: "default" }, { id: "plan" }])).toBe("plan");
    expect(readOnlyMode([{ id: "ask", label: "Read-only" }, { id: "build" }])).toBe("ask");
    expect(readOnlyMode([{ id: "plan-lite", label: "Planner" }])).toBe("plan-lite");
    expect(readOnlyMode([{ id: "build" }, { id: "auto" }])).toBeUndefined();
  });
});

describe("resolve", () => {
  it("accepts a chosen provider and model that exist, with the cheapest thinking and plan mode", async () => {
    const resolved = await createCatalog(fakeSource().source).resolve({ provider: "claude", model: "claude-haiku-5-5" });
    expect(resolved).toEqual({ provider: "claude", model: "claude-haiku-5-5", thinking: "off", mode: "plan" });
    expect(agentProviderOf(resolved)).toBe("claude/claude-haiku-5-5");
  });

  it("leaves thinking out for a model that lists none", async () => {
    const resolved = await createCatalog(fakeSource().source).resolve({ provider: "opencode", model: "openrouter/some/model" });
    expect(resolved).toEqual({ provider: "opencode", model: "openrouter/some/model", mode: "plan" });
  });

  it("refuses a provider that is unavailable, unknown, or lacks the model", async () => {
    const catalog = createCatalog(fakeSource().source);
    await expect(catalog.resolve({ provider: "codex", model: "x" })).rejects.toThrow('The provider "Codex" is not available: Not installed, or turned off in Paseo.');
    await expect(catalog.resolve({ provider: "nope", model: "x" })).rejects.toThrow('The provider "nope" is not known to this host.');
    await expect(catalog.resolve({ provider: "claude", model: "claude-gone" })).rejects.toThrow('Claude does not offer "claude-gone" any more.');
  });

  it("refuses half a choice instead of guessing the other half", async () => {
    const catalog = createCatalog(fakeSource().source);
    await expect(catalog.resolve({ provider: "claude", model: "" })).rejects.toThrow("Choose both a provider and a model");
    await expect(catalog.resolve({ provider: "", model: "claude-haiku-5-5" })).rejects.toThrow("Choose both a provider and a model");
  });

  it("with no choice, uses the first built-in preference that is available", async () => {
    const resolved = await createCatalog(fakeSource().source).resolve({ provider: "", model: "" });
    expect(resolved).toEqual({ provider: "opencode", model: "opencode-go/deepseek-v4.1-flash", thinking: "low", mode: "plan" });
  });

  it("falls through the preferences: next OpenCode model, then Claude Haiku, then an error", async () => {
    const second = await createCatalog(fakeSource({ missing: ["opencode-go/deepseek-v4.1-flash"] }).source).resolve({ provider: "", model: "" });
    expect(agentProviderOf(second)).toBe("opencode/opencode/deepseek-v4.1-flash");
    const third = await createCatalog(fakeSource({ unavailable: ["opencode"] }).source).resolve({ provider: "", model: "" });
    expect(agentProviderOf(third)).toBe("claude/claude-haiku-5-5");
    const none = createCatalog(fakeSource({ unavailable: ["opencode", "claude"] }).source);
    await expect(none.resolve({ provider: "", model: "" })).rejects.toThrow("None of the built-in models is available");
  });

  it("names the default model, or nothing when there is none", async () => {
    expect(await createCatalog(fakeSource().source).defaultModel()).toBe("opencode/opencode-go/deepseek-v4.1-flash");
    expect(await createCatalog(fakeSource({ unavailable: ["opencode", "claude"] }).source).defaultModel()).toBeUndefined();
  });
});

describe("caching", () => {
  it("does not ask the daemon again within the time limit, and does after it", async () => {
    let clock = 1_000;
    const { source, calls } = fakeSource();
    const catalog = createCatalog(source, { ttlMs: 60_000, now: () => clock });
    await catalog.resolve({ provider: "claude", model: "claude-haiku-5-5" });
    await catalog.resolve({ provider: "claude", model: "claude-opus-5-5" });
    await catalog.providers();
    expect(calls.snapshot).toBe(1);
    expect(calls.models).toEqual(["claude"]);
    clock += 60_001;
    await catalog.resolve({ provider: "claude", model: "claude-haiku-5-5" });
    expect(calls.snapshot).toBe(2);
    expect(calls.models).toEqual(["claude", "claude"]);
  });

  it("does not remember a failed read", async () => {
    let fail = true;
    const { source, calls } = fakeSource();
    const flaky: CatalogSource = { providers: { ...source.providers, listModels: async (provider) => (fail ? Promise.reject(new Error("daemon busy")) : source.providers.listModels(provider)) } };
    const catalog = createCatalog(flaky);
    await expect(catalog.models("claude")).rejects.toThrow("daemon busy");
    fail = false;
    expect((await catalog.models("claude")).length).toBe(2);
    expect(calls.models).toEqual(["claude"]);
  });
});
