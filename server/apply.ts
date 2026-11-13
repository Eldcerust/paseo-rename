import type { TargetOutcome } from "../shared/types";
import type { Paseo } from "./llm";

/** The part of the daemon connection that applying a title uses. The SDK's `paseo` is assignable to it (see `asApply`). */
export interface ApplyPaseo {
  agents: {
    list(options: { page: { limit: number; cursor?: string } }): Promise<{
      entries: readonly { agent: { id: string; workspaceId?: string | null; archivedAt?: string | null } }[];
      pageInfo?: { nextCursor?: string | null; hasMore?: boolean };
    }>;
    ref(agentId: string): { refresh(): Promise<{ agent: { title?: string | null } } | null> };
  };
  workspaces: {
    ref(workspaceId: string): {
      setTitle(title: string | null): Promise<{ title: string | null }>;
      refresh(): Promise<{ title?: string | null; name?: string | null } | null>;
    };
  };
}

/** The real SDK connection as the apply step's narrow view, checked by the compiler. */
export const asApply = (paseo: Paseo): ApplyPaseo => paseo;

/** Sets a chat's own title. In production this is the Paseo command; tests pass a fake. */
export type SetChatTitle = (agentId: string, title: string) => Promise<void>;

export interface ApplyInput {
  agentId: string;
  workspaceId: string | null;
  title: string;
  /** The chat's title now, so an identical one is not written again. */
  currentChatTitle: string | null;
  targets: { chat: boolean; workspace: boolean };
  /** Internal lifetime guard: never start a title write after plugin teardown began. */
  signal?: AbortSignal;
}

export interface ApplyResult {
  chat: TargetOutcome;
  workspace: TargetOutcome;
}

const PAGE = 200;
const MAX_PAGES = 10;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const failed = (error: unknown): TargetOutcome => ({ status: "failed", detail: message(error) });
const skipped = (detail: string): TargetOutcome => ({ status: "skipped", detail });

/** How many other unarchived chats live in a workspace, or undefined when there are too many pages to tell. */
async function otherChatsIn(paseo: ApplyPaseo, workspaceId: string, agentId: string): Promise<number | undefined> {
  let others = 0;
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await paseo.agents.list({ page: { limit: PAGE, ...(cursor ? { cursor } : {}) } });
    for (const { agent } of result.entries) if (agent.workspaceId === workspaceId && !agent.archivedAt && agent.id !== agentId) others += 1;
    cursor = result.pageInfo?.nextCursor ?? undefined;
    if (!cursor || result.pageInfo?.hasMore === false) return others;
  }
  return undefined;
}

async function applyToChat(deps: { paseo: ApplyPaseo; setChatTitle: SetChatTitle }, input: ApplyInput): Promise<TargetOutcome> {
  if (input.signal?.aborted) return skipped("The rename was cancelled.");
  if (!input.targets.chat) return skipped("Turned off in the settings.");
  if (input.currentChatTitle === input.title) return { status: "unchanged" };
  try {
    await deps.setChatTitle(input.agentId, input.title);
    const seen = (await deps.paseo.agents.ref(input.agentId).refresh())?.agent.title;
    if (seen !== input.title) return { status: "failed", detail: "The command finished, but the daemon does not show the new title." };
    return { status: "renamed" };
  } catch (error) {
    return failed(error);
  }
}

async function applyToWorkspace(paseo: ApplyPaseo, input: ApplyInput): Promise<TargetOutcome> {
  if (input.signal?.aborted) return skipped("The rename was cancelled.");
  if (!input.targets.workspace) return skipped("Turned off in the settings.");
  if (!input.workspaceId) return skipped("The chat has no workspace.");
  try {
    const others = await otherChatsIn(paseo, input.workspaceId, input.agentId);
    if (others === undefined) return skipped("There are too many chats to check whether the workspace is shared.");
    if (others > 0) return skipped(`${others === 1 ? "Another chat uses" : `${others} other chats use`} this workspace, so its name was left alone.`);
    const workspace = paseo.workspaces.ref(input.workspaceId);
    const current = await workspace.refresh();
    if (input.signal?.aborted) return skipped("The rename was cancelled.");
    if (current && (current.title ?? current.name) === input.title) return { status: "unchanged" };
    const result = await workspace.setTitle(input.title);
    if (result.title !== input.title) return { status: "failed", detail: "The daemon did not keep the new workspace title." };
    return { status: "renamed" };
  } catch (error) {
    return failed(error);
  }
}

/**
 * Writes a title to the chat and to its workspace row, as the settings allow. The two are
 * independent: one failing never undoes or blocks the other, and neither throws.
 */
export async function applyTitle(deps: { paseo: ApplyPaseo; setChatTitle: SetChatTitle }, input: ApplyInput): Promise<ApplyResult> {
  const [chat, workspace] = await Promise.all([applyToChat(deps, input), applyToWorkspace(deps.paseo, input)]);
  return { chat, workspace };
}
