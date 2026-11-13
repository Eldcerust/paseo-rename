import type { OutcomeStatus, RetitleResult } from "../shared/types";
import type { CommandState } from "./commands";

/** How the status area of the Auto rename popover looks. Pure data, so every state can be tested without a renderer. */
export type PillTone = "idle" | "working" | "success" | "neutral" | "danger";
export type ChipTone = "success" | "neutral" | "danger";

/** One rename target (the chat's own title, or its workspace row) and what happened to it. */
export interface PillChip { key: "chat" | "workspace"; label: string; outcome: string; tone: ChipTone; detail?: string }

export interface PillStatus {
  tone: PillTone;
  /** A Lucide icon name, or null while a spinner is drawn instead. */
  icon: string | null;
  headline: string;
  detail?: string;
  chips: PillChip[];
  /** "just now", "5 min ago"... for a finished run, so an old result does not read as fresh. */
  when?: string;
}

const CHIP_TONE: Record<OutcomeStatus, ChipTone> = { renamed: "success", unchanged: "neutral", skipped: "neutral", failed: "danger" };
const TARGETS = [["chat", "Chat"], ["workspace", "Workspace"]] as const;

export function relativeTime(then: number, now: number): string {
  // A clock that moved backwards must not print a negative age.
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

function chipsOf(result: RetitleResult): PillChip[] {
  return TARGETS.flatMap(([key, label]) => {
    const target = result[key];
    return target ? [{ key, label, outcome: target.status, tone: CHIP_TONE[target.status], ...(target.detail ? { detail: target.detail } : {}) }] : [];
  });
}

const failing = (chip: PillChip) => `${chip.label}: ${chip.detail ?? "failed"}`;

export function describePillStatus(state: CommandState | undefined, now: number = Date.now()): PillStatus {
  if (!state) {
    return { tone: "idle", icon: "Sparkles", headline: "Ready to rename", detail: "Writes a short title from the latest messages. Replaces a custom title.", chips: [] };
  }
  if (state.pending) {
    return { tone: "working", icon: null, headline: "Writing a title…", detail: "Reading the latest messages.", chips: [] };
  }
  const result = state.result;
  const chips = result ? chipsOf(result) : [];
  const when = state.at === undefined ? undefined : relativeTime(state.at, now);
  const bad = chips.find((chip) => chip.tone === "danger");
  if (state.failed || result?.status === "failed") {
    const partly = result?.status === "renamed" && bad !== undefined && chips.some((chip) => chip.tone === "success");
    if (partly) return { tone: "danger", icon: "CircleAlert", headline: "Partly renamed", detail: failing(bad), chips, when };
    return { tone: "danger", icon: "CircleAlert", headline: "Couldn't rename", detail: result?.reason ?? (bad ? failing(bad) : state.message), chips, when };
  }
  if (result?.status === "renamed") return { tone: "success", icon: "CircleCheck", headline: "Renamed", chips, when };
  if (result?.status === "unchanged") {
    return { tone: "neutral", icon: "Info", headline: "Title still fits", detail: result.reason ?? "The current title already describes the chat.", chips, when };
  }
  if (result?.status === "skipped") return { tone: "neutral", icon: "Info", headline: "Left unchanged", detail: result.reason, chips, when };
  return { tone: "neutral", icon: "Info", headline: state.message, chips, when };
}
