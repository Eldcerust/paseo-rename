import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RetitleResult } from "../shared/types";
import { createStateStore, paseoRoot, statePath } from "./state";

let folder: string;
let file: string;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "chat-title-test-root-"));
  file = join(folder, "plugin-data", "chat-title", "state.json");
});
afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

const result = (agentId: string, title: string): RetitleResult => ({ agentId, status: "renamed", title, at: "2026-11-13T04:00:00.000Z" });

describe("state store", () => {
  it("gives a chat it has never seen an empty memory", async () => {
    expect(await createStateStore(file).get("unknown")).toEqual({ turns: 0 });
  });

  it("saves a change to disk and a new store on the same file reads it back", async () => {
    const store = createStateStore(file);
    await store.update("a1", (memory) => ({ ...memory, title: "Fix the archive button", turns: 3, renamedAt: "2026-11-13T04:00:00.000Z" }));
    await store.pushResult(result("a1", "Fix the archive button"));
    const reopened = createStateStore(file);
    expect(await reopened.get("a1")).toEqual({ title: "Fix the archive button", turns: 3, renamedAt: "2026-11-13T04:00:00.000Z" });
    expect((await reopened.recent()).map((entry) => entry.title)).toEqual(["Fix the archive button"]);
  });

  it("does not lose a write when many changes land together", async () => {
    const store = createStateStore(file);
    await Promise.all(Array.from({ length: 25 }, () => store.update("a1", (memory) => ({ ...memory, turns: memory.turns + 1 }))));
    expect((await store.get("a1")).turns).toBe(25);
    expect((await createStateStore(file).get("a1")).turns).toBe(25);
  });

  it("keeps recent results newest first and only as many as asked", async () => {
    const store = createStateStore(file, { maxRecent: 3 });
    for (const title of ["one", "two", "three", "four"]) await store.pushResult(result("a", title));
    expect((await store.recent()).map((entry) => entry.title)).toEqual(["four", "three", "two"]);
  });

  it("forgets the chats used longest ago once there are too many", async () => {
    const store = createStateStore(file, { maxAgents: 2 });
    await store.update("old", (memory) => ({ ...memory, turns: 1 }));
    await store.update("middle", (memory) => ({ ...memory, turns: 1 }));
    await store.update("old", (memory) => ({ ...memory, turns: 2 }));
    await store.update("new", (memory) => ({ ...memory, turns: 1 }));
    expect(await store.get("middle")).toEqual({ turns: 0 });
    expect((await store.get("old")).turns).toBe(2);
    expect((await store.get("new")).turns).toBe(1);
  });

  it("starts over when the file is not JSON, and the next write repairs it", async () => {
    await createStateStore(file).update("a", (memory) => memory);
    writeFileSync(file, "{ this is not json");
    const store = createStateStore(file);
    expect(await store.get("a")).toEqual({ turns: 0 });
    await store.update("a", (memory) => ({ ...memory, turns: 4 }));
    expect(JSON.parse(readFileSync(file, "utf8")).agents.a.turns).toBe(4);
  });

  it("keeps the valid records when one is malformed", async () => {
    await createStateStore(file).update("seed", (memory) => memory);
    writeFileSync(file, JSON.stringify({ version: 1, agents: { good: { title: "Keep me", turns: 2 }, bad: { title: 42, turns: "many" }, odd: "text" }, recent: [result("good", "Keep me"), { nope: true }] }));
    const store = createStateStore(file);
    expect(await store.get("good")).toEqual({ title: "Keep me", turns: 2 });
    expect(await store.get("odd")).toEqual({ turns: 0 });
    expect((await store.recent()).map((entry) => entry.title)).toEqual(["Keep me"]);
  });

  it("puts the file under plugin-data in the Paseo home", () => {
    expect(statePath("C:\\paseo-home")).toBe(join("C:\\paseo-home", "plugin-data", "chat-title", "state.json"));
    expect(paseoRoot({ PASEO_HOME: " D:\\custom " })).toBe("D:\\custom");
    expect(paseoRoot({})).toMatch(/\.paseo$/);
  });
});
