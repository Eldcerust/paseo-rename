import React, { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginButtonContentProps, PluginClientContext } from "@getpaseo/plugin/client";
import { setTitleChatAuto, titleChatAuto } from "../shared/rpc";
import type { RetitleResult } from "../shared/types";
import { autoQueryKey, type ChatAuto } from "./chat-auto";
import { commandStore, type CommandState, type RenameActions } from "./commands";
import { createTitlePopover } from "./pill-popover";
import { interaction, isDark, statusSurface, tint, toneColor } from "./pill-style";
import { createTitleStore } from "./title-store";

type Status = { isPending: boolean; isError: boolean; error: Error | undefined };
const fake = vi.hoisted(() => ({
  rename: { isPending: false, isError: false, error: undefined } as { isPending: boolean; isError: boolean; error: Error | undefined },
  write: { isPending: false, isError: false, error: undefined, variables: undefined } as { isPending: boolean; isError: boolean; error: Error | undefined; variables: boolean | undefined },
  query: { data: undefined, isPending: true, isError: false, error: undefined } as { data: unknown; isPending: boolean; isError: boolean; error: Error | undefined },
  refetch: vi.fn(),
  setQueryData: vi.fn(),
  mutates: [] as { kind: "rename" | "write"; value: unknown }[],
  queryOptions: [] as any[],
  writeOptions: [] as any[],
}));
vi.mock("react-native", () => ({ ActivityIndicator: "ActivityIndicator", Pressable: "Pressable", Text: "Text", View: "View" }));
vi.mock("@getpaseo/plugin/client/ui", () => ({ Icon: "Icon" }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot() }));
vi.mock("@tanstack/react-query", () => ({
  useMutation: (options: { mutationKey: string[]; mutationFn: (value?: unknown) => unknown }) => {
    const kind = options.mutationKey[1] === "chat-auto-write" ? "write" : "rename";
    if (kind === "write") fake.writeOptions.push(options);
    return { mutate: (value?: unknown) => { fake.mutates.push({ kind, value }); void options.mutationFn(value); }, ...fake[kind] };
  },
  useQuery: (options: unknown) => { fake.queryOptions.push(options); return { ...fake.query, refetch: fake.refetch }; },
  useQueryClient: () => ({ setQueryData: fake.setQueryData }),
}));

const colors = {
  surface0: "#18181b", surface1: "#1f1f22", surface2: "#27272a", border: "#27272a", foreground: "#fafafa", foregroundMuted: "#a1a1aa",
  accent: "#e4e4e7", accentForeground: "#18181b", statusSuccess: "#6cb17b", statusWarning: "#c09664", statusDanger: "#d8847b",
};
interface Node { type: string; props: Record<string, any>; children: (Node | string)[] }

/** Expands pure function components so the host-level tree (View, Text, Pressable, Icon...) can be inspected. */
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
const root = (tree: ReactNode) => expand(tree)[0] as Node;
const walk = (node: Node | string, visit: (node: Node) => void) => { if (typeof node === "string") return; visit(node); node.children.forEach((child) => walk(child, visit)); };
const all = (tree: Node) => { const nodes: Node[] = []; walk(tree, (node) => nodes.push(node)); return nodes; };
const textOf = (node: Node | string): string => typeof node === "string" ? node : node.children.map(textOf).join("");
const style = (node: Node) => { const value = typeof node.props.style === "function" ? node.props.style({ pressed: false }) : node.props.style; return (Array.isArray(value) ? Object.assign({}, ...value) : value ?? {}) as Record<string, any>; };
const button = (tree: Node, label: string) => all(tree).find((node) => node.type === "Pressable" && node.props.accessibilityLabel === label)!;
const SWITCH = "Rename this chat automatically";

