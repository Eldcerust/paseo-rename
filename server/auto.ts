import type { ChatTitleValues } from "../shared/settings";
import { isHelperAgent } from "./llm";
import type { RetitleDaemon, Retitler } from "./retitle";
import type { AgentMemory, StateStore } from "./state";

/** The part of a finished turn the decision reads. The SDK's `agent.turn.after` payload is assignable to it. */
export interface TurnEvent {
  agent: { id: string; workspaceId: string | null; parentAgentId: string | null; cwd: string; title: string | null };
  outcome: { kind: "completed" | "failed" | "canceled" };
}

export type AutoDecision =
  | { run: true; why: "first" | "due" }
  | { run: false; why: "off" | "not-completed" | "helper" | "subagent" | "too-soon" | "not-yet" };

/** Two automatic attempts at one chat are never closer than this, whatever the interval says. */
export const MIN_GAP_MS = 60_000;
/** A turn end waits this long for the next one, so a burst of quick turns is one rename. */
export const DEBOUNCE_MS = 4_000;

type SkipReason = "off" | "not-completed" | "helper" | "subagent";

/** Why a finished turn is never counted at all, or undefined when it is a candidate. */
export function skipReason(settings: ChatTitleValues, event: TurnEvent): SkipReason | undefined {
  if (!settings.auto.enabled) return "off";
  if (event.outcome.kind !== "completed") return "not-completed";
  if (isHelperAgent(event.agent)) return "helper";
  if (event.agent.parentAgentId) return "subagent";
  return undefined;
}

/**
 * Whether an automatic rename should run for a turn that just ended. `memory` already counts this
 * turn. A chat is looked at after its first completed turn, then every `everyTurns` turns.
 */
export function decideAuto(input: { settings: ChatTitleValues; event: TurnEvent; memory: AgentMemory; now: number }): AutoDecision {
  const { settings, event, memory, now } = input;
  const skip = skipReason(settings, event);
  if (skip) return { run: false, why: skip };
  if (memory.attemptedAt === undefined) return { run: true, why: "first" };
  if (now - Date.parse(memory.attemptedAt) < MIN_GAP_MS) return { run: false, why: "too-soon" };
  return memory.turns >= settings.auto.everyTurns ? { run: true, why: "due" } : { run: false, why: "not-yet" };
}

export interface AutoDeps {
  settings(): Promise<ChatTitleValues>;
  state: StateStore;
  retitler: Pick<Retitler, "retitle" | "busy">;
  now?: () => number;
  debounceMs?: number;
}

export interface Auto {
  onTurnEnded(event: TurnEvent, paseo: RetitleDaemon): Promise<void>;
  /** Resolves when no rename is waiting or running. */
  idle(): Promise<void>;
  /** Cancels what is waiting and stops taking turn ends. */
  stop(): void;
}

/**
 * Renames chats after completed turns. A turn end is counted, debounced per chat, and then queued:
 * chats are renamed one at a time so a burst of finished turns cannot start a burst of model runs.
 * It never throws into the hook, and it ignores its own helper agents, subagents and failed turns.
 */
export function createAuto(deps: AutoDeps): Auto {
  const now = deps.now ?? Date.now;
  const debounceMs = deps.debounceMs ?? DEBOUNCE_MS;
  const lifetime = new AbortController();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const pending = new Set<string>();
  const waiters = new Set<() => void>();
  let queue: Promise<unknown> = Promise.resolve();

  function settled() {
    if (timers.size || pending.size) return;
    for (const resolve of waiters) resolve();
    waiters.clear();
  }

  async function attempt(agentId: string, paseo: RetitleDaemon): Promise<void> {
    if (lifetime.signal.aborted) return;
    const settings = await deps.settings();
    if (lifetime.signal.aborted || !settings.auto.enabled) return;
    if (deps.retitler.busy().includes(agentId)) return;
    const before = await deps.state.get(agentId);
    if (before.attemptedAt !== undefined && (now() - Date.parse(before.attemptedAt) < MIN_GAP_MS || before.turns < settings.auto.everyTurns)) return;
    const result = await deps.retitler.retitle(paseo, { agentId, source: "auto", signal: lifetime.signal });
    if (result.reason === "A rename of this chat is already running.") return;
    // Whatever was decided, the next look is `everyTurns` turns away: a chat with a title a person chose is not re-examined every turn.
    await deps.state.update(agentId, (memory) => ({ ...memory, turns: Math.max(0, memory.turns - before.turns), attemptedAt: new Date(now()).toISOString() }));
  }

  function enqueue(agentId: string, paseo: RetitleDaemon): void {
    if (pending.has(agentId) || lifetime.signal.aborted) return;
    pending.add(agentId);
    queue = queue
      .then(() => attempt(agentId, paseo))
      .catch((error) => console.error(`[chat-title] automatic rename of ${agentId} failed`, error))
      .finally(() => {
        pending.delete(agentId);
        settled();
      });
  }

  return {
    async onTurnEnded(event, paseo) {
      try {
        if (lifetime.signal.aborted) return;
        const settings = await deps.settings();
        if (lifetime.signal.aborted) return;
        // Nothing about a turn is stored while automatic renaming is off or does not apply to it.
        if (skipReason(settings, event)) return;
        const memory = await deps.state.update(event.agent.id, (current) => ({ ...current, turns: current.turns + 1 }));
        const decision = decideAuto({ settings, event, memory, now: now() });
        if (!decision.run || pending.has(event.agent.id) || lifetime.signal.aborted) return;
        clearTimeout(timers.get(event.agent.id));
        timers.set(
          event.agent.id,
          setTimeout(() => {
            timers.delete(event.agent.id);
            enqueue(event.agent.id, paseo);
          }, debounceMs),
        );
      } catch (error) {
        console.error("[chat-title] could not handle a finished turn", error);
      }
    },
    idle() {
      return timers.size === 0 && pending.size === 0 ? Promise.resolve() : new Promise<void>((resolve) => waiters.add(resolve));
    },
    stop() {
      lifetime.abort();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      settled();
    },
  };
}
