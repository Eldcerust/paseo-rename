import type { ChatTitleValues } from "../shared/settings";
import type { RetitleSource, TargetOutcome } from "../shared/types";
import type { ResolvedModel } from "./catalog";
import { readCensus, type CensusAgent, type CensusSource } from "./census";
import { gatherEvidence, MAX_EVIDENCE_CHATS, type ProjectEvidence } from "./evidence";
import type { TimelinePage, TimelineRequest } from "./messages";
import type { ProjectModelRunner, ProjectTitles } from "./project-title";
import type { StateStore } from "./state";

/** The part of one agent a project rename reads. The daemon's fuller snapshot is assignable to it. */
export interface ProjectAgentView {
  id: string;
  title?: string | null;
  workspaceId?: string | null;
  archivedAt?: string | null;
  labels?: Record<string, string> | null;
  cwd?: string | null;
}

export interface ProjectAgentRef {
  refresh(): Promise<{ agent: ProjectAgentView } | null>;
  timeline: { refetch(request: TimelineRequest): Promise<TimelinePage> };
}

/** The part of the daemon connection that applying a project title needs. */
export interface ProjectSource {
  agents: {
    list: CensusSource["agents"]["list"];
    ref(agentId: string): ProjectAgentRef;
  };
  workspaces: {
    ref(workspaceId: string): {
      setTitle(title: string): Promise<{ title: string | null }>;
      refresh(): Promise<{ title?: string | null; name?: string | null } | null>;
    };
  };
}

export interface ProjectApplyDeps {
  settings: ChatTitleValues;
  state: StateStore;
  titles: ProjectTitles;
  runModel: ProjectModelRunner;
  model: ResolvedModel;
  now?: () => Date;
  scratchRoot?: string;
}

export interface ProjectApplyInput {
  agentId: string;
  /** The title just written to the chat; a single-chat project reuses it. */
  chatTitle: string;
  workspaceId: string | null;
  source: RetitleSource;
  signal?: AbortSignal;
}

