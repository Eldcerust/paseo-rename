import React, { isValidElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginButtonContentProps, PluginClientContext } from "@getpaseo/plugin/client";
import contribute from "../index.client";
import { contributePills } from "./pills";
import { createRenameActions } from "./commands";

vi.mock("react-native", () => ({ Pressable: "Pressable", Text: "Text", View: "View" }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot() }));
vi.mock("@tanstack/react-query", () => ({ useMutation: ({ mutationFn }: { mutationFn: () => unknown }) => ({ mutate: mutationFn, isPending: false, isError: false }) }));
vi.mock("./settings-screen", () => ({ TitleSettingsScreen: () => null, TitleScreen: () => null }));

const KEY = "__paseoPillHub";
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function resetBus() { for (const carrier of [React, globalThis]) delete (carrier as any)[KEY]; }
function bus(): any { return (globalThis as any)[KEY] ?? (React as any)[KEY]; }
function broadcast() { for (const listener of [...bus().listeners] as (() => void)[]) listener(); }
beforeEach(resetBus);
afterEach(() => { resetBus(); vi.useRealTimers(); vi.restoreAllMocks(); });
const agent = (id: string, extra: object = {}) => ({ id, workspaceId: "w", title: "A real chat", labels: {}, ...extra });
function harness(deferred = false) {
  const own: any[] = []; const settings: any[] = [];
  let observer: any; let signal!: AbortSignal; let resolve!: (result: any) => void;
  const unsubscribe = vi.fn();
  const subscription = { subscribe: vi.fn((value) => { observer = value; return unsubscribe; }) };
  const rpc = vi.fn(async (contract, input) => contract.name === "chat-title.retitle" ? { jobId: "mine", kind: "retitle", agentId: input.agentId } : { found: true, job: { jobId: "mine", kind: "retitle", agentId: "a", state: "succeeded", result: { agentId: "a", status: "renamed", title: "Actual title", at: "2026-11-13T00:00:00Z" } } });
  const client = {
    paseo: { agents: { list: vi.fn((input) => { signal = input.signal; return deferred ? new Promise((done) => { resolve = done; }) : Promise.resolve({ subscription }); }) } },
    rpc, openSettings: vi.fn(), openScreen: vi.fn(),
    addComposerPill: vi.fn((spec) => { const registration = { update: vi.fn(), remove: vi.fn() }; own.push({ ...spec, registration }); return registration; }),
    addSettingsScreen: vi.fn((spec) => { settings.push(spec); return vi.fn(); }),
    addScreen: vi.fn(() => vi.fn()), addSlashCommand: vi.fn(() => vi.fn()), addCommandCenterItem: vi.fn(() => vi.fn()),
  } as unknown as PluginClientContext;
  const actions = createRenameActions(client);
  return {
    client, actions, own, settings, rpc, subscription, unsubscribe,
    snapshot: (agents: any[], pageInfo = { hasMore: false, nextCursor: null as string | null }) => observer.snapshot({ entries: agents.map((a) => ({ agent: a })), pageInfo }),
    upsert: (a: any) => observer.update({ type: "agent_update", payload: { kind: "upsert", agent: a } }),
    remove: (id: string) => observer.update({ type: "agent_update", payload: { kind: "remove", agentId: id } }),
    late: () => resolve({ subscription }), signal: () => signal,
  };
}
function hub() {
  const entries: any[] = []; let merged = true;
  const api = { merges: vi.fn(() => merged), attach: vi.fn((entry) => { const attachment = { update: vi.fn(), remove: vi.fn() }; entries.push({ ...entry, attachment }); return attachment; }) };
  return { api, entries, merge: (value: boolean) => { merged = value; broadcast(); } };
}
function findButton(tree: any, label: string): any {
  if (!isValidElement(tree)) return undefined;
  const props = tree.props as any;
  if (props.accessibilityLabel === label) return props;
  for (const child of React.Children.toArray(props.children)) { const match = findButton(child, label); if (match) return match; }
  return undefined;
}
const props = { theme: { colors: { foreground: "#fff", foregroundMuted: "#aaa" } }, layout: { compact: false }, context: "agent", agentId: "wrong-hub-agent", workspaceId: "wrong-hub-workspace", host: { id: "hub-host" }, close: vi.fn() } as unknown as PluginButtonContentProps;

