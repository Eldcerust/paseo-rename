import type { ChatTitleValues } from "../shared/settings";
import { isAutoTitle, isUsableTitle, sanitizeTitle } from "../shared/title";
import type { RetitleResult, RetitleSource, TargetOutcome, WindowMessage } from "../shared/types";
import { applyChatTitle, type SetChatTitle } from "./apply";
import { agentProviderOf, createCatalog, type Catalog, type CatalogSource } from "./catalog";
import { currentEnvironment, renameAgentWithCli, runInvocation } from "./cli";
import { isHelperAgent, runTitleModel, type Paseo, type RunnerPaseo } from "./llm";
import { readFirstPrompt, readWindow, type TimelinePage, type TimelineRequest } from "./messages";
import { applyProjectTitle, type ProjectSource } from "./project-apply";
import { createProjectTitles } from "./project-title";
import { buildTitlePrompt } from "./prompt";
import type { StateStore } from "./state";

export interface AgentSnapshot {
  id: string;
  title?: string | null;
  workspaceId?: string | null;
  archivedAt?: string | null;
  cwd?: string | null;
  labels?: Record<string, string> | null;
}

interface AgentRef {
  refresh(): Promise<{ agent: AgentSnapshot } | null>;
  timeline: { refetch(request: TimelineRequest): Promise<TimelinePage> };
}

/** Everything the retitle step needs of the daemon. The SDK's `paseo` is assignable to it (see `asRetitleDaemon`). */
export interface RetitleDaemon {
  providers: CatalogSource["providers"];
  agents: { list: ProjectSource["agents"]["list"]; create: RunnerPaseo["agents"]["create"]; ref(agentId: string): AgentRef };
  workspaces: ProjectSource["workspaces"] & { archive: RunnerPaseo["workspaces"]["archive"] };
}

export const asRetitleDaemon = (paseo: Paseo): RetitleDaemon => paseo;

export interface RetitlerDeps {
  settings(): Promise<ChatTitleValues>;
  state: StateStore;
  /** Sets a chat's own title. Defaults to the Paseo command. */
  setChatTitle?: SetChatTitle;
  /** Asks the model. Defaults to a read-only helper agent. */
  runModel?: typeof runTitleModel;
  now?: () => Date;
  /** Where the helper's scratch folder lives; tests point it at a temp folder. */
  scratchRoot?: string;
  catalogTtlMs?: number;
}

export interface RetitleRequest {
  agentId: string;
  /** `manual` is a person asking and is always answered; `auto` is the turn hook and follows the safety rules. */
  source: RetitleSource;
  /** A person asking to replace a title they chose themselves. */
  force?: boolean;
  signal?: AbortSignal;
}

export interface Retitler {
  retitle(paseo: RetitleDaemon, request: RetitleRequest): Promise<RetitleResult>;
  /** Chats being retitled right now. */
  busy(): string[];
  overview(paseo: RetitleDaemon): Promise<{ recent: RetitleResult[]; busy: string[]; defaultModel?: string }>;
  /** Writes a title for a fixed sample chat with the chosen model, to try a choice without touching a chat. */
  test(paseo: RetitleDaemon, options?: { signal?: AbortSignal }): Promise<{ title: string; model: string; ms: number }>;
  catalog(paseo: RetitleDaemon): Catalog;
}

export const SAMPLE_CHAT: WindowMessage[] = [
  { role: "user", text: "The archive button only archives the chat, but its workspace row stays in the sidebar. Can you make it archive the whole session?" },
  { role: "assistant", text: "I changed the exporter so archiving a chat also archives the chat's own workspace, unless another chat still lives in it." },
  { role: "user", text: "Nice. Now add a plugin that renames chats from their last messages, with a provider I can choose." },
];

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const described = (outcome: TargetOutcome) => outcome.detail;

