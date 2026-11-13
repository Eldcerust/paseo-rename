import { describe, expect, it } from "vitest";
import type { RetitleResult } from "../shared/types";
import type { CommandState } from "./commands";
import { describePillStatus, relativeTime } from "./pill-status";

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);
const result: RetitleResult = { agentId: "a", status: "renamed", title: "Rainwater collection", chat: { status: "renamed" }, workspace: { status: "renamed" }, at: "2026-11-13T12:00:00Z" };
const done = (extra: Partial<CommandState> = {}): CommandState => ({ agentId: "a", pending: false, message: "message", at: NOW, ...extra });

describe("describePillStatus", () => {
  it("shows a ready state with the custom-title caveat before anything ran", () => {
    expect(describePillStatus(undefined, NOW)).toEqual({ tone: "idle", icon: "Sparkles", headline: "Ready to rename", detail: "Writes a short title from the latest messages. Replaces a custom title.", chips: [] });
  });
  it("shows progress without an icon, because a spinner is drawn", () => {
    expect(describePillStatus({ agentId: "a", pending: true, message: "x" }, NOW)).toMatchObject({ tone: "working", icon: null, headline: "Writing a title…", chips: [] });
  });
  it("reports a rename as success with one chip per target and a time", () => {
    const status = describePillStatus(done({ result }), NOW);
    expect(status).toMatchObject({ tone: "success", icon: "CircleCheck", headline: "Renamed", when: "just now" });
    expect(status.chips).toEqual([{ key: "chat", label: "Chat", outcome: "renamed", tone: "success" }, { key: "workspace", label: "Workspace", outcome: "renamed", tone: "success" }]);
  });
  it("omits the chip of a target that was not part of the run", () => {
    expect(describePillStatus(done({ result: { ...result, workspace: undefined } }), NOW).chips.map((chip) => chip.key)).toEqual(["chat"]);
  });
  it("calls a half-done rename partial and names the target that failed", () => {
    const status = describePillStatus(done({ failed: true, result: { ...result, workspace: { status: "failed", detail: "Workspace access denied" } } }), NOW);
    expect(status).toMatchObject({ tone: "danger", icon: "CircleAlert", headline: "Partly renamed", detail: "Workspace: Workspace access denied" });
    expect(status.chips.map((chip) => chip.tone)).toEqual(["success", "danger"]);
  });
  it("calls a run where every target failed a failure, not a partial", () => {
    const status = describePillStatus(done({ failed: true, result: { ...result, chat: { status: "failed", detail: "Denied" }, workspace: { status: "failed" } } }), NOW);
    expect(status.headline).toBe("Couldn't rename");
    expect(status.detail).toBe("Chat: Denied");
  });
  it("keeps an unchanged title neutral and shows the reason, with a fallback when there is none", () => {
    expect(describePillStatus(done({ result: { ...result, status: "unchanged", reason: "The title already fits", chat: { status: "unchanged" }, workspace: { status: "skipped", detail: "shared" } } }), NOW))
      .toMatchObject({ tone: "neutral", headline: "Title still fits", detail: "The title already fits", chips: [{ tone: "neutral" }, { tone: "neutral", detail: "shared" }] });
    expect(describePillStatus(done({ result: { ...result, status: "unchanged" } }), NOW).detail).toMatch(/already describes/);
  });
  it("explains a skipped run through its reason", () => {
    expect(describePillStatus(done({ result: { agentId: "a", status: "skipped", reason: "Too few messages to name", at: "x" } }), NOW))
      .toMatchObject({ tone: "neutral", headline: "Left unchanged", detail: "Too few messages to name", chips: [] });
  });
  it("shows the model's reason for a failed run instead of repeating the whole sentence", () => {
    expect(describePillStatus(done({ failed: true, message: "Could not update the title. Provider quota exhausted", result: { agentId: "a", status: "failed", reason: "Provider quota exhausted", at: "x" } }), NOW))
      .toMatchObject({ tone: "danger", headline: "Couldn't rename", detail: "Provider quota exhausted" });
  });
  it("falls back to the error message when the run never produced a result", () => {
    expect(describePillStatus(done({ failed: true, message: "Host disconnected" }), NOW)).toMatchObject({ tone: "danger", detail: "Host disconnected", chips: [] });
  });
  it("treats a result flagged failed by status alone as a failure", () => {
    expect(describePillStatus(done({ result: { agentId: "a", status: "failed", at: "x" }, message: "m" }), NOW)).toMatchObject({ tone: "danger", detail: "m" });
  });
  it("never leaves a headline empty and only uses icon names that look like Lucide names", () => {
    const states: (CommandState | undefined)[] = [undefined, { agentId: "a", pending: true, message: "" }, done({ result }), done({ failed: true, message: "m" }), done({ result: { ...result, status: "skipped" } }), done({ result: { ...result, status: "unchanged" } })];
    for (const state of states) {
      const status = describePillStatus(state, NOW);
      expect(status.headline.trim()).not.toBe("");
      expect(status.icon === null || /^[A-Z][A-Za-z0-9]+$/.test(status.icon)).toBe(true);
    }
  });
  it("leaves the time out when the run has no timestamp", () => {
    expect(describePillStatus({ agentId: "a", pending: false, message: "x", result }, NOW).when).toBeUndefined();
  });
});

describe("relativeTime", () => {
  const minute = 60_000;
  it.each([
    [0, "just now"], [59_000, "just now"], [minute, "1 min ago"], [5 * minute, "5 min ago"], [59 * minute, "59 min ago"],
    [60 * minute, "1 h ago"], [23 * 60 * minute, "23 h ago"], [24 * 60 * minute, "1 d ago"], [9 * 24 * 60 * minute, "9 d ago"],
  ])("formats an age of %i ms as %s", (age, text) => { expect(relativeTime(NOW - age, NOW)).toBe(text); });
  it("never prints a negative age when the clock moved backwards", () => { expect(relativeTime(NOW + 10 * minute, NOW)).toBe("just now"); });
});