describe("Auto rename settings and composer tool", () => {
  it("keeps a normal clickable settings registration and removes the complete client contribution", async () => {
    const h = harness(); const cleanup = contribute(h.client); await tick();
    expect(h.settings).toMatchObject([{ id: "titles", title: "Chat titles", Component: expect.any(Function) }]);
    h.snapshot([agent("a")]); expect(h.own).toHaveLength(1);
    cleanup(); cleanup(); expect(h.own[0].registration.remove).toHaveBeenCalledTimes(1); expect(h.signal().aborted).toBe(true);
  });
  it("registers a clickable standalone Auto rename popover when the hub is absent", async () => {
    const h = harness(); const stop = contributePills(h.client, h.actions); await tick(); h.snapshot([agent("a")]);
    expect(h.own).toMatchObject([{ id: "auto-rename", agentId: "a", workspaceId: "w", button: { label: "Auto rename", behavior: { kind: "popover", Content: expect.any(Function) } } }]);
    expect(bus().tools.get("auto-rename").title).toBe("Auto rename"); stop(); h.actions.dispose();
  });
  it("announces the dynamic tool and moves to the Tools hub, then back when its merge switch is off", async () => {
    const h = harness(); const stop = contributePills(h.client, h.actions); await tick(); h.snapshot([agent("a")]);
    const tools = hub(); bus().hub = tools.api; broadcast();
    expect(h.own[0].registration.remove).toHaveBeenCalledOnce(); expect(tools.entries[0]).toMatchObject({ toolId: "auto-rename", agentId: "a", glyph: "CaseSensitive" });
    broadcast(); expect(tools.api.attach).toHaveBeenCalledTimes(1);
    tools.merge(false); expect(tools.entries[0].attachment.remove).toHaveBeenCalledOnce(); expect(h.own).toHaveLength(2);
    tools.merge(true); expect(h.own[1].registration.remove).toHaveBeenCalledOnce(); expect(tools.entries).toHaveLength(2);
    bus().hub = undefined; broadcast(); expect(tools.entries[1].attachment.remove).toHaveBeenCalledOnce(); expect(h.own).toHaveLength(3);
    stop(); h.actions.dispose(); expect(bus().listeners.size).toBe(0);
  });
  it("joins an already running hub without making a duplicate standalone pill", async () => {
    const seed = harness(); const seedStop = contributePills(seed.client, seed.actions); await tick(); seed.snapshot([agent("seed")]);
    const tools = hub(); bus().hub = tools.api; broadcast();
    const h = harness(); const stop = contributePills(h.client, h.actions); await tick(); h.snapshot([agent("a")]);
    expect(h.own).toHaveLength(0); expect(tools.entries.at(-1).agentId).toBe("a"); stop(); seedStop(); h.actions.dispose(); seed.actions.dispose();
  });
  it("reattaches to a replaced hub object even if both merge switches are on", async () => {
    const h = harness(); const stop = contributePills(h.client, h.actions); await tick(); h.snapshot([agent("a")]);
    const first = hub(); bus().hub = first.api; broadcast(); const second = hub(); bus().hub = second.api; broadcast();
    expect(first.entries[0].attachment.remove).toHaveBeenCalledOnce(); expect(second.entries).toHaveLength(1); stop(); h.actions.dispose();
  });
  it("reconciles reconnect snapshots and upserts without duplicates or stale chats", async () => {
    const h = harness(); const stop = contributePills(h.client, h.actions); await tick(); h.snapshot([agent("a"), agent("b")]);
    h.snapshot([agent("a")]); h.upsert(agent("a")); expect(h.own).toHaveLength(2); expect(h.own[1].registration.remove).toHaveBeenCalledOnce();
    h.remove("a"); expect(h.own[0].registration.remove).toHaveBeenCalledOnce(); h.snapshot([agent("a")]); expect(h.own).toHaveLength(3); stop(); h.actions.dispose();
  });
  it("moves a chat registration when its workspace changes", async () => {
    const h = harness(); const stop = contributePills(h.client, h.actions); await tick(); h.snapshot([agent("a")]); h.upsert(agent("a", { workspaceId: "new" }));
    expect(h.own[0].registration.remove).toHaveBeenCalledOnce(); expect(h.own[1].workspaceId).toBe("new"); stop(); h.actions.dispose();
  });
  it("loads every directory page, not just the subscribed first page", async () => {
    const h = harness(); const stop = contributePills(h.client, h.actions); await tick();
    vi.mocked(h.client.paseo.agents.list).mockResolvedValueOnce({ entries: [{ agent: agent("older") }], pageInfo: { hasMore: false, nextCursor: null } } as any);
    h.snapshot([agent("a")], { hasMore: true, nextCursor: "older-page" }); await tick();
    expect(h.own.map((pill) => pill.agentId)).toEqual(["a", "older"]);
    expect(h.client.paseo.agents.list).toHaveBeenLastCalledWith({ page: { cursor: "older-page", limit: 200 }, signal: expect.any(AbortSignal) }); stop(); h.actions.dispose();
  });
  it("buffers removals and newer workspace updates during pagination instead of reviving stale page data", async () => {
    const h = harness(); const stop = contributePills(h.client, h.actions); await tick();
    let release!: (value: any) => void; vi.mocked(h.client.paseo.agents.list).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    h.snapshot([agent("a")], { hasMore: true, nextCursor: "older" }); h.remove("deleted"); h.upsert(agent("a", { workspaceId: "new" }));
    release({ entries: [{ agent: agent("deleted") }], pageInfo: { hasMore: false } }); await tick();
    const active = h.own.filter((pill) => !pill.registration.remove.mock.calls.length);
    expect(active).toMatchObject([{ agentId: "a", workspaceId: "new" }]); stop(); h.actions.dispose();
  });
  it("keeps older-page tools during a reconnect load and ignores stale page completion", async () => {
    const h = harness(); const stop = contributePills(h.client, h.actions); await tick(); h.snapshot([agent("a"), agent("older")]);
    let release!: (value: any) => void; vi.mocked(h.client.paseo.agents.list).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    h.snapshot([agent("a")], { hasMore: true, nextCursor: "pending" }); expect(h.own[1].registration.remove).not.toHaveBeenCalled();
    h.snapshot([agent("fresh")]); release({ entries: [{ agent: agent("stale") }], pageInfo: { hasMore: false } }); await tick();
    expect(h.own.map((pill) => pill.agentId)).not.toContain("stale");
    expect(h.own.filter((pill) => !pill.registration.remove.mock.calls.length).map((pill) => pill.agentId)).toEqual(["fresh"]); stop(); h.actions.dispose();
  });
  it("ignores pages delivered after teardown and aborts their owned scope", async () => {
    const h = harness(); const stop = contributePills(h.client, h.actions); await tick();
    let release!: (value: any) => void; vi.mocked(h.client.paseo.agents.list).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    h.snapshot([agent("a")], { hasMore: true, nextCursor: "pending" }); stop();
    release({ entries: [{ agent: agent("late") }], pageInfo: { hasMore: false } }); await tick(); expect(h.own).toHaveLength(0); expect(h.signal().aborted).toBe(true); h.actions.dispose();
  });
  it("retries observation failure and clears its retry timer on cleanup", async () => {
    vi.useFakeTimers(); vi.spyOn(console, "error").mockImplementation(() => {});
    const h = harness(); const stop = contributePills(h.client, h.actions); await tick();
    h.subscription.subscribe.mock.calls[0][0].error(new Error("Disconnected")); expect(h.signal().aborted).toBe(true); expect(h.unsubscribe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000); expect(h.client.paseo.agents.list).toHaveBeenCalledTimes(2); h.snapshot([agent("a")]); expect(h.own).toHaveLength(1);
    h.subscription.subscribe.mock.calls.at(-1)![0].error(new Error("Disconnected again")); stop(); await vi.advanceTimersByTimeAsync(3000);
    expect(h.client.paseo.agents.list).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0); h.actions.dispose();
  });
  it.each([
    { workspaceId: null }, { archivedAt: "now" }, { internal: true }, { parentAgentId: "parent" },
    { labels: { "paseo.parent-agent-id": "parent" } }, { labels: { "chat-title": "helper" } }, { title: "[Chat titles] naming a chat" },
  ])("excludes ineligible chats and removes a previously eligible one: %j", async (extra) => {
    const h = harness(); const stop = contributePills(h.client, h.actions); await tick(); h.snapshot([agent("excluded", extra), agent("a")]);
    expect(h.own).toHaveLength(1); h.upsert(agent("a", extra)); expect(h.own[0].registration.remove).toHaveBeenCalledOnce(); stop(); h.actions.dispose();
  });
  it("ignores a subscription delivered after cleanup", async () => {
    const h = harness(true); const stop = contributePills(h.client, h.actions); stop(); h.late(); await tick();
    expect(h.subscription.subscribe).not.toHaveBeenCalled(); expect(h.own).toHaveLength(0); expect(h.signal().aborted).toBe(true); h.actions.dispose();
  });
  it("unsubscribes once and ignores retained deliveries after disposal", async () => {
    const h = harness(); const stop = contributePills(h.client, h.actions); await tick(); h.snapshot([agent("a")]); stop(); stop(); h.snapshot([agent("b")]); h.upsert(agent("c"));
    expect(h.unsubscribe).toHaveBeenCalledTimes(1); expect(h.own).toHaveLength(1); expect(bus().listeners.size).toBe(0); h.actions.dispose();
  });
  it("routes Rename now and settings through the owner, not the hub's agent or providers", async () => {
    const h = harness(); const stop = contributePills(h.client, h.actions); await tick(); h.snapshot([agent("a")]);
    const tools = hub(); bus().hub = tools.api; broadcast();
    const tree = tools.entries[0].Content(props);
    await findButton(tree, "Rename now").onPress();
    expect(h.rpc.mock.calls[0][1]).toEqual({ agentId: "a", force: true }); expect(h.rpc.mock.calls[1][1]).toEqual({ jobId: "mine" });
    findButton(tree, "Auto-rename settings").onPress(); expect(h.client.openSettings).toHaveBeenCalledWith("titles"); expect(props.close).toHaveBeenCalled(); stop(); h.actions.dispose();
  });
});
