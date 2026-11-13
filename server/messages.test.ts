import { describe, expect, it } from "vitest";
import type { TimelineEntryLike } from "../shared/window";
import { MAX_PAGES, PAGE_ROWS, readWindow, type TimelinePage, type TimelineRequest, type TimelineSource } from "./messages";

const user = (text: string, turnId?: string): TimelineEntryLike => ({ turnId, item: { type: "user_message", text } });
const reply = (text: string, turnId?: string): TimelineEntryLike => ({ turnId, item: { type: "assistant_message", text } });
const tool = (turnId?: string): TimelineEntryLike => ({ turnId, item: { type: "tool_call" } });

/** A daemon that serves the given pages, newest first, and records what was asked. */
function fakeSource(pages: TimelinePage[]) {
  const requests: TimelineRequest[] = [];
  const asked: string[] = [];
  const source: TimelineSource = {
    agents: {
      ref(agentId) {
        asked.push(agentId);
        return {
          timeline: {
            async refetch(request) {
              requests.push(request);
              const page = pages[requests.length - 1];
              if (!page) throw new Error("the reader asked for a page that does not exist");
              return page;
            },
          },
        };
      },
    },
  };
  return { source, requests, asked };
}

const cursor = (seq: number) => ({ epoch: "e1", seq });
const request = { messages: 3, charsPerMessage: 600 };

