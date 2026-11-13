import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { agentProviderOf, type CatalogSource, type ResolvedModel } from "./catalog";

export type Paseo = PluginHandlerContext["paseo"];

/** The title every helper agent carries, and the name of its scratch folder: how its own turns are recognised. */
export const HELPER_TITLE = "[Chat titles] naming a chat";
export const HELPER_LABEL = { "chat-title": "helper" } as const;
export const SCRATCH_NAME = "chat-title-scratch";

/** The one empty folder every helper runs in. */
export const scratchFolder = (root: string = tmpdir()) => join(root, SCRATCH_NAME);

/** True for an agent this plugin made to write a title, so its own turn ends are never retitled. */
export function isHelperAgent(agent: { cwd?: string | null; title?: string | null }, root: string = tmpdir()): boolean {
  if (agent.title?.startsWith("[Chat titles]")) return true;
  if (!agent.cwd) return false;
  return resolve(agent.cwd).toLowerCase() === resolve(scratchFolder(root)).toLowerCase();
}

/** What the runner reads from a helper agent. The SDK's agent handle is assignable to it. */
export interface HelperAgent {
  readonly id: string;
  readonly workspaceId: string | null;
  readonly pendingPermissions: readonly { id: string }[] | null;
  refresh(): Promise<unknown>;
  waitForFinish(timeoutMs?: number): Promise<{ status: string; error?: string | null; lastMessage?: string | null }>;
  respondToPermission(options: { requestId: string; response: { behavior: "deny"; message: string; interrupt: boolean } }): Promise<void>;
  archive(): Promise<unknown>;
  timeline: { refetch(options: { direction: "tail"; limit: number }): Promise<{ entries: readonly { item: { type: string; text?: string } }[] }> };
}

export interface HelperCreate {
  config: { provider: string; modeId?: string; thinkingOptionId?: string };
  cwd: string;
  title: string;
  prompt: string;
  background: boolean;
  labels: Record<string, string>;
}

/** What the runner needs of the daemon. The SDK's `paseo` is assignable to it (see `asRunner`). */
export interface RunnerPaseo extends CatalogSource {
  agents: { create(options: HelperCreate): Promise<HelperAgent> };
  workspaces: { archive(workspaceId: string): Promise<unknown> };
}

/** The real SDK connection as the runner's narrow view, checked by the compiler. */
export const asRunner = (paseo: Paseo): RunnerPaseo => paseo;

export interface RunOptions {
  /** How long to wait for the model's answer. A title is a few words, so this is short. */
  answerWithinMs?: number;
  signal?: AbortSignal;
  /** Where the scratch folder lives. Defaults to the system temp folder. */
  scratchRoot?: string;
  /**
   * Whether a reply is usable. The helper's own messages are tried in the order it sent them and the first that passes
   * wins; when none does the first one is returned, so the caller can say why it was not usable.
   */
  accept?: (reply: string) => boolean;
}

export const ANSWER_WITHIN_MS = 90_000;
const WAIT_SLICE_MS = 10_000;
const MAX_DENIALS = 12;

