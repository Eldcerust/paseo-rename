import type { PluginAgentCommandContext, PluginClientContext } from "@getpaseo/plugin/client";
import { retitleChat } from "../shared/rpc";
import type { RetitleResult } from "../shared/types";

export const TITLES_SCREEN = "titles";
export const TITLES_SETTINGS = "titles";

export interface CommandState { agentId: string; pending: boolean; message: string }
const stores = new WeakMap<object, ReturnType<typeof createCommandStore>>();
function createCommandStore() {
  let state: CommandState | undefined;
  const listeners = new Set<() => void>();
  return {
    snapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    set(next: CommandState | undefined) { state = next; for (const listener of listeners) listener(); },
  };
}
/** The SDK provides the same API instance to this installation's callbacks and surfaces. */
export function commandStore(paseo: object) {
  let store = stores.get(paseo);
  if (!store) { store = createCommandStore(); stores.set(paseo, store); }
  return store;
}

/** Include both target outcomes, including partial success, rather than hiding a workspace failure. */
export function describeResult(result: RetitleResult): string {
  const lead = result.status === "renamed" ? `Title updated: ${result.title ?? "untitled"}.`
    : result.status === "unchanged" ? `Title still fits: ${result.title ?? result.previous ?? "untitled"}.`
    : result.status === "failed" ? "Could not update the title." : "Title left unchanged.";
  const targets = (["chat", "workspace"] as const).flatMap((key) => {
    const outcome = result[key];
    return outcome ? [`${key === "chat" ? "Chat" : "Workspace"}: ${outcome.status}${outcome.detail ? ` (${outcome.detail})` : ""}.`] : [];
  });
  return [lead, result.reason, ...targets].filter(Boolean).join(" ");
}

/** A registration-local store. It cannot leak pending state across hosts or plugin reloads. */
export function registerCommands(client: PluginClientContext) {
  const pending = new Set<string>();
  const store = commandStore(client.paseo);
  let disposed = false;
  async function rename(context: PluginAgentCommandContext) {
    if (disposed) throw new Error("Chat titles is no longer active.");
    const id = context.agent.id;
    if (pending.has(id)) throw new Error("A rename of this chat is already running.");
    pending.add(id);
    store.set({ agentId: id, pending: true, message: "Writing a title from recent messages…" });
    try {
      // The screen polls overview while this RPC is pending, so slash commands have visible progress.
      context.openScreen({ screenId: TITLES_SCREEN, params: { agentId: id } });
      const result = await context.rpc(retitleChat, { agentId: id, force: true });
      if (!disposed) store.set({ agentId: id, pending: false, message: describeResult(result) });
      if (result.status === "failed" || result.chat?.status === "failed" || result.workspace?.status === "failed") {
        throw new Error(describeResult(result));
      }
    } catch (error) {
      if (!disposed) store.set({ agentId: id, pending: false, message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      pending.delete(id);
    }
  }
  const removers = [
    client.addSlashCommand({
      name: "retitle", description: "Rename this chat from its recent messages (replaces a custom title)",
      argumentHint: "", context: "agent",
      async onSubmit(context) {
        if (context.args.trim()) throw new Error("Use /retitle without arguments. Choose the model and targets in Chat titles settings.");
        await rename(context);
      },
    }),
    client.addCommandCenterItem({ id: "retitle", title: "Rename this chat from recent messages", icon: "CaseSensitive", keywords: ["retitle", "title", "rename"], context: "agent", onSelect: rename }),
    client.addCommandCenterItem({ id: "settings", title: "Chat titles settings", icon: "Settings2", keywords: ["retitle", "provider", "model"], context: "global", onSelect: ({ openSettings }) => openSettings(TITLES_SETTINGS) }),
  ];
  return () => {
    if (disposed) return;
    disposed = true;
    for (const remove of removers.reverse()) remove();
    pending.clear();
    store.set(undefined);
  };
}
