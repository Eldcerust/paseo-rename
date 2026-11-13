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
}

export interface TimelineRequest {
  direction: "tail" | "before";
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
