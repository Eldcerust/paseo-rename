import { isHelperAgent } from "./llm";

/** The part of one agent the census reads. The daemon's list entries are assignable to it. */
export interface CensusAgent {
  id: string;
  title?: string | null;
  workspaceId?: string | null;
  archivedAt?: string | null;
  parentAgentId?: string | null;
  internal?: boolean;
  labels?: Record<string, string> | null;
  cwd?: string | null;
}

/** The part of the daemon connection the census needs. */
export interface CensusSource {
  agents: {
    list(options: { page: { limit: number; cursor?: string } }): Promise<{
      entries: readonly { agent: CensusAgent }[];
      pageInfo?: { nextCursor?: string | null; hasMore?: boolean } | null;
    }>;
  };
}

/** Rows asked for per page. The directory is page-sized by the daemon. */
export const CENSUS_PAGE = 200;
/** Pages the census will read before refusing to guess: up to 2,000 agents. */
export const CENSUS_MAX_PAGES = 10;

/**
 * Whether an agent is a person's live chat rather than one of the plugin's helpers, a subagent,
 * an internal agent, or an archived session. A missing row is never a user chat.
 */
export function isUserChat(agent: CensusAgent): boolean {
  if (typeof agent?.id !== "string" || agent.id === "") return false;
  if (agent.archivedAt) return false;
  if (agent.internal) return false;
  if (agent.parentAgentId) return false;
  if (agent.labels?.["paseo.parent-agent-id"]) return false;
  if (agent.labels?.["chat-title"] === "helper") return false;
  if (agent.title?.startsWith("[Chat titles]")) return false;
  if (isHelperAgent(agent)) return false;
  return true;
}

/**
 * Every live user chat in one workspace, in the directory's order (most recently active first),
 * or undefined when the directory has more pages than the census will read or repeats a cursor.
 * Archiving and other workspaces are filtered here so callers never see a chat they did not ask for.
 */
export async function readCensus(source: CensusSource, workspaceId: string): Promise<CensusAgent[] | undefined> {
  if (!workspaceId) return [];
  const all: CensusAgent[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < CENSUS_MAX_PAGES; page++) {
    const result = await source.agents.list({ page: { limit: CENSUS_PAGE, ...(cursor ? { cursor } : {}) } });
    for (const entry of result.entries ?? []) {
      const agent = entry?.agent;
      if (agent && typeof agent.id === "string" && agent.id !== "") all.push(agent);
    }
    const next = result.pageInfo?.nextCursor ?? undefined;
    if (!result.pageInfo?.hasMore || !next) {
      return all.filter((agent) => agent.workspaceId === workspaceId && isUserChat(agent));
    }
    if (cursors.has(next)) return undefined;
    cursors.add(next);
    cursor = next;
  }
  return undefined;
}
