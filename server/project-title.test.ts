import { describe, expect, it, vi } from "vitest";
import type { ResolvedModel } from "./catalog";
import type { ProjectEvidence } from "./evidence";
import { MAX_CACHED_PROJECTS, createProjectTitles, type ProjectModelRunner } from "./project-title";

const MODEL: ResolvedModel = { provider: "opencode", model: "cheap" };
const evidence = (...chats: ProjectEvidence[]): ProjectEvidence[] => chats;
const request = (overrides: Partial<Parameters<ReturnType<typeof createProjectTitles>["resolve"]>[1]> = {}) => ({
  workspaceId: "wks-1",
  agentId: "a",
  chatTitle: "New chat title",
  evidence: evidence({ id: "a", title: "Old chat title" }, { id: "b", title: "Second chat" }),
  currentTitle: "Old project",
  model: MODEL,
  ...overrides,
});

function composerWith(reply: string | Error = "Shared release work") {
  const calls: { prompt: string; model: ResolvedModel }[] = [];
  const runModel: ProjectModelRunner = vi.fn(async (model, prompt) => {
    calls.push({ prompt, model });
    if (reply instanceof Error) throw reply;
    return reply;
  });
  return { composer: createProjectTitles(), runModel, calls };
}

describe("project title composer", () => {
  it("reuses the chat title for a single live chat without calling the model", async () => {
    const { composer, runModel } = composerWith();
    expect(await composer.resolve(runModel, request({ evidence: evidence({ id: "a", title: "Old" }), chatTitle: "Alpha" }))).toEqual({ title: "Alpha", from: "chat" });
    expect(runModel).not.toHaveBeenCalled();
  });

  it("uses the freshly written chat title instead of the directory's stale one", async () => {
    const { composer, runModel, calls } = composerWith();
    const result = await composer.resolve(runModel, request({ chatTitle: "Fresh title" }));
    expect(result).toEqual({ title: "Shared release work", from: "summary" });
    expect(calls[0]?.prompt).toContain('title: "Fresh title"');
    expect(calls[0]?.prompt).not.toContain('title: "Old chat title"');
    expect(calls[0]?.prompt).toContain('title: "Second chat"');
  });

  it("cleans the model's reply into a title", async () => {
    const { composer, runModel } = composerWith('Title: "Shared release work."');
    expect((await composer.resolve(runModel, request())).title).toBe("Shared release work");
  });

  it("reuses the cached summary while the chat titles and model are unchanged", async () => {
    const { composer, runModel } = composerWith();
    const first = await composer.resolve(runModel, request());
    const second = await composer.resolve(runModel, request());
    expect(first.from).toBe("summary");
    expect(second).toEqual({ title: "Shared release work", from: "cache" });
    expect(runModel).toHaveBeenCalledTimes(1);
  });

  it("re-summarises when a chat title changes or the model changes", async () => {
    const { composer, runModel } = composerWith();
    await composer.resolve(runModel, request());
    await composer.resolve(runModel, request({ evidence: evidence({ id: "a", title: "New chat title" }, { id: "b", title: "Changed" }) }));
    await composer.resolve(runModel, request({ model: { provider: "claude", model: "other" } }));
    expect(runModel).toHaveBeenCalledTimes(3);
  });

  it("keeps one cache entry per workspace", async () => {
    const { composer, runModel } = composerWith();
    await composer.resolve(runModel, request({ workspaceId: "wks-1" }));
    await composer.resolve(runModel, request({ workspaceId: "wks-2" }));
    expect(runModel).toHaveBeenCalledTimes(2);
  });

  it("returns an error instead of a title when the reply is unusable", async () => {
    const { composer, runModel } = composerWith("I'm sorry, but I can't name that project.");
    const result = await composer.resolve(runModel, request());
    expect(result.title).toBeUndefined();
    expect(result.error).toContain("could not be used as a project name");
  });

  it("returns the model's error without throwing", async () => {
    const { composer, runModel } = composerWith(new Error("model not found"));
    expect(await composer.resolve(runModel, request())).toEqual({ from: "summary", error: "model not found" });
  });

  it("refuses an empty chat title", async () => {
    const { composer, runModel } = composerWith();
    const result = await composer.resolve(runModel, request({ chatTitle: "   " }));
    expect(result.title).toBeUndefined();
    expect(runModel).not.toHaveBeenCalled();
  });

  it("bounds the in-memory cache", async () => {
    const { composer, runModel } = composerWith();
    for (let index = 0; index < MAX_CACHED_PROJECTS + 3; index++) {
      await composer.resolve(runModel, request({ workspaceId: `wks-${index}` }));
    }
    // The oldest entries were evicted, so those workspaces pay for a new summary again.
    await composer.resolve(runModel, request({ workspaceId: "wks-0" }));
    expect(runModel).toHaveBeenCalledTimes(MAX_CACHED_PROJECTS + 4);
  });
});
