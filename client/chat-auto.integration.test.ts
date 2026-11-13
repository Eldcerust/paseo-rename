import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React, { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginButtonContentProps, PluginClientContext } from "@getpaseo/plugin/client";
import contribute from "../index.server";
import { chatTitleSettings } from "../shared/settings";
import type { RenameActions } from "./commands";
import { createTitlePopover } from "./pill-popover";
import { createTitleStore } from "./title-store";

/**
 * The real popover against the real server entry and a real state file, in one process. Only react-query's cache
 * bookkeeping is stood in for (it needs a renderer): a read runs the popover's own queryFn against the server, a press
 * runs its own mutationFn and onSuccess, and the next render sees the cache the way react-query would show it.
 */
const rq = vi.hoisted(() => ({
  cache: new Map<string, unknown>(),
  queryOptions: [] as any[],
  writeOptions: [] as any[],
  write: { isPending: false, isError: false, error: undefined as Error | undefined, variables: undefined as boolean | undefined },
}));
vi.mock("react-native", () => ({ ActivityIndicator: "ActivityIndicator", Pressable: "Pressable", Text: "Text", View: "View" }));
vi.mock("@getpaseo/plugin/client/ui", () => ({ Icon: "Icon" }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot() }));
vi.mock("@tanstack/react-query", () => ({
  useMutation: (options: any) => {
    if (options.mutationKey[1] === "chat-auto-write") rq.writeOptions.push(options);
    return { mutate: () => {}, isPending: false, isError: false, ...(options.mutationKey[1] === "chat-auto-write" ? rq.write : {}) };
  },
  useQuery: (options: any) => {
    rq.queryOptions.push(options);
    const key = JSON.stringify(options.queryKey);
    return { data: rq.cache.get(key), isPending: !rq.cache.has(key), isError: false, error: undefined, refetch: () => {} };
  },
  useQueryClient: () => ({ setQueryData: (key: unknown, value: unknown) => { rq.cache.set(JSON.stringify(key), value); } }),
}));

interface Node { type: string; props: Record<string, any>; children: (Node | string)[] }
function expand(node: ReactNode): (Node | string)[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [String(node)];
  if (Array.isArray(node)) return node.flatMap(expand);
  if (!isValidElement(node)) return [];
  const { type, props } = node as { type: unknown; props: Record<string, any> };
  if (typeof type === "function") return expand((type as (p: unknown) => ReactNode)(props));
  if (type === React.Fragment) return expand(props.children);
  return [{ type: String(type), props, children: expand(props.children) }];
}
const textOf = (node: Node | string): string => typeof node === "string" ? node : node.children.map(textOf).join("");
const find = (node: Node, label: string): Node | undefined => node.props.accessibilityLabel === label ? node : node.children.flatMap((child) => typeof child === "string" ? [] : [find(child, label)]).find(Boolean);
const SWITCH = "Rename this chat automatically";
const colors = { surface0: "#18181b", surface1: "#1f1f22", surface2: "#27272a", border: "#27272a", foreground: "#fafafa", foregroundMuted: "#a1a1aa", accent: "#e4e4e7", accentForeground: "#18181b", statusSuccess: "#6cb17b", statusWarning: "#c09664", statusDanger: "#d8847b" };

let folder: string;
let previousHome: string | undefined;
const stops: (() => Promise<void>)[] = [];
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "chat-auto-client-"));
  previousHome = process.env.PASEO_HOME; process.env.PASEO_HOME = folder;
  rq.cache.clear(); rq.queryOptions.length = 0; rq.writeOptions.length = 0; rq.write = { isPending: false, isError: false, error: undefined, variables: undefined };
});
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  if (previousHome === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previousHome;
  rmSync(folder, { recursive: true, force: true });
});

function host() {
  const values = chatTitleSettings.schema.parse({});
  let readable = true;
  const seen: { name: string; input: any }[] = [];
  function boot() {
    const handlers = new Map<string, (input: unknown, context: unknown) => Promise<any>>();
    const server = {
      registerSettings: () => ({ read: async () => readable ? { status: "ready", values } : { status: "invalid", error: "broken" } }),
      handle: (contract: { name: string }, handler: (input: unknown, context: unknown) => Promise<any>) => handlers.set(contract.name, handler),
      addHook: () => () => {},
    };
    const cleanup = contribute(server as never);
    const stop = async () => { await cleanup(); }; stops.push(stop);
    // The client's rpc: validates input and output with the real contracts, like the plugin runtime does.
    const rpc = async (contract: { name: string; input: { parse(v: unknown): unknown }; output: { parse(v: unknown): unknown } }, input: unknown) => {
      seen.push({ name: contract.name, input });
      return contract.output.parse(await handlers.get(contract.name)!(contract.input.parse(input), { paseo: {} }));
    };
    return { stop, rpc };
  }
  return { values, seen, boot, breakSettings: () => { readable = false; } };
}

