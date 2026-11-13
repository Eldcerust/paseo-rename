import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settingsFallback, type ChatTitleValues } from "../shared/settings";
import { createAuto, decideAuto, DEBOUNCE_MS, MIN_GAP_MS, type TurnEvent } from "./auto";
import { HELPER_TITLE } from "./llm";
import type { RetitleDaemon } from "./retitle";
import type { AgentMemory, StateStore } from "./state";

const daemon = {} as RetitleDaemon;
const event = (id = "chat"): TurnEvent => ({ agent: { id, workspaceId: "w", parentAgentId: null, cwd: "C:/project", title: "Chat" }, outcome: { kind: "completed" } });
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Chats are off until switched on, so the queue tests name the chats they use. */
function world(on: string[] = ["chat", "one", "two", "other"]) {
  let settings: ChatTitleValues = structuredClone(settingsFallback);
  const memories = new Map<string, AgentMemory>();
  const chats = new Set(on);
  const state: StateStore = {
    get: async (id) => ({ ...(memories.get(id) ?? { turns: 0 }) }),
    update: async (id, change) => { const next = change(await state.get(id)); memories.set(id, next); return next; },
    recent: async () => [], pushResult: async () => {},
    chatAuto: async (id) => chats.has(id),
    setChatAuto: async (id, enabled) => { if (enabled) chats.add(id); else chats.delete(id); return enabled; },
  };
  const retitle = vi.fn(async (_paseo: RetitleDaemon, request: { agentId: string; source: "auto"; signal?: AbortSignal }) => ({ agentId: request.agentId, status: "unchanged" as const, at: new Date().toISOString() }));
  const busy = vi.fn((): string[] => []);
  const auto = createAuto({ settings: async () => settings, state, retitler: { retitle, busy } });
  return { auto, state, retitle, busy, settings, chats, setSettings: (next: ChatTitleValues) => { settings = next; } };
}

describe("automatic decisions", () => {
  const decide = (memory: AgentMemory, settings = settingsFallback, e = event(), chatEnabled = true) => decideAuto({ settings, event: e, memory, now: Date.now(), chatEnabled });
  it("looks after the first completed turn", () => expect(decide({ turns: 1 })).toEqual({ run: true, why: "first" }));
  it("waits for the configured number of turns after a previous attempt", () => {
    const attemptedAt = new Date(Date.now() - MIN_GAP_MS).toISOString();
    expect(decide({ turns: 3, attemptedAt })).toEqual({ run: false, why: "not-yet" });
    expect(decide({ turns: 4, attemptedAt })).toEqual({ run: true, why: "due" });
  });
  it("enforces a minute even when everyTurns is one", () => expect(decide({ turns: 50, attemptedAt: new Date().toISOString() })).toEqual({ run: false, why: "too-soon" }));
  it.each(["failed", "canceled"] as const)("ignores %s turns", (kind) => expect(decide({ turns: 1 }, settingsFallback, { ...event(), outcome: { kind } })).toEqual({ run: false, why: "not-completed" }));
  it("never runs for a chat that is not switched on, whatever else is true", () => {
    expect(decide({ turns: 50 }, settingsFallback, event(), false)).toEqual({ run: false, why: "chat-off" });
    expect(decide({ turns: 1 }, settingsFallback, { ...event(), outcome: { kind: "failed" } }, false)).toEqual({ run: false, why: "chat-off" });
  });
  it("reports the host master switch before the chat's own", () => {
    const master = { ...structuredClone(settingsFallback), auto: { ...settingsFallback.auto, enabled: false } };
    expect(decide({ turns: 1 }, master, event(), true)).toEqual({ run: false, why: "off" });
    expect(decide({ turns: 1 }, master, event(), false)).toEqual({ run: false, why: "off" });
  });
  it("still ignores helpers for a chat that is switched on", () => {
    expect(decide({ turns: 1 }, settingsFallback, { ...event(), agent: { ...event().agent, title: HELPER_TITLE } }, true)).toEqual({ run: false, why: "helper" });
  });
  it("ignores helpers and subagents", () => {
    expect(decide({ turns: 1 }, settingsFallback, { ...event(), agent: { ...event().agent, title: HELPER_TITLE } })).toEqual({ run: false, why: "helper" });
    expect(decide({ turns: 1 }, settingsFallback, { ...event(), agent: { ...event().agent, parentAgentId: "parent" } })).toEqual({ run: false, why: "subagent" });
  });
});

