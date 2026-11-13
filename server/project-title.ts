import { isUsableTitle, sanitizeTitle } from "../shared/title";
import type { ResolvedModel } from "./catalog";
import type { ProjectEvidence } from "./evidence";
import { buildProjectPrompt } from "./prompt";

/** Runs the title model. The retitler binds the daemon and its configured runner to this shape. */
export type ProjectModelRunner = (
  model: ResolvedModel,
  prompt: string,
  options: { signal?: AbortSignal; scratchRoot?: string; accept?: (reply: string) => boolean },
) => Promise<string>;

export interface ProjectTitleRequest {
  workspaceId: string;
  /** The chat whose rename triggered this project refresh. */
  agentId: string;
  /** The title just written to that chat, used instead of its possibly stale directory title. */
  chatTitle: string;
  evidence: readonly ProjectEvidence[];
  /** The project's current name; the model keeps it when it still fits. */
  currentTitle?: string | null;
  model: ResolvedModel;
  signal?: AbortSignal;
  scratchRoot?: string;
}

export interface ProjectTitleResult {
  title?: string;
  /** Where the answer came from: the chat itself, a fresh model run, or the previous summary. */
  from: "chat" | "summary" | "cache";
  error?: string;
}

/** How many project summaries are kept in memory. They are cheap to rebuild and never persisted. */
export const MAX_CACHED_PROJECTS = 200;

const signatureOf = (request: ProjectTitleRequest, evidence: readonly ProjectEvidence[]) =>
  JSON.stringify({
    model: `${request.model.provider}/${request.model.model}`,
    chats: [...evidence]
      .map((chat) => [chat.id, chat.title ?? "", chat.firstPrompt ?? ""] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  });

/**
 * Chooses one project title from the live chats:
 * - one chat reuses the title just written to it, so a single-chat project costs no extra model run;
 * - two or more run one summary over every chat's evidence, cached by the sorted chat titles so an
 *   unchanged project is not re-summarised on every turn;
 * - a reply that is not a usable title yields no title, and the caller leaves the project alone.
 */
export function createProjectTitles() {
  const cache = new Map<string, { signature: string; title: string }>();

  return {
    async resolve(runModel: ProjectModelRunner, request: ProjectTitleRequest): Promise<ProjectTitleResult> {
      const chatTitle = request.chatTitle.trim();
      if (chatTitle === "") return { from: "chat", error: "The chat has no title to reuse for the project." };

      // The directory can still show the old title while a rename is landing, so the fresh one always wins.
      const evidence = request.evidence.map((chat) =>
        chat.id === request.agentId ? { id: chat.id, title: chatTitle } : { ...chat },
      );
      if (evidence.length <= 1) return { title: chatTitle, from: "chat" };

      const signature = signatureOf(request, evidence);
      const cached = cache.get(request.workspaceId);
      if (cached?.signature === signature) return { title: cached.title, from: "cache" };

      let reply: string;
      try {
        reply = await runModel(request.model, buildProjectPrompt({ chats: evidence, currentTitle: request.currentTitle }), {
          signal: request.signal,
          scratchRoot: request.scratchRoot,
          accept: isUsableTitle,
        });
      } catch (error) {
        return { from: "summary", error: error instanceof Error ? error.message : String(error) };
      }
      const title = sanitizeTitle(reply);
      if (!title) {
        return { from: "summary", error: "The model's reply could not be used as a project name, so the project name was left as it was." };
      }
      cache.delete(request.workspaceId);
      cache.set(request.workspaceId, { signature, title });
      while (cache.size > MAX_CACHED_PROJECTS) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
      return { title, from: "summary" };
    },
    clear() {
      cache.clear();
    },
  };
}

export type ProjectTitles = ReturnType<typeof createProjectTitles>;
