import { describe, expect, it } from "vitest";
import { modelsFor, providerOf, providersOf, ROW_LIMIT, visibleModels } from "./model-pick";

const models = [
  { id: "anthropic/claude-sonnet", label: "Sonnet" },
  { id: "opencode-go/deepseek-v4.1-flash", label: "DeepSeek Flash" },
  { id: "opencode/deepseek-v4.1-flash", label: "DeepSeek Flash" },
  { id: "openai/gpt-x", label: "GPT X" },
  { id: "claude-haiku", label: "Haiku" },
];
describe("model picker logic", () => {
  it("groups prefixed ids by their first path component", () => expect(providerOf("a/b/c")).toBe("a"));
  it("treats flat ids as one list", () => expect(providersOf([{ id: "haiku", label: "Haiku" }, { id: "sonnet", label: "Sonnet" }])).toEqual([{ id: "other", count: 2 }]));
  it("orders OpenCode groups first and counts every model", () => expect(providersOf(models).map((p) => p.id)).toEqual(["opencode", "opencode-go", "anthropic", "openai", "other"]));
  it("searches by words in either order and any case", () => expect(modelsFor(models, undefined, "FLASH deepSEEK").map((m) => m.id)).toEqual(["opencode-go/deepseek-v4.1-flash", "opencode/deepseek-v4.1-flash"]));
  it("searches ids as well as labels", () => expect(modelsFor(models, undefined, "openai")).toEqual([models[3]]));
  it("keeps a search inside the chosen group", () => expect(modelsFor(models, "opencode", "deepseek")).toEqual([models[2]]));
  it("an empty query shows all models sorted by label", () => expect(modelsFor(models, undefined, "  ").map((m) => m.label)).toEqual(["DeepSeek Flash", "DeepSeek Flash", "GPT X", "Haiku", "Sonnet"]));
  it("returns no rows for an unmatched query", () => expect(modelsFor(models, undefined, "not-a-model")).toEqual([]));
  it("caps rows without capping the searchable input", () => { const all = Array.from({ length: ROW_LIMIT + 7 }, (_, i) => ({ id: `p/${i}`, label: `Model ${i}` })); expect(visibleModels(all).rows).toHaveLength(ROW_LIMIT); expect(visibleModels(all).hidden).toBe(7); expect(modelsFor(all, undefined, `p/${ROW_LIMIT + 6}`)).toHaveLength(1); });
  it("handles empty inputs and an explicit small limit", () => { expect(visibleModels([])).toEqual({ rows: [], hidden: 0 }); expect(visibleModels(models, 2)).toEqual({ rows: models.slice(0, 2), hidden: 3 }); });
});
