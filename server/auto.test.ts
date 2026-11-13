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

function world() {
  let settings: ChatTitleValues = structuredClone(settingsFallback);
  const memories = new Map<string, AgentMemory>();
  const state: StateStore = {
    get: async (id) => ({ ...(memories.get(id) ?? { turns: 0 }) }),
    update: async (id, change) => { const next = change(await state.get(id)); memories.set(id, next); return next; },
    recent: async () => [], pushResult: async () => {},
  };
  const retitle = vi.fn(async (_paseo: RetitleDaemon, request: { agentId: string; source: "auto"; signal?: AbortSignal }) => ({ agentId: request.agentId, status: "unchanged" as const, at: new Date().toISOString() }));
  const busy = vi.fn((): string[] => []);
  const auto = createAuto({ settings: async () => settings, state, retitler: { retitle, busy } });
  return { auto, state, retitle, busy, settings, setSettings: (next: ChatTitleValues) => { settings = next; } };
}

describe("automatic decisions", () => {
  const decide = (memory: AgentMemory, settings = settingsFallback, e = event()) => decideAuto({ settings, event: e, memory, now: Date.now() });
  it("looks after the first completed turn", () => expect(decide({ turns: 1 })).toEqual({ run: true, why: "first" }));
  it("waits for the configured number of turns after a previous attempt", () => {
    const attemptedAt = new Date(Date.now() - MIN_GAP_MS).toISOString();
    expect(decide({ turns: 3, attemptedAt })).toEqual({ run: false, why: "not-yet" });
    expect(decide({ turns: 4, attemptedAt })).toEqual({ run: true, why: "due" });
  });
  it("enforces a minute even when everyTurns is one", () => expect(decide({ turns: 50, attemptedAt: new Date().toISOString() })).toEqual({ run: false, why: "too-soon" }));
  it.each(["failed", "canceled"] as const)("ignores %s turns", (kind) => expect(decide({ turns: 1 }, settingsFallback, { ...event(), outcome: { kind } })).toEqual({ run: false, why: "not-completed" }));
  it("ignores helpers and subagents", () => {
    expect(decide({ turns: 1 }, settingsFallback, { ...event(), agent: { ...event().agent, title: HELPER_TITLE } })).toEqual({ run: false, why: "helper" });
    expect(decide({ turns: 1 }, settingsFallback, { ...event(), agent: { ...event().agent, parentAgentId: "parent" } })).toEqual({ run: false, why: "subagent" });
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