describe("per-chat switch in the queue", () => {
  it("renames nothing and stores nothing for a chat that was never switched on", async () => {
    const w = world([]); await w.auto.onTurnEnded(event("chat"), daemon); await w.auto.onTurnEnded(event("chat"), daemon); await vi.runAllTimersAsync(); await w.auto.idle();
    expect(w.retitle).not.toHaveBeenCalled(); expect(await w.state.get("chat")).toEqual({ turns: 0 });
  });
  it("renames only the chats that are switched on", async () => {
    const w = world(["one"]); await w.auto.onTurnEnded(event("one"), daemon); await w.auto.onTurnEnded(event("two"), daemon); await vi.runAllTimersAsync(); await w.auto.idle();
    expect(w.retitle.mock.calls.map((call) => call[1].agentId)).toEqual(["one"]); expect(await w.state.get("two")).toEqual({ turns: 0 });
  });
  it("renames after the very next completed turn once a chat is switched on", async () => {
    const w = world([]); await w.auto.onTurnEnded(event("chat"), daemon); await vi.runAllTimersAsync();
    expect(w.retitle).not.toHaveBeenCalled();
    await w.state.setChatAuto("chat", true); await w.auto.onTurnEnded(event("chat"), daemon); await vi.runAllTimersAsync(); await w.auto.idle();
    expect(w.retitle).toHaveBeenCalledTimes(1);
  });
  it("does not rename a switched-on chat while the host master switch is off", async () => {
    const w = world(["chat"]); w.settings.auto.enabled = false;
    await w.auto.onTurnEnded(event("chat"), daemon); await vi.runAllTimersAsync(); await w.auto.idle();
    expect(w.retitle).not.toHaveBeenCalled(); expect(await w.state.get("chat")).toEqual({ turns: 0 });
  });
  it("drops a rename that is waiting when its chat is switched off, and counts nothing after that", async () => {
    const w = world(["chat"]); await w.auto.onTurnEnded(event("chat"), daemon);
    expect((await w.state.get("chat")).turns).toBe(1);
    await w.state.setChatAuto("chat", false); await vi.runAllTimersAsync(); await w.auto.idle();
    expect(w.retitle).not.toHaveBeenCalled();
    await w.auto.onTurnEnded(event("chat"), daemon); expect((await w.state.get("chat")).turns).toBe(1);
  });
  it("does not stop a rename that is already running when the chat is switched off, and does not start another", async () => {
    const w = world(["chat"]); let release!: () => void;
    w.retitle.mockImplementationOnce(async (_, req) => { await new Promise<void>((resolve) => { release = resolve; }); return { agentId: req.agentId, status: "unchanged", at: new Date().toISOString() }; });
    await w.auto.onTurnEnded(event("chat"), daemon); await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await w.state.setChatAuto("chat", false); release(); await w.auto.idle();
    expect(w.retitle).toHaveBeenCalledTimes(1);
    await w.auto.onTurnEnded(event("chat"), daemon); await vi.runAllTimersAsync(); expect(w.retitle).toHaveBeenCalledTimes(1);
  });
  it("ignores helpers, subagents and failed turns of a switched-on chat without storing them", async () => {
    const w = world(["chat"]);
    await w.auto.onTurnEnded({ ...event("chat"), agent: { ...event("chat").agent, title: HELPER_TITLE } }, daemon);
    await w.auto.onTurnEnded({ ...event("chat"), agent: { ...event("chat").agent, parentAgentId: "p" } }, daemon);
    await w.auto.onTurnEnded({ ...event("chat"), outcome: { kind: "failed" } }, daemon); await vi.runAllTimersAsync(); await w.auto.idle();
    expect(w.retitle).not.toHaveBeenCalled(); expect(await w.state.get("chat")).toEqual({ turns: 0 });
  });
});

