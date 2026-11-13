import { describe, expect, it } from "vitest";
import { CENSUS_MAX_PAGES, isUserChat, readCensus, type CensusAgent, type CensusSource } from "./census";
import { scratchFolder } from "./llm";

const chat = (id: string, overrides: Partial<CensusAgent> = {}): CensusAgent => ({ id, workspaceId: "wks-1", title: `Chat ${id}`, ...overrides });

function source(pages: { entries: { agent: CensusAgent }[]; pageInfo?: { nextCursor?: string | null; hasMore?: boolean } }[]): CensusSource {
  let call = 0;
  return {
    agents: {
      list: async () => {
        const page = pages[call] ?? { entries: [], pageInfo: { hasMore: false } };
        call += 1;
        return page;
      },
    },
  };
}

describe("live user chat census", () => {
  it("keeps ordinary chats and drops archived chats, subagents, internal agents, helpers and other workspaces", async () => {
    const helperCwd = scratchFolder();
    const rows = [
      chat("mine"),
      chat("archived", { archivedAt: "2026-11-01T00:00:00Z" }),
      chat("subagent", { parentAgentId: "parent" }),
      chat("subagent-label", { labels: { "paseo.parent-agent-id": "parent" } }),
      chat("internal", { internal: true }),
      chat("helper-label", { labels: { "chat-title": "helper" } }),
      chat("helper-title", { title: "[Chat titles] naming a chat" }),
      chat("helper-cwd", { cwd: helperCwd }),
      chat("elsewhere", { workspaceId: "wks-2" }),
    ];
    const result = await readCensus(source([{ entries: rows.map((agent) => ({ agent })), pageInfo: { hasMore: false } }]), "wks-1");
    expect(result?.map((agent) => agent.id)).toEqual(["mine"]);
  });

  it("follows pages to the end and returns nothing when the workspace appears only on a later page", async () => {
    const result = await readCensus(
      source([
        { entries: [{ agent: chat("early", { workspaceId: "wks-2" }) }], pageInfo: { hasMore: true, nextCursor: "c1" } },
        { entries: [{ agent: chat("late") }], pageInfo: { hasMore: false } },
      ]),
      "wks-1",
    );
    expect(result?.map((agent) => agent.id)).toEqual(["late"]);
  });

  it("returns undefined instead of guessing when the directory exceeds the page cap", async () => {
    const pages = Array.from({ length: CENSUS_MAX_PAGES }, () => ({ entries: [] as { agent: CensusAgent }[], pageInfo: { hasMore: true, nextCursor: `c-${Math.random()}` } }));
    expect(await readCensus(source(pages), "wks-1")).toBeUndefined();
  });

  it("returns undefined when the directory repeats a cursor", async () => {
    const result = await readCensus(
      source([
        { entries: [], pageInfo: { hasMore: true, nextCursor: "same" } },
        { entries: [], pageInfo: { hasMore: true, nextCursor: "same" } },
      ]),
      "wks-1",
    );
    expect(result).toBeUndefined();
  });

  it("skips malformed rows without losing the rest", async () => {
    const rows = [
      { agent: { id: "" } as CensusAgent },
      { agent: undefined as unknown as CensusAgent },
      { agent: chat("good") },
    ];
    const result = await readCensus(source([{ entries: rows, pageInfo: { hasMore: false } }]), "wks-1");
    expect(result?.map((agent) => agent.id)).toEqual(["good"]);
  });

  it("keeps the directory order and returns an empty list for an empty workspace", async () => {
    const result = await readCensus(
      source([{ entries: [chat("first"), chat("second")].map((agent) => ({ agent })), pageInfo: { hasMore: false } }]),
      "wks-1",
    );
    expect(result?.map((agent) => agent.id)).toEqual(["first", "second"]);
    expect(await readCensus(source([{ entries: [], pageInfo: { hasMore: false } }]), "wks-1")).toEqual([]);
  });

  it("rejects a row with no id even when everything else looks usable", () => {
    expect(isUserChat({ id: "" })).toBe(false);
    expect(isUserChat(undefined as unknown as CensusAgent)).toBe(false);
  });
});
