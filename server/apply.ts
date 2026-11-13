import type { TargetOutcome } from "../shared/types";
import type { Paseo } from "./llm";

/** The part of the daemon connection that applying a chat title uses. */
export interface ApplyChatPaseo {
  agents: {
    ref(agentId: string): { refresh(): Promise<{ agent: { title?: string | null } } | null> };
  };
}

/** The real SDK connection as the chat write's narrow view, checked by the compiler. */
export const asApplyChat = (paseo: Paseo): ApplyChatPaseo => paseo;

/** Sets a chat's own title. In production this is the Paseo command; tests pass a fake. */
export type SetChatTitle = (agentId: string, title: string) => Promise<void>;

export interface ApplyChatInput {
  agentId: string;
  title: string;
  /** The chat's title now, so an identical one is not written again. */
  currentChatTitle: string | null;
  /** Whether the chat target is on in the settings. */
  enabled: boolean;
  /** Internal lifetime guard: never start a title write after plugin teardown began. */
  signal?: AbortSignal;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const skipped = (detail: string): TargetOutcome => ({ status: "skipped", detail });

/**
 * Writes a chat's own title and checks the daemon kept it. It never throws: a failed command or a
 * daemon that does not show the new title becomes a failed outcome the caller can report.
 */
export async function applyChatTitle(
  deps: { paseo: ApplyChatPaseo; setChatTitle: SetChatTitle },
  input: ApplyChatInput,
): Promise<TargetOutcome> {
  if (input.signal?.aborted) return skipped("The rename was cancelled.");
  if (!input.enabled) return skipped("Turned off in the settings.");
  if (input.currentChatTitle === input.title) return { status: "unchanged" };
  try {
    await deps.setChatTitle(input.agentId, input.title);
    const seen = (await deps.paseo.agents.ref(input.agentId).refresh())?.agent.title;
    if (seen !== input.title) return { status: "failed", detail: "The command finished, but the daemon does not show the new title." };
    return { status: "renamed" };
  } catch (error) {
    return { status: "failed", detail: message(error) };
  }
}