const result: RetitleResult = { agentId: "a", status: "renamed", title: "Rainwater collection", chat: { status: "renamed" }, workspace: { status: "renamed" }, at: "2026-11-13T12:00:00Z" };
const chat = (extra: Partial<ChatAuto> = {}): ChatAuto => ({ agentId: "a", enabled: false, allowed: true, everyTurns: 4, ...extra });
function setup(options: { state?: CommandState; title?: string | null; compact?: boolean; auto?: ChatAuto | "loading" | "readfail" } = {}) {
  const paseo = {};
  const titles = createTitleStore();
  if (options.title !== undefined) titles.set("a", options.title);
  if (options.state) commandStore(paseo).set(options.state);
  if (options.auto === "loading") fake.query = { data: undefined, isPending: true, isError: false, error: undefined };
  else if (options.auto === "readfail") fake.query = { data: undefined, isPending: false, isError: true, error: new Error("Host offline") };
  else fake.query = { data: options.auto ?? chat(), isPending: false, isError: false, error: undefined };
  const order: string[] = [];
  const rename = vi.fn(async (_id: string) => {});
  const close = vi.fn(() => { order.push("close"); });
  const openSettings = vi.fn((_id: string) => { order.push("settings"); });
  const rpc = vi.fn(async (_contract: unknown, input: any) => ({ agentId: input.agentId, enabled: input.enabled ?? false, allowed: true, everyTurns: 4 }));
  const client = { paseo, openSettings, rpc } as unknown as PluginClientContext;
  const Popover = createTitlePopover(client, { rename, dispose: vi.fn() } as unknown as RenameActions, "a", titles);
  const props = { theme: { colors }, layout: { compact: options.compact ?? false, platform: "web" }, host: { id: "host-1", label: "Host" }, context: "agent", agentId: "hub-agent", workspaceId: "w", close } as unknown as PluginButtonContentProps;
  return { tree: () => root(<Popover {...props} />), rename, close, openSettings, order, rpc, titles, store: commandStore(paseo) };
}
beforeEach(() => {
  fake.rename = { isPending: false, isError: false, error: undefined }; fake.write = { isPending: false, isError: false, error: undefined, variables: undefined };
  fake.query = { data: undefined, isPending: true, isError: false, error: undefined };
  fake.mutates.length = 0; fake.queryOptions.length = 0; fake.writeOptions.length = 0; fake.refetch.mockReset(); fake.setQueryData.mockReset();
});

