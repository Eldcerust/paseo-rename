import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import type { RenameActions } from "./commands";
import { registerComposerPill } from "./hub-compat";
import { createTitlePopover } from "./pill-popover";
import { createTitleStore } from "./title-store";

type ListedAgent = Awaited<ReturnType<PluginClientContext["paseo"]["agents"]["list"]>>["entries"][number]["agent"];

export function contributePills(client: PluginClientContext, actions: RenameActions) {
  const lifetime = new AbortController();
  // Live chat titles for the popover's title card, fed by the same directory that decides which chats get a pill.
  const titles = createTitleStore();
  const pills = new Map<string, { workspaceId: string; registration: PluginButtonRegistration }>();
  let unsubscribe: (() => void) | undefined;
  let connection: AbortController | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let epoch = 0;
  let snapshotEpoch = 0;
  let buffered: (() => void)[] | undefined;
  function remove(id: string) { pills.get(id)?.registration.remove(); pills.delete(id); titles.delete(id); }
  function observe(agent: ListedAgent) {
    if (lifetime.signal.aborted) return;
    const workspaceId = agent.workspaceId;
    const parent = (agent as ListedAgent & { parentAgentId?: string | null }).parentAgentId;
    if (!workspaceId || agent.archivedAt || agent.internal || parent || agent.labels?.["paseo.parent-agent-id"] || agent.labels?.["chat-title"] === "helper" || agent.title?.startsWith("[Chat titles]")) { remove(agent.id); return; }
    if (pills.get(agent.id)?.workspaceId === workspaceId) { titles.set(agent.id, agent.title); return; }
    remove(agent.id);
    titles.set(agent.id, agent.title);
    pills.set(agent.id, { workspaceId, registration: registerComposerPill(client, {
      toolId: "auto-rename", agentId: agent.id, workspaceId, glyph: "CaseSensitive",
      button: { title: "Auto rename", label: "Auto rename", icon: "CaseSensitive", behavior: { kind: "popover", Content: createTitlePopover(client, actions, agent.id, titles) } },
    }) });
  }
  type Page = Awaited<ReturnType<typeof client.paseo.agents.list>>;
  function restart(error: unknown, owner: number) {
    if (lifetime.signal.aborted || owner !== epoch) return;
    epoch++; snapshotEpoch++; buffered = undefined;
    unsubscribe?.(); unsubscribe = undefined; connection?.abort();
    console.error("[chat-title] Agent observation failed; retrying", error);
    retry = setTimeout(() => { retry = undefined; void start(); }, 2000);
  }
  async function load(first: Page, owner: number, signal: AbortSignal) {
    const run = ++snapshotEpoch;
    const changes: (() => void)[] = []; buffered = changes;
    const entries = [...first.entries];
    let page = first;
    const cursors = new Set<string>();
    try {
      while (page.pageInfo?.hasMore) {
        const cursor = page.pageInfo.nextCursor;
        if (!cursor || cursors.has(cursor)) throw new Error("The chat directory returned an incomplete or repeated cursor.");
        cursors.add(cursor);
        page = await client.paseo.agents.list({ page: { cursor, limit: 200 }, signal });
        if (signal.aborted || owner !== epoch || run !== snapshotEpoch) return;
        entries.push(...page.entries);
      }
      if (signal.aborted || owner !== epoch || run !== snapshotEpoch) return;
      buffered = undefined;
      const ids = new Set(entries.map(({ agent }) => agent.id));
      for (const id of pills.keys()) if (!ids.has(id)) remove(id);
      for (const { agent } of entries) observe(agent);
      // A late page must not resurrect a chat removed while pagination was in flight.
      for (const apply of changes) apply();
    } catch (error) { if (run === snapshotEpoch) restart(error, owner); }
  }
  async function start() {
    if (lifetime.signal.aborted) return;
    const current = ++epoch;
    const scope = new AbortController(); connection = scope;
    try {
      const { subscription } = await client.paseo.agents.list({ subscribe: {}, signal: scope.signal });
      if (scope.signal.aborted || lifetime.signal.aborted || current !== epoch) return;
      const removeObserver = subscription.subscribe({
        snapshot: (first) => { if (!scope.signal.aborted && current === epoch) void load(first, current, scope.signal); },
        update: (event) => {
          if (scope.signal.aborted || current !== epoch || event.type !== "agent_update") return;
          const payload = event.payload;
          const apply = () => payload.kind === "upsert" ? observe(payload.agent) : remove(payload.agentId);
          if (buffered) buffered.push(apply); else apply();
        },
        error: (error) => restart(error, current),
      });
      if (scope.signal.aborted || current !== epoch) removeObserver();
      else unsubscribe = removeObserver;
    } catch (error) { restart(error, current); }
  }
  void start();
  return () => {
    if (lifetime.signal.aborted) return;
    lifetime.abort();
    epoch++; snapshotEpoch++; buffered = undefined;
    if (retry) clearTimeout(retry);
    connection?.abort();
    unsubscribe?.();
    for (const id of pills.keys()) remove(id);
    titles.clear();
  };
}
