import type { WindowMessage } from "../shared/types";
import { takeWindow, toMessages, type TimelineEntryLike } from "../shared/window";

/** A position in a timeline, as the daemon hands it back for paging. */
export interface TimelineCursor {
  epoch: string;
  seq: number;
}

/** The part of a timeline page the reader needs. The daemon's page is assignable to it. */
export interface TimelinePage {
  entries: readonly TimelineEntryLike[];
  hasOlder: boolean;
  startCursor: TimelineCursor | null;
  /** Names the timeline's current history; a cursor is only valid with the epoch it came from. */
  epoch?: string;
}

export interface TimelineRequest {
  direction: "tail" | "before" | "after";
  cursor?: TimelineCursor;
  limit: number;
  projection: "projected";
}

/** The part of the daemon connection the reader needs, so tests can stand in a fake. */
export interface TimelineSource {
  agents: { ref(agentId: string): { timeline: { refetch(request: TimelineRequest): Promise<TimelinePage> } } };
}

export interface WindowRequest {
  /** How many messages to return at most. */
  messages: number;
  /** Each message is capped at this many characters. */
  charsPerMessage: number;
}

export interface ReadWindow {
  messages: WindowMessage[];
  /** How many conversational messages were found while reading (at least `messages` unless the chat is shorter). */
  found: number;
  /** True when the whole chat was read, so the window starts at the first message. */
  reachedStart: boolean;
}

/** Rows read from the start of a chat when looking for its first prompt: the prompt is the very first row or close to it. */
export const FIRST_ROWS = 40;

/**
 * The text of the first thing the user said in a chat, or undefined when it has none. It is read
 * from the start of the timeline directly, so it costs two small requests however long the chat is.
 * Used to tell the title Paseo made from that prompt apart from a title a person typed.
 */
export async function readFirstPrompt(source: TimelineSource, agentId: string): Promise<string | undefined> {
  const timeline = source.agents.ref(agentId).timeline;
  const tail = await timeline.refetch({ direction: "tail", limit: 1, projection: "projected" });
  if (!tail.epoch) return undefined;
  const start = await timeline.refetch({ direction: "after", cursor: { epoch: tail.epoch, seq: 0 }, limit: FIRST_ROWS, projection: "projected" });
  for (const entry of start.entries) {
    if (entry.item.type === "user_message" && entry.item.text?.trim()) return entry.item.text.trim();
  }
  return undefined;
}

/** Rows asked for per page. A page of agent work is mostly tool rows, so this is generous. */
export const PAGE_ROWS = 150;
/** Stops a runaway chat from being read forever: 12 pages is up to 1800 rows. */
export const MAX_PAGES = 12;

/**
 * Reads the last `messages` conversational messages of a chat, oldest first.
 *
 * The timeline is paged by rows, not messages, so this pages back until it has one message more
 * than needed (an assistant reply can straddle a page boundary, which makes the oldest message it
 * has seen possibly partial; the extra one is dropped) or the chat starts, or the page limit hits.
 */
export async function readWindow(source: TimelineSource, agentId: string, request: WindowRequest): Promise<ReadWindow> {
  const timeline = source.agents.ref(agentId).timeline;
  let page = await timeline.refetch({ direction: "tail", limit: PAGE_ROWS, projection: "projected" });
  let entries: TimelineEntryLike[] = [...page.entries];
  let pages = 1;
  let all = toMessages(entries);
  while (all.length < request.messages + 1 && page.hasOlder && page.startCursor && pages < MAX_PAGES) {
    page = await timeline.refetch({ direction: "before", cursor: page.startCursor, limit: PAGE_ROWS, projection: "projected" });
    entries = [...page.entries, ...entries];
    pages += 1;
    all = toMessages(entries);
  }
  return {
    messages: takeWindow(all, request.messages, request.charsPerMessage),
    found: all.length,
    reachedStart: !page.hasOlder,
  };
}