describe("Auto rename popover", () => {
  it("shows the chat's live title, a status, the primary action and the switch group", () => {
    const view = setup({ title: "Rainwater collection for greenhouse irrigation" }).tree();
    const text = textOf(view);
    expect(text).toContain("THIS CHAT"); expect(text).toContain("Rainwater collection for greenhouse irrigation");
    expect(text).toContain("Ready to rename"); expect(text).toContain("Rename now"); expect(text).toContain("Rename automatically"); expect(text).toContain("Auto-rename settings");
    expect(all(view).filter((node) => node.type === "Pressable").map((node) => node.props.accessibilityLabel)).toEqual(["Rename now", SWITCH, "Auto-rename settings"]);
  });
  it.each([[null], [undefined]])("shows a muted 'Untitled chat' when the title is %s", (title) => {
    const view = setup({ title }).tree();
    const label = all(view).find((node) => node.type === "Text" && textOf(node) === "Untitled chat")!;
    expect(label).toBeDefined(); expect(style(label).color).toBe(colors.foregroundMuted);
  });
  it("uses the chat's own agent id, not the one the hub passes", async () => {
    const h = setup(); button(h.tree(), "Rename now").props.onPress();
    expect(h.rename).toHaveBeenCalledTimes(1); expect(h.rename).toHaveBeenCalledWith("a");
  });
  it("closes the popover before opening Chat titles settings", () => {
    const h = setup(); button(h.tree(), "Auto-rename settings").props.onPress();
    expect(h.order).toEqual(["close", "settings"]); expect(h.openSettings).toHaveBeenCalledWith("titles");
  });
  it("blocks a second press and shows progress while a run is pending in the store", () => {
    const view = setup({ state: { agentId: "a", pending: true, message: "w" } }).tree();
    const rename = button(view, "Rename now");
    expect(rename.props.disabled).toBe(true); expect(rename.props.accessibilityState).toEqual({ busy: true, disabled: true });
    expect(textOf(rename)).toBe("Renaming…"); expect(all(rename).some((node) => node.type === "ActivityIndicator")).toBe(true);
    expect(textOf(view)).toContain("Writing a title…"); expect(all(view).filter((node) => node.type === "ActivityIndicator")).toHaveLength(2);
  });
  it("also blocks while this popover's own mutation is pending", () => {
    fake.rename.isPending = true; const rename = button(setup().tree(), "Rename now");
    expect(rename.props.disabled).toBe(true);
  });
  it("draws a finished rename as a tinted success band with one chip per target", () => {
    const view = setup({ state: { agentId: "a", pending: false, message: "m", result, at: Date.now() } }).tree();
    const band = all(view).find((node) => node.props.accessibilityLiveRegion === "polite")!;
    expect(style(band).backgroundColor).toBe(tint(colors.statusSuccess, 0x29 / 255, colors.surface2));
    expect(textOf(band)).toContain("Renamed"); expect(textOf(band)).toContain("Chat · renamed"); expect(textOf(band)).toContain("Workspace · renamed"); expect(textOf(band)).toContain("just now");
    expect(band.props.accessibilityRole).toBeUndefined();
    expect(band.props.accessibilityLabel).toBe("Renamed. Chat renamed. Workspace renamed");
  });
  it("draws a failure as an alert on a danger tint, with a selectable reason", () => {
    const view = setup({ state: { agentId: "a", pending: false, failed: true, message: "m", at: Date.now(), result: { ...result, status: "failed", reason: "Provider quota exhausted", chat: undefined, workspace: undefined } } }).tree();
    const band = all(view).find((node) => node.props.accessibilityLiveRegion === "polite")!;
    expect(band.props.accessibilityRole).toBe("alert"); expect(style(band).backgroundColor).toBe(tint(colors.statusDanger, 0x29 / 255, colors.surface2));
    const reason = all(band).find((node) => textOf(node) === "Provider quota exhausted")!;
    expect(reason.props.selectable).toBe(true); expect(reason.props.numberOfLines).toBe(3);
  });
  it("leaves a neutral outcome on the card, without a tint", () => {
    const view = setup({ state: { agentId: "a", pending: false, message: "m", at: Date.now(), result: { ...result, status: "unchanged", reason: "Fits" } } }).tree();
    expect(style(all(view).find((node) => node.props.accessibilityLiveRegion === "polite")!).backgroundColor).toBe("transparent");
  });
  it("reports a failure that never reached the store, such as a duplicate request", () => {
    fake.rename.isError = true; fake.rename.error = new Error("A rename of this chat is already running.");
    const text = textOf(setup().tree());
    expect(text).toContain("Couldn't rename"); expect(text).toContain("A rename of this chat is already running.");
  });
  it("prefers the stored outcome over an older mutation error", () => {
    fake.rename.isError = true; fake.rename.error = new Error("old problem");
    const text = textOf(setup({ state: { agentId: "a", pending: false, message: "m", result, at: Date.now() } }).tree());
    expect(text).toContain("Renamed"); expect(text).not.toContain("old problem");
  });
  it("keeps the title and status areas one height on a phone, and natural on desktop", () => {
    const find = (view: Node) => ({ title: style(all(view).find((node) => node.type === "Text" && node.props.numberOfLines === 2)!), band: style(all(view).find((node) => node.props.accessibilityLiveRegion === "polite")!) });
    expect(find(setup({ compact: true }).tree())).toMatchObject({ title: { minHeight: 44 }, band: { minHeight: 96 } });
    expect(find(setup({ compact: false }).tree())).toMatchObject({ title: { minHeight: 0 }, band: { minHeight: 0 } });
  });
  it("gives every button a role, a label, and a touch target of at least 44", () => {
    const view = setup().tree();
    for (const label of ["Rename now", SWITCH, "Auto-rename settings"]) {
      const target = button(view, label);
      expect(target.props.accessibilityRole).toBe(label === SWITCH ? "switch" : "button"); expect(style(target).minHeight).toBeGreaterThanOrEqual(44);
    }
  });
  it("takes every color from the theme or from a tint of a theme status color", () => {
    const states: (CommandState | undefined)[] = [undefined, { agentId: "a", pending: true, message: "" }, { agentId: "a", pending: false, message: "m", result, at: 1 }, { agentId: "a", pending: false, failed: true, message: "m", at: 1 }];
    const allowed = new Set<string>([...Object.values(colors), "transparent", tint(colors.statusSuccess, 0x29 / 255, ""), tint(colors.statusDanger, 0x29 / 255, "")]);
    for (const auto of [chat(), chat({ enabled: true }), chat({ allowed: false }), "loading", "readfail"] as const) for (const state of states) {
      for (const node of all(setup({ state, title: "A title", auto }).tree())) {
        const resolved = style(node);
        for (const [key, value] of Object.entries({ ...resolved, color: node.type === "Icon" || node.type === "ActivityIndicator" ? node.props.color : resolved.color })) {
          if (/color$/i.test(key) && typeof value === "string") expect(allowed, `${node.type}.${key}=${value}`).toContain(value);
        }
      }
    }
  });
  it("dims a pressed or hovered button and the busy one, using the theme accent otherwise", () => {
    const view = setup().tree(); const target = button(view, "Rename now");
    expect(style(target).backgroundColor).toBe(colors.accent);
    expect(target.props.style({ pressed: true }).opacity).toBe(0.78); expect(target.props.style({ pressed: false, hovered: true }).opacity).toBe(0.92);
    expect(style(button(setup({ state: { agentId: "a", pending: true, message: "" } }).tree(), "Rename now")).opacity).toBe(0.6);
  });
});