export function createRetitler(deps: RetitlerDeps): Retitler {
  const now = deps.now ?? (() => new Date());
  const runModel = deps.runModel ?? runTitleModel;
  const setChatTitle: SetChatTitle = deps.setChatTitle ?? ((agentId, title) => renameAgentWithCli(currentEnvironment(), runInvocation, agentId, title));
  const inFlight = new Set<string>();
  const projectTitles = createProjectTitles();
  const catalogs = new WeakMap<object, Catalog>();
  const catalogFor = (paseo: RetitleDaemon) => {
    let catalog = catalogs.get(paseo);
    if (!catalog) {
      catalog = createCatalog(paseo, { ttlMs: deps.catalogTtlMs });
      catalogs.set(paseo, catalog);
    }
    return catalog;
  };

  async function run(paseo: RetitleDaemon, request: RetitleRequest): Promise<Omit<RetitleResult, "agentId" | "at">> {
    const { agentId } = request;
    const cancelled = () => request.signal?.aborted;
    if (cancelled()) return { status: "skipped", reason: "The rename was cancelled." };
    const settings = await deps.settings();
    if (!settings.targets.chat && !settings.targets.workspace) return { status: "skipped", reason: "Both rename targets are turned off in the settings." };
    const snapshot = (await paseo.agents.ref(agentId).refresh())?.agent;
    if (!snapshot) return { status: "failed", reason: "The chat was not found." };
    const previous = snapshot.title ?? null;
    if (snapshot.archivedAt) return { status: "skipped", previous, reason: "The chat is archived." };
    if (isHelperAgent(snapshot) || snapshot.labels?.["chat-title"] === "helper") return { status: "skipped", previous, reason: "This is a helper chat made by this plugin." };

    const memory = await deps.state.get(agentId);
    const automatic = request.source === "auto" && !request.force;
    if (automatic) {
      // Only a title that looks machine-made is replaced by itself. The first prompt is read only when the title needs comparing with it.
      const needsComparing = (snapshot.title ?? "").trim() !== "" && snapshot.title !== memory.title;
      const firstPrompt = needsComparing ? await readFirstPrompt(paseo, agentId) : undefined;
      if (!isAutoTitle({ title: snapshot.title, firstPrompt, lastWritten: memory.title })) {
        return { status: "skipped", previous, reason: "Its title was set by you or another plugin, so automatic renaming leaves it alone." };
      }
    }

    const window = await readWindow(paseo, agentId, settings.window);
    if (window.messages.length === 0) return { status: "skipped", previous, reason: "The chat has no messages yet." };
    const model = await catalogFor(paseo).resolve(settings.model);
    const modelName = agentProviderOf(model);
    const shown = { model: modelName, messages: window.messages.length };

    const prompt = buildTitlePrompt({ messages: window.messages, currentTitle: snapshot.title });
    if (cancelled()) return { status: "skipped", previous, ...shown, reason: "The rename was cancelled." };
    const reply = await runModel(paseo, model, prompt, { signal: request.signal, scratchRoot: deps.scratchRoot, accept: isUsableTitle });
    const title = sanitizeTitle(reply);
    if (!title) return { status: "failed", previous, ...shown, reason: "The model's reply could not be used as a title, so the title was left as it was." };
    if (request.signal?.aborted) return { status: "skipped", previous, ...shown, reason: "The rename was cancelled." };
    // Model runs take time. Never overwrite a person's intervening rename or an archived chat.
    const latest = (await paseo.agents.ref(agentId).refresh())?.agent;
    if (!latest || latest.archivedAt) return { status: "skipped", previous, ...shown, reason: "The chat was removed or archived while the model was running." };
    if (automatic && latest.title !== snapshot.title) return { status: "skipped", previous, ...shown, reason: "The chat title changed while the model was running, so it was left alone." };

    if (cancelled()) return { status: "skipped", previous, ...shown, reason: "The rename was cancelled." };
    // The chat and the project are independent: the chat is written first, then the workspace is
    // named from every live chat in it. A failure in either never undoes the other.
    const chat = await applyChatTitle(
      { paseo, setChatTitle },
      { agentId, title, currentChatTitle: previous, enabled: settings.targets.chat, signal: request.signal },
    );
    const project = await applyProjectTitle(
      paseo,
      {
        settings,
        state: deps.state,
        titles: projectTitles,
        runModel: (model, prompt, options) => runModel(paseo, model, prompt, options),
        model,
        now,
        scratchRoot: deps.scratchRoot,
      },
      { agentId, chatTitle: title, workspaceId: snapshot.workspaceId ?? null, source: request.source, signal: request.signal },
    );
    const workspace: TargetOutcome = project.workspace;

    const outcomes = [chat, workspace];
    const failure = outcomes.find((outcome) => outcome.status === "failed");
    const status = outcomes.some((outcome) => outcome.status === "renamed") ? "renamed" : failure ? "failed" : outcomes.some((outcome) => outcome.status === "unchanged") ? "unchanged" : "skipped";
    const reason = status === "failed" ? described(failure!) : status === "skipped" ? outcomes.map(described).filter(Boolean).join(" ") : undefined;

    if (status === "renamed" || status === "unchanged") {
      const at = now().toISOString();
      await deps.state.update(agentId, (current) => ({
        ...current,
        ...(chat.status === "renamed" || chat.status === "unchanged" ? { title } : {}),
        ...(workspace.status === "renamed" || workspace.status === "unchanged" ? { workspaceTitle: project.title ?? title } : {}),
        turns: request.source === "auto" ? current.turns : 0,
        renamedAt: at,
      }));
    }
    return { status, title, previous, ...shown, chat, workspace, ...(reason ? { reason } : {}) };
  }

  return {
    async retitle(paseo, request) {
      const at = () => now().toISOString();
      if (inFlight.has(request.agentId)) return { agentId: request.agentId, status: "skipped", reason: "A rename of this chat is already running.", at: at() };
      inFlight.add(request.agentId);
      let outcome: Omit<RetitleResult, "agentId" | "at">;
      try {
        outcome = await run(paseo, request);
      } catch (error) {
        outcome = request.signal?.aborted ? { status: "skipped", reason: "The rename was cancelled." } : { status: "failed", reason: message(error) };
      } finally {
        inFlight.delete(request.agentId);
      }
      const result: RetitleResult = { agentId: request.agentId, ...outcome, at: at() };
      // A skip the person did not ask about would only crowd the list the settings screen shows.
      if (result.status !== "skipped" || request.source === "manual") await deps.state.pushResult(result).catch((error) => console.error("[chat-title] could not save the result", error));
      return result;
    },
    busy: () => [...inFlight],
    async overview(paseo) {
      return { recent: await deps.state.recent(), busy: [...inFlight], defaultModel: await catalogFor(paseo).defaultModel().catch(() => undefined) };
    },
    async test(paseo, { signal } = {}) {
      const checkCancelled = () => { if (signal?.aborted) throw new Error("The rename was cancelled."); };
      checkCancelled();
      const settings = await deps.settings();
      const model = await catalogFor(paseo).resolve(settings.model);
      checkCancelled();
      const started = Date.now();
      const reply = await runModel(paseo, model, buildTitlePrompt({ messages: SAMPLE_CHAT }), { scratchRoot: deps.scratchRoot, signal, accept: isUsableTitle });
      checkCancelled();
      const title = sanitizeTitle(reply);
      if (!title) throw new Error(`The model's reply could not be used as a title: ${JSON.stringify(reply.slice(0, 120))}`);
      return { title, model: agentProviderOf(model), ms: Date.now() - started };
    },
    catalog: catalogFor,
  };
}