function popover(rpc: (c: any, i: unknown) => Promise<unknown>, agentId: string) {
  const client = { paseo: {}, openSettings: vi.fn(), rpc } as unknown as PluginClientContext;
  const Popover = createTitlePopover(client, { rename: vi.fn(), dispose: vi.fn() } as unknown as RenameActions, agentId, createTitleStore());
  const props = { theme: { colors }, layout: { compact: false, platform: "web" }, host: { id: "host-1", label: "Host" }, context: "agent", agentId: "hub-agent", workspaceId: "w", close: vi.fn() } as unknown as PluginButtonContentProps;
  const render = () => expand(React.createElement(Popover, props))[0] as Node;
  /** What react-query does on mount: run the popover's own queryFn and cache its answer. */
  const load = async () => { render(); const options = rq.queryOptions.at(-1); rq.cache.set(JSON.stringify(options.queryKey), await options.queryFn()); return render(); };
  /** A press on the switch: the popover's own mutationFn, then its own onSuccess, as react-query would call them. */
  const press = async () => {
    const view = render(); const row = find(view, SWITCH)!; const next = !(row.props.accessibilityState.checked);
    const options = rq.writeOptions.at(-1);
    rq.write = { isPending: false, isError: false, error: undefined, variables: next };
    try { options.onSuccess(await options.mutationFn(next)); } catch (error) { rq.write = { isPending: false, isError: true, error: error as Error, variables: next }; }
    return render();
  };
  return { load, press, render };
}

describe("the popover and the real server entry", () => {
  it("shows a chat that was never switched on as off, then switches it on through the server and shows it on", async () => {
    const w = host(); const { rpc } = w.boot(); const chat = popover(rpc, "chat-1");
    const first = await chat.load();
    expect(find(first, SWITCH)!.props.accessibilityState).toMatchObject({ checked: false, disabled: false }); expect(textOf(first)).toContain("Off for this chat");
    const after = await chat.press();
    expect(find(after, SWITCH)!.props.accessibilityState).toMatchObject({ checked: true, disabled: false }); expect(textOf(after)).toContain("On · every 4 completed turns");
    expect(textOf(after)).toContain("Renames after the next completed turn, then every 4.");
    const off = await chat.press();
    expect(find(off, SWITCH)!.props.accessibilityState).toMatchObject({ checked: false }); expect(textOf(off)).toContain("Off for this chat");
  });

  it("remembers the choice: a freshly started plugin and a new popover show it on", async () => {
    const w = host(); const first = w.boot(); const chat = popover(first.rpc, "chat-1");
    await chat.load(); await chat.press(); await first.stop();
    rq.cache.clear();
    const second = w.boot(); const again = await popover(second.rpc, "chat-1").load();
    expect(find(again, SWITCH)!.props.accessibilityState).toMatchObject({ checked: true });
  });

  it("keeps two chats apart", async () => {
    const w = host(); const { rpc } = w.boot(); const one = popover(rpc, "chat-1"); const two = popover(rpc, "chat-2");
    await one.load(); await two.load(); await one.press();
    expect(find(await one.load(), SWITCH)!.props.accessibilityState.checked).toBe(true);
    expect(find(await two.load(), SWITCH)!.props.accessibilityState.checked).toBe(false);
  });

  it("reads and writes only for the chat it belongs to, never the hub's agent id", async () => {
    const w = host(); const { rpc } = w.boot(); const chat = popover(rpc, "chat-1");
    await chat.load(); await chat.press();
    expect(w.seen.map((call) => call.name)).toEqual(["chat-title.chat-auto", "chat-title.set-chat-auto"]);
    expect(w.seen.every((call) => call.input.agentId === "chat-1")).toBe(true);
  });

  it("shows a failed save as a problem and leaves the stored choice off", async () => {
    const w = host(); const { rpc } = w.boot(); const chat = popover(rpc, "chat-1");
    await chat.load(); w.breakSettings();
    const failed = await chat.press();
    expect(textOf(failed)).toContain("could not be read"); expect(find(failed, SWITCH)!.props.accessibilityState).toMatchObject({ checked: false, disabled: false });
    expect(rq.cache.get(JSON.stringify(rq.queryOptions.at(-1).queryKey))).toMatchObject({ enabled: false });
  });

  it("disables the switch with an explanation while the host master switch is off, and keeps the chat's own choice", async () => {
    const w = host(); const { rpc } = w.boot(); const chat = popover(rpc, "chat-1");
    await chat.load(); await chat.press();
    w.values.auto.enabled = false;
    const view = await chat.load();
    expect(find(view, SWITCH)!.props.accessibilityState).toMatchObject({ checked: true, disabled: true }); expect(textOf(view)).toContain("Turned off for all chats in settings");
    w.values.auto.enabled = true;
    expect(find(await chat.load(), SWITCH)!.props.accessibilityState).toMatchObject({ checked: true, disabled: false });
  });
});
