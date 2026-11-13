// Pill hub v1 cooperative protocol, copied from the local hub compatibility layer.
// Content in this plugin uses explicit owner-bound callbacks, never the hub's scoped hooks.
import type { PluginButton, PluginButtonContentProps, PluginButtonIcon, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import React, { type ComponentType } from "react";

const BUS_KEY = "__paseoPillHub";
const BUS_VERSION = 1;
type HubContent = ComponentType<PluginButtonContentProps>;
interface ToolInfo { toolId: string; title: string; label: string; glyph?: string }
interface HubEntry extends ToolInfo { agentId: string; workspaceId: string; icon: PluginButtonIcon; Content: HubContent; visible?: boolean; disabled?: boolean }
type HubEntryPatch = Partial<Pick<HubEntry, "title" | "label" | "icon" | "Content" | "visible" | "disabled" | "glyph">>;
interface HubAttachment { update(patch: HubEntryPatch): void; remove(): void }
interface HubApi { merges(toolId: string): boolean; attach(entry: HubEntry): HubAttachment }
interface Bus { version: number; hub?: HubApi; tools: Map<string, ToolInfo>; listeners: Set<() => void> }

function getBus(): Bus {
  const shared: unknown = React;
  const places = [shared, globalThis].filter((place): place is object => place !== null && (typeof place === "object" || typeof place === "function") && Object.isExtensible(place));
  const existing = places.map((place) => (place as Record<string, Bus | undefined>)[BUS_KEY]).find(Boolean);
  if (existing) return existing.version === BUS_VERSION ? existing : { version: BUS_VERSION, tools: new Map(), listeners: new Set() };
  const created: Bus = { version: BUS_VERSION, tools: new Map(), listeners: new Set() };
  for (const place of places) {
    try { Object.defineProperty(place, BUS_KEY, { value: created, configurable: true, writable: true, enumerable: false }); }
    catch { /* Other carriers can still share the bus. */ }
  }
  return created;
}

export interface ComposerPillSpec { toolId: string; agentId: string; workspaceId: string; button: PluginButton; glyph?: string }

export function registerComposerPill(client: PluginClientContext, spec: ComposerPillSpec): PluginButtonRegistration {
  const bus = getBus();
  const { toolId, agentId, workspaceId } = spec;
  let button = spec.button;
  let mode: "hub" | "own" | undefined;
  let placedHub: HubApi | undefined;
  let placed: HubAttachment | PluginButtonRegistration | undefined;
  let removed = false;
  const popover = () => button.behavior.kind === "popover" ? button.behavior.Content : undefined;
  const entryPatch = (Content: HubContent) => ({ title: button.title, label: button.label ?? button.title, icon: button.icon, Content, visible: button.visible, disabled: button.disabled });
  function place() {
    if (removed) return;
    const hub = bus.hub;
    const Content = popover();
    const want = hub && Content && hub.merges(toolId) ? "hub" : "own";
    // A reloaded hub is a new owner even when the merge mode is unchanged.
    if (want === mode && (want !== "hub" || hub === placedHub)) return;
    placed?.remove();
    placed = undefined;
    mode = want;
    placedHub = want === "hub" ? hub : undefined;
    if (hub && Content && want === "hub") placed = hub.attach({ toolId, agentId, workspaceId, glyph: spec.glyph, ...entryPatch(Content) });
    else placed = client.addComposerPill({ id: toolId, workspaceId, agentId, button });
  }
  if (!bus.tools.has(toolId)) {
    bus.tools.set(toolId, { toolId, title: button.title, label: button.label ?? button.title, glyph: spec.glyph });
    for (const listener of [...bus.listeners]) {
      try { listener(); } catch (error) { console.error("[chat-title] Pill hub listener failed", error); }
    }
  }
  bus.listeners.add(place);
  place();
  return {
    update(patch) {
      if (removed) return;
      const wasPopover = Boolean(popover());
      button = { ...button, ...patch };
      const Content = popover();
      if (Boolean(Content) !== wasPopover) { placed?.remove(); placed = undefined; mode = undefined; place(); }
      else if (mode === "hub" && Content) (placed as HubAttachment).update(entryPatch(Content));
      else (placed as PluginButtonRegistration).update(patch);
    },
    remove() {
      if (removed) return;
      removed = true;
      bus.listeners.delete(place);
      placed?.remove();
      placed = undefined;
    },
  };
}