describe("automatic renaming switch in the popover", () => {
  const track = (view: Node) => all(button(view, SWITCH)).find((node) => node.type === "View" && style(node).width === 40)!;
  it("starts off for a chat that was never switched on, as a switch that is not checked", () => {
    const view = setup().tree(); const row = button(view, SWITCH);
    expect(row.props.accessibilityState).toEqual({ checked: false, disabled: false, busy: false });
    expect(textOf(row)).toContain("Off for this chat");
    expect(style(track(view))).toMatchObject({ alignItems: "flex-start", borderColor: colors.foregroundMuted, backgroundColor: colors.surface2 });
  });
  it("shows a switched-on chat with the thumb at the other end, the accent, the interval, and a status that says when it renames", () => {
    const view = setup({ auto: chat({ enabled: true }) }).tree(); const row = button(view, SWITCH);
    expect(row.props.accessibilityState).toMatchObject({ checked: true }); expect(textOf(row)).toContain("On · every 4 completed turns");
    expect(style(track(view))).toMatchObject({ alignItems: "flex-end", borderColor: colors.accent, backgroundColor: colors.accent });
    expect(textOf(view)).toContain("Renames after the next completed turn, then every 4. Leaves custom titles alone.");
  });
  it("writes the opposite of what it shows when pressed, once", () => {
    const off = setup(); button(off.tree(), SWITCH).props.onPress();
    expect(fake.mutates).toEqual([{ kind: "write", value: true }]);
    fake.mutates.length = 0;
    const on = setup({ auto: chat({ enabled: true }) }); button(on.tree(), SWITCH).props.onPress();
    expect(fake.mutates).toEqual([{ kind: "write", value: false }]);
  });
  it("writes through this plugin's own RPC for this chat, never the hub's agent id, and stores the answer", async () => {
    const h = setup(); h.tree();
    const options = fake.writeOptions.at(-1);
    const saved = await options.mutationFn(true);
    expect(h.rpc).toHaveBeenCalledWith(setTitleChatAuto, { agentId: "a", enabled: true }); expect(saved).toMatchObject({ agentId: "a", enabled: true });
    options.onSuccess(saved);
    expect(fake.setQueryData).toHaveBeenCalledWith(autoQueryKey("host-1", "a"), saved);
    expect(JSON.stringify(h.rpc.mock.calls)).not.toContain("hub-agent");
  });
  it("reads through this plugin's own RPC with a key for this host and chat, and does not retry in the background", async () => {
    const h = setup(); h.tree();
    const options = fake.queryOptions.at(-1);
    expect(options.queryKey).toEqual(["chat-title", "chat-auto", "host-1", "a"]); expect(options.retry).toBe(false);
    await options.queryFn();
    expect(h.rpc).toHaveBeenCalledWith(titleChatAuto, { agentId: "a" });
  });
  it("gives two chats of one host their own keys, so one popover never shows the other's answer", () => {
    fake.query = { data: chat(), isPending: false, isError: false, error: undefined };
    const make = (id: string) => createTitlePopover({ paseo: {}, openSettings: vi.fn(), rpc: vi.fn() } as unknown as PluginClientContext, { rename: vi.fn(), dispose: vi.fn() } as unknown as RenameActions, id, createTitleStore());
    const props = { theme: { colors }, layout: { compact: false, platform: "web" }, host: { id: "host-1", label: "Host" }, context: "agent", agentId: "hub-agent", workspaceId: "w", close: vi.fn() } as unknown as PluginButtonContentProps;
    const First = make("chat-one"); const Second = make("chat-two");
    root(<First {...props} />); root(<Second {...props} />);
    expect(fake.queryOptions.map((options) => options.queryKey)).toEqual([autoQueryKey("host-1", "chat-one"), autoQueryKey("host-1", "chat-two")]);
  });
  it.each([
    ["while the first read is loading", "loading", "Checking…"],
    ["when the read failed", "readfail", "Couldn't read this chat's setting"],
    ["when the host master switch is off", chat({ allowed: false }), "Turned off for all chats in settings"],
  ] as const)("cannot be pressed %s", (_name, auto, hint) => {
    const row = button(setup({ auto }).tree(), SWITCH);
    expect(row.props.disabled).toBe(true); expect(row.props.accessibilityState.disabled).toBe(true); expect(textOf(row)).toContain(hint);
  });
  it("shows the value being saved at once, as busy and disabled", () => {
    fake.write.isPending = true; fake.write.variables = true;
    const view = setup().tree(); const row = button(view, SWITCH);
    expect(row.props.accessibilityState).toEqual({ checked: true, disabled: true, busy: true }); expect(textOf(row)).toContain("Saving…");
    expect(style(track(view)).alignItems).toBe("flex-end");
  });
  it("shows why a read failed with a Try again that reads again", () => {
    const view = setup({ auto: "readfail" }).tree();
    const alert = all(view).find((node) => node.props.accessibilityRole === "alert" && textOf(node).includes("Host offline"))!;
    expect(alert).toBeDefined(); button(view, "Try again").props.onPress(); expect(fake.refetch).toHaveBeenCalledTimes(1);
  });
  it("shows a failed save as a problem under the row, keeps the saved value, and leaves the switch pressable", () => {
    fake.write.isError = true; fake.write.error = new Error("Disk full");
    const view = setup({ auto: chat({ enabled: true }) }).tree(); const row = button(view, SWITCH);
    expect(textOf(view)).toContain("Disk full"); expect(row.props.accessibilityState).toMatchObject({ checked: true, disabled: false });
    expect(all(view).some((node) => node.props.accessibilityLabel === "Try again")).toBe(false);
  });
  it("offers no Try again when nothing failed", () => {
    expect(all(setup().tree()).some((node) => node.props.accessibilityLabel === "Try again")).toBe(false);
  });
  it("keeps the switch and the settings row in one grouped card, settings last", () => {
    const view = setup().tree();
    const group = all(view).find((node) => node.type === "View" && node.children.some((child) => typeof child !== "string" && child.props.accessibilityLabel === SWITCH))!;
    expect(group.children.filter((child): child is Node => typeof child !== "string").map((child) => child.props.accessibilityLabel).filter(Boolean)).toEqual([SWITCH, "Auto-rename settings"]);
    expect(style(group)).toMatchObject({ borderWidth: 1, borderColor: colors.border, overflow: "hidden" });
  });
});

