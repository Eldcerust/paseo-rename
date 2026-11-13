import type { WindowMessage } from "./types";

/**
 * The window of a chat that a title is written from.
 *
 * A message is one user prompt, or everything the assistant said in one turn. Tool calls, reasoning
 * and the other timeline rows are not messages: in an agent chat they outnumber messages by about
 * 7 to 1 (p50; p90 is 47 to 1), so "the last N rows" would hold one or two messages.
 *
 * The defaults (10 messages, 600 characters each) come from measuring 20 real chats; the reasons
 * are in the README and next to `windowDefaults` in ./settings.
 */

/** The part of a timeline entry the window reads. The daemon's entries are assignable to it. */
export interface TimelineEntryLike {
  turnId?: string;
  item: { type: string; text?: string };
}

/**
 * Turns timeline entries, oldest first, into conversational messages: a user entry is one message;
 * the assistant entries of one turn are joined with a blank line. Tool, reasoning, todo and other
 * rows are skipped without ending a turn, and empty text is dropped.
 */
export function toMessages(entries: readonly TimelineEntryLike[]): WindowMessage[] {
  const messages: WindowMessage[] = [];
  let turn: string | undefined;
  for (const entry of entries) {
    const { type, text } = entry.item;
    if (type !== "user_message" && type !== "assistant_message") continue;
    const body = (text ?? "").trim();
    if (body === "") continue;
    if (type === "user_message") {
      messages.push({ role: "user", text: body });
      turn = undefined;
      continue;
    }
    const last = messages[messages.length - 1];
    const sameTurn = last?.role === "assistant" && entry.turnId === turn;
    if (sameTurn) last.text = `${last.text}\n\n${body}`;
    else messages.push({ role: "assistant", text: body });
    turn = entry.turnId;
  }
  return messages;
}

const ELLIPSIS = " … ";
const HEAD_SHARE = 0.7;

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * Shortens text to at most `limit` characters, keeping its beginning (70%) and its end (30%) with an
 * ellipsis between: what a message is about is usually said first, and its conclusion last.
 * Never splits an emoji or another surrogate pair.
 */
export function capText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const room = Math.max(0, limit - ELLIPSIS.length);
  let head = Math.ceil(room * HEAD_SHARE);
  let tail = room - head;
  if (head > 0 && isHighSurrogate(text.charCodeAt(head - 1))) head -= 1;
  if (tail > 0 && isLowSurrogate(text.charCodeAt(text.length - tail))) tail -= 1;
  const start = text.slice(0, head).trimEnd();
  const end = tail > 0 ? text.slice(text.length - tail).trimStart() : "";
  return `${start}${ELLIPSIS}${end}`.slice(0, limit);
}

/** The last `count` messages, each capped at `charsPerMessage`, in conversation order. */
export function takeWindow(messages: readonly WindowMessage[], count: number, charsPerMessage: number): WindowMessage[] {
  if (count < 1) return [];
  return messages.slice(-count).map((message) => ({ role: message.role, text: capText(message.text, charsPerMessage) }));
}
