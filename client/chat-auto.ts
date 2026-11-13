import type { ChatAuto } from "../shared/rpc";

export type { ChatAuto };

/** What the popover knows about one chat's automatic renaming switch. Pure data, so every state can be tested without a renderer. */
export interface AutoRowInput {
  /** The last answer from the host, kept while a newer one loads. */
  data?: ChatAuto;
  loading: boolean;
  loadError?: string;
  /** A write is in flight, and the value it is writing. */
  saving?: boolean;
  savingValue?: boolean;
  saveError?: string;
}

export interface AutoRow {
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  busy: boolean;
  /** Something went wrong and the person should know; shown under the row. */
  problem?: string;
}

const LABEL = "Rename automatically";

/** The query key of one chat's switch. It names the host and the chat, so two chats or hosts never share an answer. */
export const autoQueryKey = (hostId: string | undefined, agentId: string) => ["chat-title", "chat-auto", hostId ?? "", agentId] as const;

function interval(everyTurns: number): string {
  return everyTurns === 1 ? "On · after each completed turn" : `On · every ${everyTurns} completed turns`;
}

export function describeAutoRow(input: AutoRowInput): AutoRow {
  const { data, loadError, saving, savingValue, saveError } = input;
  if (!data) {
    if (loadError) return { label: LABEL, hint: "Couldn't read this chat's setting", checked: false, disabled: true, busy: false, problem: loadError };
    return { label: LABEL, hint: "Checking…", checked: false, disabled: true, busy: true };
  }
  // While a write is in flight the row shows the value being written and refuses a second press.
  if (saving) return { label: LABEL, hint: "Saving…", checked: savingValue ?? data.enabled, disabled: true, busy: true };
  // The host's master switch is off: the chat's own choice is kept and shown, but it cannot take effect.
  if (!data.allowed) return { label: LABEL, hint: "Turned off for all chats in settings", checked: data.enabled, disabled: true, busy: false, problem: saveError };
  return { label: LABEL, hint: data.enabled ? interval(data.everyTurns) : "Off for this chat", checked: data.enabled, disabled: false, busy: false, problem: saveError };
}
