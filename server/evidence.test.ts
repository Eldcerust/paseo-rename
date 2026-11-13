import { describe, expect, it, vi } from "vitest";
import type { CensusAgent } from "./census";
import { MAX_EVIDENCE_CHATS, gatherEvidence } from "./evidence";
import type { TimelineSource } from "./messages";

const chat = (id: string, overrides: Partial<CensusAgent> = {}): CensusAgent => ({ id, workspaceId: "wks-1", title: `Chat ${id}`, ...overrides });

function timelines(prompts: Record<string, string | Error>): TimelineSource {
  return {
    agents: {
      ref: (id: string) => ({
        timeline: {
          refetch: async (request) => {
            if (request.direction === "tail") return { entries: [], hasOlder: true, startCursor: null, epoch: "e1" };
            const value = prompts[id];
            if (value instanceof Error) throw value;
            return {
              entries: value ? [{ turnId: "t0", item: { type: "user_message", text: value } }] : [],
              hasOlder: false,
              startCursor: null,
            };
          },
        },
      }),
    },
  };
}

describe("project evidence", () => {
  it("uses a title without reading that chat's timeline", async () => {
    const read = vi.fn(() => { throw new Error("timeline must not be read"); });
    const source = { agents: { ref: () => ({ timeline: { refetch: read } }) } } as unknown as TimelineSource;
    expect(await gatherEvidence(source, [chat("a", { title: "  Fix the exporter  " })])).toEqual([{ id: "a", title: "Fix the exporter" }]);
    expect(read).not.toHaveBeenCalled();
  });

  it("reads the first prompt only for a chat without a title", async () => {
    const evidence = await gatherEvidence(timelines({ a: "  Add a shared project name.\nSecond line " }), [chat("a", { title: null }), chat("b")]);
    expect(evidence).toEqual([
      { id: "a", firstPrompt: "Add a shared project name. Second line" },
      { id: "b", title: "Chat b" },
    ]);
  });

  it("tolerates a timeline that cannot be read and still keeps the chat's place", async () => {
    const evidence = await gatherEvidence(timelines({ a: new Error("daemon unreachable") }), [chat("a", { title: "" }), chat("b")]);
    expect(evidence).toEqual([{ id: "a" }, { id: "b", title: "Chat b" }]);
  });

  it("caps the evidence at the most recently active chats", async () => {
    const chats = Array.from({ length: MAX_EVIDENCE_CHATS + 5 }, (_, index) => chat(`c${index}`, { title: `Title ${index}` }));
    const evidence = await gatherEvidence(timelines({}), chats);
    expect(evidence).toHaveLength(MAX_EVIDENCE_CHATS);
    expect(evidence[0]).toEqual({ id: "c0", title: "Title 0" });
    expect(evidence.at(-1)).toEqual({ id: `c${MAX_EVIDENCE_CHATS - 1}`, title: `Title ${MAX_EVIDENCE_CHATS - 1}` });
  });

  it("returns no evidence for no chats", async () => {
    expect(await gatherEvidence(timelines({}), [])).toEqual([]);
  });
});
