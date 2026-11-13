/**
 * The current title of each chat this installation shows a pill for, fed from the agent directory the
 * pills already observe. `null` means the chat is known and has no title; `undefined` means unknown.
 * A store belongs to one registration, so titles can never leak across hosts or plugin reloads.
 */
export function createTitleStore() {
  const titles = new Map<string, string | null>();
  const listeners = new Set<() => void>();
  const emit = () => { for (const listener of [...listeners]) listener(); };
  return {
    get: (agentId: string): string | null | undefined => titles.get(agentId),
    set(agentId: string, title: string | null | undefined) {
      const next = title && title.trim() ? title : null;
      if (titles.has(agentId) && titles.get(agentId) === next) return;
      titles.set(agentId, next);
      emit();
    },
    delete(agentId: string) { if (titles.delete(agentId)) emit(); },
    clear() { if (titles.size === 0) return; titles.clear(); emit(); },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

export type TitleStore = ReturnType<typeof createTitleStore>;