describe("readWindow", () => {
  it("returns the last messages of a chat that fits one page, without asking for more", async () => {
    const { source, requests } = fakeSource([
      { entries: [user("q1", "t1"), reply("a1", "t1"), user("q2", "t2"), reply("a2", "t2")], hasOlder: true, startCursor: cursor(10) },
    ]);
    const result = await readWindow(source, "agent-1", { messages: 2, charsPerMessage: 600 });
    expect(result.messages.map((message) => message.text)).toEqual(["q2", "a2"]);
    expect(requests).toHaveLength(1);
    expect(result.reachedStart).toBe(false);
  });

  it("asks for projected pages of the tail, then pages back from the previous page's start cursor", async () => {
    // One chat, oldest to newest: u1 a1 tool u2 a2 u3 tool tool a3. Pages are cut from the end.
    const { source, requests, asked } = fakeSource([
      { entries: [tool("t3"), tool("t3"), reply("a3", "t3")], hasOlder: true, startCursor: cursor(200) },
      { entries: [user("q2", "t2"), tool("t2"), reply("a2", "t2"), user("q3", "t3")], hasOlder: true, startCursor: cursor(100) },
      { entries: [user("q1", "t1"), reply("a1", "t1"), tool("t2")], hasOlder: false, startCursor: cursor(1) },
    ]);
    const result = await readWindow(source, "agent-9", { messages: 4, charsPerMessage: 600 });
    expect(asked).toEqual(["agent-9"]);
    expect(requests).toEqual([
      { direction: "tail", limit: PAGE_ROWS, projection: "projected" },
      { direction: "before", cursor: cursor(200), limit: PAGE_ROWS, projection: "projected" },
      { direction: "before", cursor: cursor(100), limit: PAGE_ROWS, projection: "projected" },
    ]);
    expect(result.messages.map((message) => message.text)).toEqual(["q2", "a2", "q3", "a3"]);
    expect(result.found).toBe(6);
    expect(result.reachedStart).toBe(true);
  });

  it("collects enough conversational messages when tool rows crowd the pages", async () => {
    const crowd = (n: number, turnId: string) => Array.from({ length: n }, () => tool(turnId));
    // Oldest to newest: ask1 answer1 (10 tool rows) ask2 (100 tool rows) answer2 ask3 (140 tool rows) answer3.
    const { source } = fakeSource([
      { entries: [...crowd(140, "t3"), reply("answer3", "t3")], hasOlder: true, startCursor: cursor(300) },
      { entries: [...crowd(100, "t2"), reply("answer2", "t2"), user("ask3", "t3")], hasOlder: true, startCursor: cursor(150) },
      { entries: [user("ask1", "t1"), reply("answer1", "t1"), ...crowd(10, "t1"), user("ask2", "t2")], hasOlder: false, startCursor: cursor(1) },
    ]);
    const result = await readWindow(source, "a", { messages: 4, charsPerMessage: 600 });
    expect(result.messages.map((message) => message.text)).toEqual(["ask2", "answer2", "ask3", "answer3"]);
    expect(result.found).toBe(6);
  });

  it("joins an assistant reply that straddles a page boundary into one message", async () => {
    const { source } = fakeSource([
      { entries: [tool("t1"), reply("second half", "t1"), user("q2", "t2"), reply("a2", "t2")], hasOlder: true, startCursor: cursor(50) },
      { entries: [user("q1", "t1"), reply("first half", "t1")], hasOlder: false, startCursor: cursor(1) },
    ]);
    const result = await readWindow(source, "a", request);
    expect(result.messages).toEqual([
      { role: "assistant", text: "first half\n\nsecond half" },
      { role: "user", text: "q2" },
      { role: "assistant", text: "a2" },
    ]);
  });

  it("never returns the possibly partial oldest message when it has one to spare", async () => {
    const { source, requests } = fakeSource([
      { entries: [reply("only the end of a long reply", "t1"), user("q2", "t2"), reply("a2", "t2"), user("q3", "t3")], hasOlder: true, startCursor: cursor(50) },
    ]);
    const result = await readWindow(source, "a", request);
    expect(requests).toHaveLength(1);
    expect(result.messages.map((message) => message.text)).toEqual(["q2", "a2", "q3"]);
  });

  it("stops when the chat starts and says so", async () => {
    const { source, requests } = fakeSource([{ entries: [user("q1", "t1"), reply("a1", "t1")], hasOlder: false, startCursor: cursor(1) }]);
    const result = await readWindow(source, "a", request);
    expect(requests).toHaveLength(1);
    expect(result).toMatchObject({ found: 2, reachedStart: true });
    expect(result.messages).toHaveLength(2);
  });

  it("returns nothing for an empty chat", async () => {
    const { source } = fakeSource([{ entries: [], hasOlder: false, startCursor: null }]);
    expect(await readWindow(source, "a", request)).toEqual({ messages: [], found: 0, reachedStart: true });
  });

  it("gives up after the page limit instead of reading a chat of endless tool rows forever", async () => {
    const pages: TimelinePage[] = Array.from({ length: MAX_PAGES + 5 }, (_, index) => ({ entries: [tool("t")], hasOlder: true, startCursor: cursor(1000 - index) }));
    const { source, requests } = fakeSource(pages);
    const result = await readWindow(source, "a", request);
    expect(requests).toHaveLength(MAX_PAGES);
    expect(result).toEqual({ messages: [], found: 0, reachedStart: false });
  });

  it("stops paging when the daemon gives no cursor to continue from", async () => {
    const { source, requests } = fakeSource([{ entries: [tool("t")], hasOlder: true, startCursor: null }]);
    const result = await readWindow(source, "a", request);
    expect(requests).toHaveLength(1);
    expect(result.reachedStart).toBe(false);
  });

  it("caps each returned message", async () => {
    const { source } = fakeSource([{ entries: [user("u".repeat(5000), "t1")], hasOlder: false, startCursor: cursor(1) }]);
    const result = await readWindow(source, "a", { messages: 5, charsPerMessage: 300 });
    expect(result.messages[0]?.text).toHaveLength(300);
  });

  it("passes a daemon error to the caller", async () => {
    const source: TimelineSource = { agents: { ref: () => ({ timeline: { refetch: async () => Promise.reject(new Error("daemon went away")) } }) } };
    await expect(readWindow(source, "a", request)).rejects.toThrow("daemon went away");
  });
});