export interface ProjectApplyResult {
  workspace: TargetOutcome;
  /** The project title that was written or already present, when one was resolved. */
  title?: string;
  /** How many live chats the decision saw. */
  chats: number;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const failed = (detail: string): TargetOutcome => ({ status: "failed", detail });
const skipped = (detail: string): TargetOutcome => ({ status: "skipped", detail });
const titleOf = (workspace: { title?: string | null; name?: string | null } | null) => {
  const value = (workspace?.title ?? workspace?.name ?? "").trim();
  return value === "" ? null : value;
};

/**
 * Names the workspace from its live chats.
 *
 * One live chat reuses the chat title, so a solo project costs no model run. Two or more run one
 * summary over every live chat. Automatic renaming leaves a project alone when a person renamed it
 * since this plugin last wrote it, including while the summary is running; a person asking may
 * replace their own name. The chat and workspace writes are independent, and this never throws.
 */
export async function applyProjectTitle(
  source: ProjectSource,
  deps: ProjectApplyDeps,
  input: ProjectApplyInput,
): Promise<ProjectApplyResult> {
  const { settings, state } = deps;
  const cancelled = () => input.signal?.aborted;
  const now = deps.now ?? (() => new Date());

  if (!settings.targets.workspace) return { workspace: skipped("Turned off in the settings."), chats: 0 };
  if (!input.workspaceId) return { workspace: skipped("The chat has no workspace."), chats: 0 };
  if (cancelled()) return { workspace: skipped("The rename was cancelled."), chats: 0 };

  let census: CensusAgent[] | undefined;
  try {
    census = await readCensus(source, input.workspaceId);
  } catch (error) {
    return { workspace: failed(message(error)), chats: 0 };
  }
  if (!census) {
    return { workspace: skipped("There are too many chats to read the project's live chats, so the project name was left alone."), chats: 0 };
  }
  const listed = census.some((chat) => chat.id === input.agentId)
    ? census
    : [...census, { id: input.agentId, workspaceId: input.workspaceId, title: input.chatTitle }];
  // The directory can still show the previous title while this rename lands, so the fresh title always wins.
  const chats = listed.map((chat) => (chat.id === input.agentId ? { ...chat, title: input.chatTitle } : chat));

  let evidence: ProjectEvidence[] = [];
  try {
    evidence = await gatherEvidence(source, chats);
  } catch {
    // The chat title is still enough to name a single-chat project; a failed read must not undo this rename.
  }
  if (!evidence.some((chat) => chat.id === input.agentId)) evidence.unshift({ id: input.agentId, title: input.chatTitle });
  evidence = evidence.slice(0, Math.max(MAX_EVIDENCE_CHATS, 1));
  if (cancelled()) return { workspace: skipped("The rename was cancelled."), chats: chats.length };

  const workspace = source.workspaces.ref(input.workspaceId);
  let before: { title?: string | null; name?: string | null } | null;
  try {
    before = await workspace.refresh();
  } catch (error) {
    return { workspace: failed(message(error)), chats: chats.length };
  }
  const beforeTitle = titleOf(before);

  const memory = await state.workspace(input.workspaceId);
  const seeded = memory?.title ?? (await state.get(input.agentId)).workspaceTitle;
  if (input.source === "auto" && seeded && beforeTitle && beforeTitle !== seeded) {
    return { workspace: skipped("The workspace was renamed by you, so automatic renaming leaves it alone."), chats: chats.length };
  }
  if (cancelled()) return { workspace: skipped("The rename was cancelled."), chats: chats.length };

  const resolved = await deps.titles.resolve(deps.runModel, {
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    chatTitle: input.chatTitle,
    evidence,
    currentTitle: beforeTitle,
    model: deps.model,
    signal: input.signal,
    scratchRoot: deps.scratchRoot,
  });
  if (!resolved.title) return { workspace: failed(resolved.error ?? "The project title could not be written."), chats: chats.length };
  if (cancelled()) return { workspace: skipped("The rename was cancelled."), title: resolved.title, chats: chats.length };

  // The summary takes time. Never overwrite a name a person set while it ran, and never write the same name twice.
  let after: { title?: string | null; name?: string | null } | null;
  try {
    after = await workspace.refresh();
  } catch (error) {
    return { workspace: failed(message(error)), title: resolved.title, chats: chats.length };
  }
  const afterTitle = titleOf(after);
  if (input.source === "auto" && afterTitle !== beforeTitle && afterTitle !== resolved.title) {
    return { workspace: skipped("The workspace was renamed while the project title was being written, so it was left alone."), title: resolved.title, chats: chats.length };
  }

  const remember = async (title: string) => {
    try {
      await state.setWorkspace(input.workspaceId!, title, now().toISOString());
    } catch (error) {
      // The write already succeeded; a memory failure must not report the rename as failed.
      console.error("[chat-title] could not remember the project title", error);
    }
  };

  if (afterTitle === resolved.title) {
    await remember(resolved.title);
    return { workspace: { status: "unchanged" }, title: resolved.title, chats: chats.length };
  }

  try {
    const result = await workspace.setTitle(resolved.title);
    if (result.title !== resolved.title) {
      return { workspace: failed("The daemon did not keep the new project name."), title: resolved.title, chats: chats.length };
    }
  } catch (error) {
    return { workspace: failed(message(error)), title: resolved.title, chats: chats.length };
  }

  await remember(resolved.title);
  const used = evidence.length;
  const detail = used > 1
    ? chats.length > used
      ? `Named from ${used} of ${chats.length} live chats.`
      : `Named from ${chats.length} live chats.`
    : undefined;
  return {
    workspace: { status: "renamed", ...(detail ? { detail } : {}) },
    title: resolved.title,
    chats: chats.length,
  };
}
