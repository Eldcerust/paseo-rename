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

  describe("per-chat automatic renaming switch", () => {
    it("is off for every chat until it is switched on", async () => {
      const store = createStateStore(file);
      expect(await store.chatAuto("never-seen")).toBe(false);
      await store.update("known", (memory) => ({ ...memory, turns: 2 }));
      expect(await store.chatAuto("known")).toBe(false);
    });

    it("remembers each chat on its own and across a new store on the same file", async () => {
      const store = createStateStore(file);
      expect(await store.setChatAuto("a", true)).toBe(true);
      const reopened = createStateStore(file);
      expect(await reopened.chatAuto("a")).toBe(true);
      expect(await reopened.chatAuto("b")).toBe(false);
      expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ version: 1, auto: ["a"] });
    });

    it("forgets a chat that is switched off, and keeps nothing for a chat that was never on", async () => {
      const store = createStateStore(file);
      await store.setChatAuto("a", true); await store.setChatAuto("b", true);
      expect(await store.setChatAuto("a", false)).toBe(false);
      expect(await createStateStore(file).chatAuto("a")).toBe(false);
      expect(JSON.parse(readFileSync(file, "utf8")).auto).toEqual(["b"]);
      expect(await store.setChatAuto("never-on", false)).toBe(false);
    });

    it("is not forgotten when other chats push the per-chat memory past its limit", async () => {
      const store = createStateStore(file, { maxAgents: 2 });
      await store.setChatAuto("quiet", true);
      await store.update("quiet", (memory) => ({ ...memory, turns: 1 }));
      for (const id of ["x1", "x2", "x3"]) await store.update(id, (memory) => ({ ...memory, turns: 1 }));
      expect((await store.get("quiet")).turns).toBe(0);
      expect(await createStateStore(file, { maxAgents: 2 }).chatAuto("quiet")).toBe(true);
    });

    it("starts a chat fresh when it is switched on and leaves its memory alone when it is switched off", async () => {
      const store = createStateStore(file);
      await store.update("a", (memory) => ({ ...memory, title: "Mine", workspaceTitle: "Space", turns: 3, renamedAt: "2026-11-12T00:00:00.000Z", attemptedAt: "2026-11-13T00:00:00.000Z" }));
      await store.setChatAuto("a", true);
      expect(await store.get("a")).toEqual({ title: "Mine", workspaceTitle: "Space", turns: 0, renamedAt: "2026-11-12T00:00:00.000Z" });
      await store.update("a", (memory) => ({ ...memory, turns: 2, attemptedAt: "2026-11-13T02:00:00.000Z" }));
      await store.setChatAuto("a", false);
      expect(await store.get("a")).toMatchObject({ turns: 2, attemptedAt: "2026-11-13T02:00:00.000Z" });
    });

    it("refuses a chat beyond the limit without forgetting another, and frees room when one is switched off", async () => {
      const store = createStateStore(file, { maxAutoChats: 2 });
      await store.setChatAuto("one", true); await store.setChatAuto("two", true);
      await expect(store.setChatAuto("three", true)).rejects.toThrow("most this plugin remembers");
      expect(await store.chatAuto("one") && await store.chatAuto("two")).toBe(true);
      expect(await store.chatAuto("three")).toBe(false);
      expect(await store.setChatAuto("one", true)).toBe(true);
      await store.setChatAuto("one", false);
      expect(await store.setChatAuto("three", true)).toBe(true);
    });

    it("changes nothing when the save fails, so the trigger never reads a switch that was not stored", async () => {
      const blocker = join(folder, "blocker");
      writeFileSync(blocker, "a file where a folder is needed");
      const broken = createStateStore(join(blocker, "state.json"));
      await expect(broken.setChatAuto("a", true)).rejects.toThrow("cannot write");
      expect(await broken.chatAuto("a")).toBe(false);
      // Switching off fails the same way and the chat stays on.
      const store = createStateStore(file);
      await store.setChatAuto("b", true);
      const folderOfFile = join(folder, "plugin-data", "chat-title");
      rmSync(folderOfFile, { recursive: true, force: true });
      writeFileSync(folderOfFile, "now a file");
      await expect(store.setChatAuto("b", false)).rejects.toThrow("cannot write");
      expect(await store.chatAuto("b")).toBe(true);
    });

    it("keeps the valid ids of a damaged list and treats an older file with no list as everything off", async () => {
      await createStateStore(file).update("seed", (memory) => memory);
      writeFileSync(file, JSON.stringify({ version: 1, agents: {}, recent: [], auto: ["good", "", 7, null, "also-good"] }));
      const store = createStateStore(file);
      expect(await store.chatAuto("good") && await store.chatAuto("also-good")).toBe(true);
      expect(await store.chatAuto("7")).toBe(false);
      writeFileSync(file, JSON.stringify({ version: 1, agents: { old: { turns: 1 } }, recent: [] }));
      expect(await createStateStore(file).chatAuto("old")).toBe(false);
    });

    it("keeps every switch when many land together", async () => {
      const store = createStateStore(file);
      await Promise.all(Array.from({ length: 30 }, (_, index) => store.setChatAuto(`chat-${index}`, true)));
      const reopened = createStateStore(file);
      expect((await Promise.all(Array.from({ length: 30 }, (_, index) => reopened.chatAuto(`chat-${index}`)))).every(Boolean)).toBe(true);
    });
  });

  describe("per-workspace project title memory", () => {
    it("round-trips a workspace title through the file", async () => {
      const store = createStateStore(file);
      await store.setWorkspace("wks-1", "Shared release work", "2026-11-13T05:00:00.000Z");
      expect(await store.workspace("wks-1")).toEqual({ title: "Shared release work", at: "2026-11-13T05:00:00.000Z" });
      expect(await createStateStore(file).workspace("wks-1")).toEqual({ title: "Shared release work", at: "2026-11-13T05:00:00.000Z" });
      expect(await store.workspace("wks-2")).toBeUndefined();
    });

    it("loads an old file with no workspace map and treats its workspaces as unknown", async () => {
      await createStateStore(file).update("seed", (memory) => memory);
      writeFileSync(file, JSON.stringify({ version: 1, agents: { a: { turns: 1 } }, recent: [], auto: [] }));
      const store = createStateStore(file);
      expect(await store.workspace("wks-1")).toBeUndefined();
      await store.setWorkspace("wks-1", "New name");
      expect(await createStateStore(file).workspace("wks-1")).toEqual({ title: "New name" });
    });

    it("keeps valid workspace records and ignores malformed ones", async () => {
      await createStateStore(file).update("seed", (memory) => memory);
      writeFileSync(file, JSON.stringify({
        version: 1,
        agents: {},
        recent: [],
        auto: [],
        workspaces: { good: { title: "Keep me", at: "2026-11-13T05:00:00.000Z" }, number: { title: 42 }, blank: { title: "   " }, odd: "text", "": { title: "No id" } },
      }));
      const store = createStateStore(file);
      expect(await store.workspace("good")).toEqual({ title: "Keep me", at: "2026-11-13T05:00:00.000Z" });
      expect(await store.workspace("number")).toBeUndefined();
      expect(await store.workspace("blank")).toBeUndefined();
      expect(await store.workspace("odd")).toBeUndefined();
      expect(await store.workspace("")).toBeUndefined();
    });

    it("forgets the workspace used longest ago and refreshes recency on write", async () => {
      const store = createStateStore(file, { maxWorkspaces: 2 });
      await store.setWorkspace("old", "Old");
      await store.setWorkspace("middle", "Middle");
      await store.setWorkspace("old", "Old again");
      await store.setWorkspace("new", "New");
      expect(await store.workspace("middle")).toBeUndefined();
      expect(await store.workspace("old")).toEqual({ title: "Old again" });
      expect(await store.workspace("new")).toEqual({ title: "New" });
    });

    it("refuses an empty title without writing anything", async () => {
      const store = createStateStore(file);
      await expect(store.setWorkspace("wks-1", "   ")).rejects.toThrow("must not be empty");
      expect(await store.workspace("wks-1")).toBeUndefined();
    });

    it("leaves the older per-chat workspace title readable as a seed", async () => {
      const store = createStateStore(file);
      await store.update("a", (memory) => ({ ...memory, workspaceTitle: "Earlier project name" }));
      expect((await store.get("a")).workspaceTitle).toBe("Earlier project name");
    });
  });

  it("puts the file under plugin-data in the Paseo home", () => {
    expect(statePath("C:\\paseo-home")).toBe(join("C:\\paseo-home", "plugin-data", "chat-title", "state.json"));
    expect(paseoRoot({ PASEO_HOME: " D:\\custom " })).toBe("D:\\custom");
    expect(paseoRoot({})).toMatch(/\.paseo$/);
  });
});
