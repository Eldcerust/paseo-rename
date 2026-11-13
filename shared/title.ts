/** The longest title the plugin writes. A sidebar row and a tab show about this much. */
export const TITLE_MAX_CHARS = 80;
/** Shorter than this is never a title. */
export const TITLE_MIN_CHARS = 3;
/** Paseo clamps the title it makes from a first prompt to this many characters. */
export const PROVISIONAL_TITLE_CHARS = 60;

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

/** The title Paseo gives a new chat: the first non-empty line of its prompt, collapsed, at most 60 characters. */
export function provisionalTitle(prompt: string, max = PROVISIONAL_TITLE_CHARS): string | undefined {
  const line = prompt
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (!line) return undefined;
  const clamped = collapse(line).slice(0, max).trim();
  return clamped === "" ? undefined : clamped;
}

/**
 * Whether a chat's current title looks machine-made, so an automatic rename may replace it:
 * it is empty, it is what Paseo made from the first prompt (or the start of it), or it is the
 * last title this plugin wrote. Anything else was typed by a person (or chosen on purpose by
 * another plugin), and only a person asking may replace it.
 */
export function isAutoTitle({ title, firstPrompt, lastWritten }: { title: string | null | undefined; firstPrompt?: string | null; lastWritten?: string | null }): boolean {
  const current = collapse(title ?? "");
  if (current === "") return true;
  if (lastWritten && current === collapse(lastWritten)) return true;
  if (firstPrompt) {
    const line = firstPrompt
      .split(/\r?\n/)
      .map((part) => collapse(part))
      .find((part) => part.length > 0);
    const start = current.replace(/(\.{3}|…)$/, "").trimEnd();
    if (line && start !== "" && line.startsWith(start)) return true;
  }
  return false;
}

const WRAPPERS: [string, string][] = [
  ['"', '"'],
  ["'", "'"],
  ["“", "”"],
  ["‘", "’"],
  ["`", "`"],
  ["**", "**"],
  ["__", "__"],
  ["*", "*"],
  ["_", "_"],
  ["「", "」"],
  ["«", "»"],
];
const REFUSAL = /^(i['’]?m sorry|i am sorry|sorry,|i can['’]?t\b|i cannot\b|i['’]?m unable|i am unable|as an ai\b|unfortunately,)/i;
/** What a model says when it has nothing: never worth replacing a real title with. */
const PLACEHOLDER = /^(n\/?a|none|null|undefined|untitled|no title|new chat|chat|conversation|title)$/i;
const CONTROL =/[\u0000-\u001f\u007f]/g;

function unwrapJson(text: string): string {
  if (!text.startsWith("{")) return text;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && "title" in parsed && typeof parsed.title === "string") return parsed.title;
  } catch {
    // Not JSON after all: treat it as the text it is.
  }
  return text;
}

function firstLine(reply: string): string {
  const lines = reply
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !/^```/.test(line));
  const [first, second] = lines;
  if (first === undefined) return "";
  // "Here is the title:" then the title on the next line.
  if (second !== undefined && /:$/.test(first) && first.length < 60 && !/^(title|chat title)\s*:$/i.test(first)) return second;
  if (second !== undefined && /^(title|chat title)\s*:$/i.test(first)) return second;
  return first;
}

function unwrap(text: string): string {
  let current = text.trim();
  for (let round = 0; round < 4; round++) {
    const wrapper = WRAPPERS.find(([open, close]) => current.length > open.length + close.length && current.startsWith(open) && current.endsWith(close));
    if (!wrapper) break;
    current = current.slice(wrapper[0].length, current.length - wrapper[1].length).trim();
  }
  return current;
}

/**
 * Replies that are the assistant talking instead of titling: first person, an offer or a question to the person,
 * a greeting or a thank-you, or more than one sentence. A title is one short phrase. Observed on a real helper:
 * "I'm in Plan mode and there's no new request to work on. Tell me what you'd like planned...". Kept narrow so a
 * title that only looks like speech still works ("Let's Encrypt certificate renewal", "Sure Footing: hiking app").
 */
const ASSISTANT_VOICE: RegExp[] = [
  /^i(?:['’](?:m|ll|ve|d)\b| (?:am|will|can|have|would|need|see|think|could|don['’]t|do not|cannot|can['’]t)\b)/i,
  /^let me\b/i,
  /^(?:sure|certainly|of course|okay|ok|absolutely)[,!.]/i,
  /^here(?:['’]s| is| are)\b/i,
  /^there(?:['’]s| is| are) no\b/i,
  /^no (?:new )?(?:request|message|task|content|conversation)\b/i,
  /^(?:how can i|could you|can you|would you|what would you)\b/i,
  /^thank(?:s| you)(?:\s+(?:for|so much)\b|[,!.])/i,
  /\b(?:tell me what|let me know|what you['’]d like|what you would like|how can i (?:help|assist))\b/i,
  /[.!?]["'”’)\]]*\s+\p{Lu}/u,
];
const looksLikeAnswer = (text: string) => ASSISTANT_VOICE.some((voice) => voice.test(text));

/** Cuts at a word boundary when one is near the end, never inside a surrogate pair. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = text.slice(0, max);
  const space = end.lastIndexOf(" ");
  if (space >= max * 0.5) end = end.slice(0, space);
  const last = end.charCodeAt(end.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) end = end.slice(0, -1);
  return end;
}

/** Whether a model's reply can be cleaned into a title. The helper runner uses it to pick the right one of its messages. */
export const isUsableTitle = (reply: string): boolean => sanitizeTitle(reply) !== undefined;

/**
 * Cleans a model's reply into a chat title, or returns undefined when there is none worth using:
 * empty, a refusal, or too short. Takes the first line (skipping a lead-in such as "Here is the
 * title:"), drops a "Title:" label, list marks, markdown, quotes and a trailing period, and cuts
 * to `maxChars` at a word boundary. A bad reply must never replace a good title.
 */
export function sanitizeTitle(reply: string, maxChars: number = TITLE_MAX_CHARS): string | undefined {
  // A reasoning model may leak its thinking into the reply; the title is what comes after it.
  let text = reply.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  if (/^<think>/i.test(text)) return undefined;
  text = unwrapJson(text);
  text = firstLine(text);
  text = text.replace(/^(chat\s+)?title\s*[:\-–—]\s*/i, "");
  text = text.replace(/^(#{1,6}\s+|>\s+|[-*•]\s+|\d{1,2}[.)]\s+)/, "");
  text = unwrap(text);
  text = text.replace(CONTROL, " ");
  text = collapse(text);
  text = text.replace(/^(chat\s+)?title\s*[:\-–—]\s*/i, "");
  text = unwrap(text);
  text = text.replace(/[\s.,;:。、]+$/u, "");
  // Judged before the cut, so a long answer cannot be shortened into something that looks like a title.
  if (looksLikeAnswer(text)) return undefined;
  text = cut(text, maxChars).replace(/[\s.,;:。、\-–—]+$/u, "");
  if (text.length < TITLE_MIN_CHARS) return undefined;
  if (!/[\p{L}\p{N}]/u.test(text)) return undefined;
  if (REFUSAL.test(text) || PLACEHOLDER.test(text)) return undefined;
  return text;
}