describe("automatic queue", () => {
  it("debounces a burst and counts its turns", async () => {
    const w = world();
    await w.auto.onTurnEnded(event(), daemon);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1);
    await w.auto.onTurnEnded(event(), daemon);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1);
    expect(w.retitle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await w.auto.idle();
    expect(w.retitle).toHaveBeenCalledTimes(1);
    expect(await w.state.get("chat")).toMatchObject({ turns: 0, attemptedAt: expect.any(String) });
  });
  it("does not even store a turn when disabled", async () => {
    const w = world(); w.settings.auto.enabled = false;
    await w.auto.onTurnEnded(event(), daemon); await vi.runAllTimersAsync();
    expect(await w.state.get("chat")).toEqual({ turns: 0 }); expect(w.retitle).not.toHaveBeenCalled();
  });
  it("rechecks the switch when the debounce ends", async () => {
    const w = world(); await w.auto.onTurnEnded(event(), daemon); w.settings.auto.enabled = false;
    await vi.runAllTimersAsync(); expect(w.retitle).not.toHaveBeenCalled();
  });
  it("runs different chats serially and deduplicates a chat already running", async () => {
    const w = world(); let release!: () => void;
    w.retitle.mockImplementationOnce(async (_, req) => { await new Promise<void>((r) => { release = r; }); return { agentId: req.agentId, status: "unchanged", at: new Date().toISOString() }; });
    await w.auto.onTurnEnded(event("one"), daemon); await w.auto.onTurnEnded(event("two"), daemon);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(w.retitle).toHaveBeenCalledTimes(1);
    await w.auto.onTurnEnded(event("one"), daemon);
    release(); await w.auto.idle();
    expect(w.retitle.mock.calls.map((call) => call[1].agentId)).toEqual(["one", "two"]);
    expect((await w.state.get("one")).turns).toBe(1);
  });
  it("cancels waiting work on teardown and refuses future events", async () => {
    const w = world(); await w.auto.onTurnEnded(event(), daemon); w.auto.stop();
    await w.auto.idle(); await w.auto.onTurnEnded(event("other"), daemon); await vi.runAllTimersAsync();
    expect(w.retitle).not.toHaveBeenCalled(); expect((await w.state.get("other")).turns).toBe(0);
  });
  it("aborts running work and idle waits for it to settle", async () => {
    const w = world(); let aborted = false;
    w.retitle.mockImplementationOnce(async (_, req) => { await new Promise<void>((resolve) => req.signal!.addEventListener("abort", () => { aborted = true; resolve(); })); return { agentId: req.agentId, status: "unchanged", at: new Date().toISOString() }; });
    await w.auto.onTurnEnded(event(), daemon); await vi.advanceTimersByTimeAsync(DEBOUNCE_MS); w.auto.stop(); await w.auto.idle(); expect(aborted).toBe(true);
  });
  it("does not reset counters for a concurrent manual rename", async () => {
    const w = world(); w.busy.mockReturnValue(["chat"]); await w.auto.onTurnEnded(event(), daemon); await vi.runAllTimersAsync();
    expect(w.retitle).not.toHaveBeenCalled(); expect((await w.state.get("chat")).turns).toBe(1);
  });
  it("recovers the queue after a rejected attempt", async () => {
    const w = world(); const log = vi.spyOn(console, "error").mockImplementation(() => {}); w.retitle.mockRejectedValueOnce(new Error("offline"));
    await w.auto.onTurnEnded(event("one"), daemon); await w.auto.onTurnEnded(event("two"), daemon); await vi.runAllTimersAsync(); await w.auto.idle();
    expect(w.retitle).toHaveBeenCalledTimes(2); expect(log).toHaveBeenCalled(); log.mockRestore();
  });
});