/** Interrupt waiting for a provider call without leaving its late rejection unobserved. */
function untilCancelled<T>(start: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const cancelled = () => new Error("The rename was cancelled.");
  if (signal?.aborted) return Promise.reject(cancelled());
  if (!signal) return start();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      complete();
    };
    const abort = () => finish(() => reject(cancelled()));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    try {
      // Both handlers stay attached after abort: a late provider result cannot resume the
      // caller, and a late provider rejection cannot become an unhandled rejection.
      start().then(
        (value) => finish(() => signal.aborted ? reject(cancelled()) : resolve(value)),
        (error) => finish(() => reject(error)),
      );
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

/** Everything the helper said, oldest first. Reasoning, tool and notification rows are not replies. */
async function assistantReplies(agent: HelperAgent): Promise<string[]> {
  const page = await agent.timeline.refetch({ direction: "tail", limit: 50 });
  return page.entries.flatMap(({ item }) => (item.type === "assistant_message" && item.text?.trim() ? [item.text] : []));
}

/**
 * The reply to the prompt out of everything the helper said. It is the FIRST usable message, not the last: a helper
 * can speak again after answering. Observed: OpenCode in plan mode added a plan-mode reminder after the title and
 * answered it ("I'm in Plan mode and there's no new request to work on..."), and that second message was the helper's
 * last. When no message is usable the first is returned so the caller can say why.
 */
export function pickReply(replies: readonly string[], accept: (reply: string) => boolean = () => true): string | undefined {
  return replies.find(accept) ?? replies[0];
}

/** Whatever the helper asks permission for is refused: it is meant to answer in text alone. */
async function denyPermissions(agent: HelperAgent, signal?: AbortSignal): Promise<number> {
  await untilCancelled(() => agent.refresh(), signal);
  const requests = agent.pendingPermissions ?? [];
  for (const request of requests) {
    await untilCancelled(() => agent.respondToPermission({ requestId: request.id, response: { behavior: "deny", message: "Answer in text only. Do not use tools.", interrupt: false } }), signal);
  }
  return requests.length;
}

async function replyOf(agent: HelperAgent, answerWithinMs: number, signal?: AbortSignal, accept?: (reply: string) => boolean): Promise<string> {
  const end = Date.now() + answerWithinMs;
  let denials = 0;
  for (;;) {
    if (signal?.aborted) throw new Error("The rename was cancelled.");
    const remaining = end - Date.now();
    if (remaining <= 0) throw new Error("The model did not answer in time.");
    const result = await untilCancelled(() => agent.waitForFinish(Math.min(WAIT_SLICE_MS, remaining)), signal);
    if (result.status === "error") throw new Error(result.error || "The model's agent failed.");
    if (result.status === "permission") {
      denials += await denyPermissions(agent, signal);
      if (denials > MAX_DENIALS) throw new Error("The model kept asking to use tools.");
      continue;
    }
    if (result.status === "idle") {
      // The daemon's last message is not necessarily the reply to the prompt (see pickReply), so the helper's own messages are read.
      // A timeline that cannot be read falls back to what the daemon reported, and is an error only when it reported nothing.
      let replies: string[] = [];
      try {
        replies = await untilCancelled(() => assistantReplies(agent), signal);
      } catch (error) {
        if (signal?.aborted || !result.lastMessage?.trim()) throw error;
      }
      if (signal?.aborted) throw new Error("The rename was cancelled.");
      const text = pickReply(replies, accept)?.trim() || result.lastMessage?.trim();
      if (!text) throw new Error("The model sent no reply.");
      // Some CLIs finish successfully with a quota/auth notice as assistant text (observed on
      // Claude). These are provider failures, not generated titles. Anchor to notice wording so
      // a real title such as "Fix rate limit handling" is still usable.
      if (/^(?:(?:you(?:['’]ve| have) (?:hit|reached) your .{0,60}limit)|(?:you(?:['’]re| are) out of (?:extra )?usage)|(?:credit balance is too low)|(?:insufficient (?:credits|quota))|(?:(?:api |authentication )?error\s*:\s*(?:401|403|429|unauthorized|invalid api key)))/i.test(text)) {
        throw new Error(`The model provider reported: ${text.slice(0, 500)}`);
      }
      return text;
    }
    // Any other status is only this wait's slice running out: keep waiting until the overall limit.
  }
}

/** Helper runs wait for each other: they share one folder, and so may share the workspace made for it. */
let running: Promise<unknown> = Promise.resolve();

/**
 * Asks a model for text through the Paseo daemon: a helper agent on the chosen provider and model,
 * in plan (read-only) mode where the provider has one, at its lowest thinking level, in an empty
 * scratch folder so there is nothing to edit. It is archived afterwards together with the
 * workspace Paseo made for the folder, whether the model answered or not.
 *
 * The folder is one fixed folder that is reused and never deleted. A new folder per run cannot be
 * removed: the provider's own processes (and any hooks the person has set up) keep it open after
 * the agent is archived, so they would pile up. Because the folder is shared, runs go one at a time.
 */
export function runTitleModel(paseo: RunnerPaseo, model: ResolvedModel, prompt: string, options: RunOptions = {}): Promise<string> {
  const run = running.then(() => runOne(paseo, model, prompt, options));
  running = run.catch(() => undefined);
  return run;
}

async function runOne(paseo: RunnerPaseo, model: ResolvedModel, prompt: string, options: RunOptions): Promise<string> {
  if (options.signal?.aborted) throw new Error("The rename was cancelled.");
  const scratch = scratchFolder(options.scratchRoot);
  mkdirSync(scratch, { recursive: true });
  let agent: HelperAgent | undefined;
  try {
    agent = await paseo.agents.create({
      config: {
        provider: agentProviderOf(model),
        ...(model.mode ? { modeId: model.mode } : {}),
        ...(model.thinking ? { thinkingOptionId: model.thinking } : {}),
      },
      cwd: scratch,
      title: HELPER_TITLE,
      prompt,
      background: true,
      labels: { ...HELPER_LABEL },
    });
    return await replyOf(agent, options.answerWithinMs ?? ANSWER_WITHIN_MS, options.signal, options.accept);
  } finally {
    if (agent) {
      const workspaceId = agent.workspaceId;
      await agent.archive().catch(() => undefined);
      if (workspaceId) await paseo.workspaces.archive(workspaceId).catch(() => undefined);
    }
  }
}