describe("pill style helpers", () => {
  it("builds a tint the way the app does: the color plus a two-digit alpha", () => {
    expect(tint("#6cb17b", 0x29 / 255, "x")).toBe("#6cb17b29"); expect(tint("#3e704a", 0x1f / 255, "x")).toBe("#3e704a1f"); expect(tint("#abc", 1, "x")).toBe("#aabbccff");
    expect(tint("#ffffff", 5, "x")).toBe("#ffffffff"); expect(tint("#ffffff", -1, "x")).toBe("#ffffff00");
  });
  it("falls back instead of producing a broken color for a theme color that is not plain hex", () => {
    for (const odd of ["rgb(1, 2, 3)", "hsl(10 20% 30%)", "red", "", "#12345"]) expect(tint(odd, 0.2, "fallback")).toBe("fallback");
    expect(statusSurface("success", { ...colors, statusSuccess: "rgb(1, 2, 3)" })).toBe(colors.surface2);
  });
  it("tells a dark surface from a light one and treats an unreadable color as light", () => {
    expect(isDark({ ...colors, surface0: "#18181b" })).toBe(true); expect(isDark({ ...colors, surface0: "#ffffff" })).toBe(false); expect(isDark({ ...colors, surface0: "white" })).toBe(false);
    expect(statusSurface("danger", { ...colors, surface0: "#ffffff" })).toBe("#d8847b1f");
  });
  it("tints only success and danger, and colors icons by tone", () => {
    for (const tone of ["idle", "working", "neutral"] as const) expect(statusSurface(tone, colors)).toBe("transparent");
    expect(toneColor("success", colors)).toBe(colors.statusSuccess); expect(toneColor("danger", colors)).toBe(colors.statusDanger); expect(toneColor("neutral", colors)).toBe(colors.foregroundMuted);
  });
  it("orders interaction opacity pressed < hovered < rest", () => {
    expect([interaction({ pressed: true }), interaction({ pressed: false, hovered: true }), interaction({ pressed: false })]).toEqual([0.78, 0.92, 1]);
  });
});
