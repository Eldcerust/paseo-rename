import type { CensusAgent } from "./census";
import { readFirstPrompt, type TimelineSource } from "./messages";

/** What one live chat contributes to the project's name. */
export interface ProjectEvidence {
  id: string;
  /** The chat's current title, when it has one. */
  title?: string;
  /** The first thing the user said, read only when the chat has no title. */
  firstPrompt?: string;
}

/** How many live chats a project summary reads. Beyond this the oldest rows are left out. */
export const MAX_EVIDENCE_CHATS = 12;
const MAX_PROMPT_CHARS = 400;

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * The evidence for a project title, one entry per live chat, in census order. A titled chat costs
 * nothing more; an untitled chat contributes its first prompt, and an unreadable timeline contributes
 * no prompt rather than failing the whole project rename. The list is bounded so a workspace with
 * hundreds of chats cannot turn one rename into hundreds of timeline reads.
 */
export async function gatherEvidence(
  source: TimelineSource,
  chats: readonly CensusAgent[],
  { maxChats = MAX_EVIDENCE_CHATS }: { maxChats?: number } = {},
): Promise<ProjectEvidence[]> {
  const bounded = chats.slice(0, Math.max(0, maxChats));
  const evidence: ProjectEvidence[] = [];
  for (const chat of bounded) {
    const title = collapse(chat.title ?? "");
    if (title !== "") {
      evidence.push({ id: chat.id, title });
      continue;
    }
    let firstPrompt: string | undefined;
    try {
      firstPrompt = collapse((await readFirstPrompt(source, chat.id)) ?? "").slice(0, MAX_PROMPT_CHARS);
    } catch {
      // A chat whose timeline cannot be read still contributes its place in the count.
    }
    evidence.push({ id: chat.id, ...(firstPrompt ? { firstPrompt } : {}) });
  }
  return evidence;
}
