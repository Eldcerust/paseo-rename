import React, { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginButtonContentProps, PluginClientContext } from "@getpaseo/plugin/client";
import type { RetitleResult } from "../shared/types";
import { commandStore, type CommandState, type RenameActions } from "./commands";
import { createTitlePopover } from "./pill-popover";
import { interaction, isDark, statusSurface, tint, toneColor } from "./pill-style";
import { createTitleStore } from "./title-store";

const mutation = vi.hoisted(() => ({ isPending: false, isError: false, error: undefined as Error | undefined }));
vi.mock("react-native", () => ({ ActivityIndicator: "ActivityIndicator", Pressable: "Pressable", Text: "Text", View: "View" }));
vi.mock("@getpaseo/plugin/client/ui", () => ({ Icon: "Icon" }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot() }));
vi.mock("@tanstack/react-query", () => ({ useMutation: ({ mutationFn }: { mutationFn: () => unknown }) => ({ mutate: () => { void mutationFn(); }, ...mutation }) }));

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

const result: RetitleResult = { agentId: "a", status: "renamed", title: "Rainwater collection", chat: { status: "renamed" }, workspace: { status: "renamed" }, at: "2026-11-13T12:00:00Z" };
function setup(options: { state?: CommandState; title?: string | null; compact?: boolean } = {}) {
  const paseo = {};
  const titles = createTitleStore();
  if (options.title !== undefined) titles.set("a", options.title);
  if (options.state) commandStore(paseo).set(options.state);
  const order: string[] = [];
  const rename = vi.fn(async (_id: string) => {});
  const close = vi.fn(() => { order.push("close"); });
  const openSettings = vi.fn((_id: string) => { order.push("settings"); });
  const client = { paseo, openSettings } as unknown as PluginClientContext;
  const Popover = createTitlePopover(client, { rename, dispose: vi.fn() } as unknown as RenameActions, "a", titles);
  const props = { theme: { colors }, layout: { compact: options.compact ?? false, platform: "web" }, context: "agent", agentId: "hub-agent", workspaceId: "w", close } as unknown as PluginButtonContentProps;
  return { tree: () => root(<Popover {...props} />), rename, close, openSettings, order, titles, store: commandStore(paseo) };
}
beforeEach(() => { mutation.isPending = false; mutation.isError = false; mutation.error = undefined; });

describe("Auto rename popover", () => {
  it("shows the chat's live title, a status, and the two actions", () => {
    const view = setup({ title: "Rainwater collection for greenhouse irrigation" }).tree();
    const text = textOf(view);
    expect(text).toContain("THIS CHAT"); expect(text).toContain("Rainwater collection for greenhouse irrigation");
    expect(text).toContain("Ready to rename"); expect(text).toContain("Rename now"); expect(text).toContain("Auto-rename settings");
    expect(all(view).filter((node) => node.type === "Pressable")).toHaveLength(2);
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
    mutation.isPending = true; const rename = button(setup().tree(), "Rename now");
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
    mutation.isError = true; mutation.error = new Error("A rename of this chat is already running.");
    const text = textOf(setup().tree());
    expect(text).toContain("Couldn't rename"); expect(text).toContain("A rename of this chat is already running.");
  });
  it("prefers the stored outcome over an older mutation error", () => {
    mutation.isError = true; mutation.error = new Error("old problem");
    const text = textOf(setup({ state: { agentId: "a", pending: false, message: "m", result, at: Date.now() } }).tree());
    expect(text).toContain("Renamed"); expect(text).not.toContain("old problem");
  });
  it("keeps the title and status areas one height on a phone, and natural on desktop", () => {
    const find = (view: Node) => ({ title: style(all(view).find((node) => node.type === "Text" && node.props.numberOfLines === 2)!), band: style(all(view).find((node) => node.props.accessibilityLiveRegion === "polite")!) });
    expect(find(setup({ compact: true }).tree())).toMatchObject({ title: { minHeight: 44 }, band: { minHeight: 96 } });
    expect(find(setup({ compact: false }).tree())).toMatchObject({ title: { minHeight: 0 }, band: { minHeight: 0 } });
  });
  it("gives both buttons a role, a label, and a touch target of at least 44", () => {
    const view = setup().tree();
    for (const label of ["Rename now", "Auto-rename settings"]) {
      const target = button(view, label);
      expect(target.props.accessibilityRole).toBe("button"); expect(style(target).minHeight).toBeGreaterThanOrEqual(44);
    }
  });
  it("takes every color from the theme or from a tint of a theme status color", () => {
    const states: (CommandState | undefined)[] = [undefined, { agentId: "a", pending: true, message: "" }, { agentId: "a", pending: false, message: "m", result, at: 1 }, { agentId: "a", pending: false, failed: true, message: "m", at: 1 }];
    const allowed = new Set<string>([...Object.values(colors), "transparent", tint(colors.statusSuccess, 0x29 / 255, ""), tint(colors.statusDanger, 0x29 / 255, "")]);
    for (const state of states) {
      for (const node of all(setup({ state, title: "A title" }).tree())) {
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
