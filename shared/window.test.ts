import { describe, expect, it } from "vitest";
import { capText, takeWindow, toMessages, type TimelineEntryLike } from "./window";

const user = (text: string, turnId?: string): TimelineEntryLike => ({ turnId, item: { type: "user_message", text } });
const reply = (text: string, turnId?: string): TimelineEntryLike => ({ turnId, item: { type: "assistant_message", text } });
const row = (type: string, turnId?: string): TimelineEntryLike => ({ turnId, item: { type } });
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

describe("toMessages", () => {
  it("turns user and assistant entries into messages in order", () => {
    expect(toMessages([user("How do I rename a chat?", "t1"), reply("Use the title field.", "t1"), user("Thanks", "t2")])).toEqual([
      { role: "user", text: "How do I rename a chat?" },
      { role: "assistant", text: "Use the title field." },
      { role: "user", text: "Thanks" },
    ]);
  });

  it("joins the assistant entries of one turn with a blank line, across tool and reasoning rows", () => {
    const messages = toMessages([
      user("Fix the bug", "t1"),
      row("reasoning", "t1"),
      reply("Looking at it.", "t1"),
      row("tool_call", "t1"),
      row("tool_call", "t1"),
      reply("Found it.", "t1"),
      row("tool_call", "t1"),
      reply("Fixed.", "t1"),
    ]);
    expect(messages).toEqual([
      { role: "user", text: "Fix the bug" },
      { role: "assistant", text: "Looking at it.\n\nFound it.\n\nFixed." },
    ]);
  });

  it("keeps the assistant entries of different turns apart", () => {
    const messages = toMessages([reply("First answer", "t1"), reply("Second answer", "t2")]);
    expect(messages.map((message) => message.text)).toEqual(["First answer", "Second answer"]);
  });

  it("merges adjacent assistant entries that carry no turn id, but never across a user message", () => {
    const messages = toMessages([reply("a"), reply("b"), user("question"), reply("c")]);
    expect(messages).toEqual([
      { role: "assistant", text: "a\n\nb" },
      { role: "user", text: "question" },
      { role: "assistant", text: "c" },
    ]);
  });

  it("ignores every row that is not a message", () => {
    const rows = ["tool_call", "reasoning", "todo", "plugin", "notification", "error", "compaction"].map((type) => row(type, "t1"));
    expect(toMessages(rows)).toEqual([]);
    expect(toMessages([...rows, user("Only this", "t1")])).toEqual([{ role: "user", text: "Only this" }]);
  });

  it("drops empty and whitespace-only text and trims the rest", () => {
    expect(toMessages([user("   \n  "), reply(""), user("  padded  "), reply("\n\nanswer\n", "t1")])).toEqual([
      { role: "user", text: "padded" },
      { role: "assistant", text: "answer" },
    ]);
  });

  it("does not let an empty assistant row split a turn", () => {
    expect(toMessages([reply("one", "t1"), reply("   ", "t1"), reply("two", "t1")])).toEqual([{ role: "assistant", text: "one\n\ntwo" }]);
  });
});

describe("capText", () => {
  it("returns text within the limit unchanged", () => {
    expect(capText("short", 600)).toBe("short");
    expect(capText("x".repeat(600), 600)).toBe("x".repeat(600));
  });

  it("keeps the beginning and the end of long text and is exactly the limit long", () => {
    const text = `START${"m".repeat(2000)}END`;
    const capped = capText(text, 100);
    expect(capped).toHaveLength(100);
    expect(capped.startsWith("START")).toBe(true);
    expect(capped.endsWith("END")).toBe(true);
    expect(capped).toContain(" … ");
  });

  it("gives the beginning about 70% of the room", () => {
    const capped = capText(`${"a".repeat(1000)}${"z".repeat(1000)}`, 103);
    const [head, tail] = capped.split(" … ");
    expect(head).toBe("a".repeat(70));
    expect(tail).toBe("z".repeat(30));
  });

  it("never leaves half an emoji at either cut", () => {
    const atHead = `${"a".repeat(67)}😀${"b".repeat(300)}`;
    const atTail = `${"b".repeat(300)}😀${"c".repeat(28)}`;
    for (const text of [atHead, atTail]) {
      const capped = capText(text, 100);
      expect(capped.length).toBeLessThanOrEqual(100);
      expect(LONE_SURROGATE.test(capped)).toBe(false);
    }
  });
});

describe("takeWindow", () => {
  const messages = ["m1", "m2", "m3", "m4", "m5"].map((text, index) => ({ role: index % 2 === 0 ? ("user" as const) : ("assistant" as const), text }));

  it("keeps the last messages in order", () => {
    expect(takeWindow(messages, 3, 600).map((message) => message.text)).toEqual(["m3", "m4", "m5"]);
  });

  it("returns every message when the chat is shorter than the window", () => {
    expect(takeWindow(messages, 40, 600)).toHaveLength(5);
  });

  it("returns nothing for a window of zero", () => {
    expect(takeWindow(messages, 0, 600)).toEqual([]);
  });

  it("caps each message and keeps its role", () => {
    const window = takeWindow([{ role: "assistant", text: "w".repeat(5000) }], 1, 200);
    expect(window[0]?.role).toBe("assistant");
    expect(window[0]?.text).toHaveLength(200);
  });
});
