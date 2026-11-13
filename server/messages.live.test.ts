import type { PaseoClient } from "@getpaseo/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { windowDefaults } from "../shared/settings";
import { LIVE, connectLive } from "./live-client";
import { readFirstPrompt, readWindow } from "./messages";

const { messages: WINDOW, charsPerMessage: CAP } = windowDefaults;

/**
 * An independent count of a chat's conversational messages: one request for every row (limit 0),
 * then user rows and assistant turns counted by hand, with no paging involved.
 */
async function messagesInChat(paseo: PaseoClient, agentId: string): Promise<number> {
  const page = await paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 0, projection: "projected" });
  let count = 0;
  let previousAssistantTurn: string | undefined;
  let previousWasAssistant = false;
  for (const entry of page.entries) {
    const item = entry.item;
    if (item.type === "user_message" && item.text.trim() !== "") {
      count += 1;
      previousWasAssistant = false;
    } else if (item.type === "assistant_message" && item.text.trim() !== "") {
      if (!(previousWasAssistant && entry.turnId === previousAssistantTurn)) count += 1;
      previousWasAssistant = true;
      previousAssistantTurn = entry.turnId;
    }
  }
  return count;
}

describe.skipIf(!LIVE)("reading a window from chats on the local daemon", () => {
  let paseo: PaseoClient;
  const chats: { id: string; expected: number }[] = [];

  beforeAll(async () => {
    paseo = await connectLive();
    const list = await paseo.agents.list({});
    const recent = list.entries.map((entry) => entry.agent).filter((agent) => !agent.archivedAt).slice(0, 12);
    for (const agent of recent) chats.push({ id: agent.id, expected: await messagesInChat(paseo, agent.id) });
  }, 120_000);

  afterAll(async () => {
    await paseo?.close();
  });

  it("returns exactly the requested number of messages for every chat that has that many", async () => {
    const long = chats.filter((chat) => chat.expected >= WINDOW);
    expect(long.length).toBeGreaterThanOrEqual(2);
    for (const chat of chats) {
      const result = await readWindow(paseo, chat.id, { messages: WINDOW, charsPerMessage: CAP });
      expect(result.messages.length, `chat ${chat.id.slice(0, 8)} has ${chat.expected} messages`).toBe(Math.min(WINDOW, chat.expected));
    }
  }, 120_000);

  it("returns non-empty messages of a known role, capped, with the chat's real total found when it reached the start", async () => {
    for (const chat of chats) {
      const result = await readWindow(paseo, chat.id, { messages: WINDOW, charsPerMessage: CAP });
      for (const message of result.messages) {
        expect(["user", "assistant"]).toContain(message.role);
        expect(message.text.trim()).not.toBe("");
        expect(message.text.length).toBeLessThanOrEqual(CAP);
      }
      if (result.reachedStart) expect(result.found).toBe(chat.expected);
      else expect(result.found).toBeGreaterThanOrEqual(WINDOW + 1);
    }
  }, 120_000);

  it("finds the same first prompt as a full read of the chat, which is the start of the title Paseo made", async () => {
    let checked = 0;
    for (const chat of chats) {
      const page = await paseo.agents.ref(chat.id).timeline.refetch({ direction: "tail", limit: 0, projection: "projected" });
      const expected = page.entries.find((entry) => entry.item.type === "user_message" && entry.item.text.trim() !== "");
      const found = await readFirstPrompt(paseo, chat.id);
      expect(found, `chat ${chat.id.slice(0, 8)}`).toBe(expected?.item.type === "user_message" ? expected.item.text.trim() : undefined);
      if (found) checked += 1;
    }
    expect(checked).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it("reads past one page of rows for a chat whose recent rows are mostly tool calls", async () => {
    const longest = [...chats].sort((a, b) => b.expected - a.expected)[0];
    expect(longest && longest.expected).toBeGreaterThan(WINDOW);
    const result = await readWindow(paseo, longest!.id, { messages: WINDOW, charsPerMessage: CAP });
    expect(result.messages).toHaveLength(WINDOW);
    expect(result.found).toBeGreaterThanOrEqual(WINDOW + 1);
  }, 120_000);
});
