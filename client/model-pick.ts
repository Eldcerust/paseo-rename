export interface ModelEntry { id: string; label: string }
export interface ProviderEntry { id: string; count: number }
const OWN_PROVIDERS = ["opencode", "opencode-go"];
export const ROW_LIMIT = 100;

/** OpenCode model ids have a provider prefix; flat catalogs such as Claude's do not. */
export function providerOf(id: string): string {
  const slash = id.indexOf("/");
  return slash > 0 ? id.slice(0, slash) : "other";
}
export function providersOf(all: readonly ModelEntry[]): ProviderEntry[] {
  const counts = new Map<string, number>();
  for (const model of all) { const provider = providerOf(model.id); counts.set(provider, (counts.get(provider) ?? 0) + 1); }
  const rank = (id: string) => { const at = OWN_PROVIDERS.indexOf(id); return at < 0 ? OWN_PROVIDERS.length : at; };
  return [...counts].map(([id, count]) => ({ id, count })).sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}
export function modelsFor(all: readonly ModelEntry[], provider: string | undefined, query: string): ModelEntry[] {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return all.filter((model) => (provider === undefined || providerOf(model.id) === provider) && words.every((word) => `${model.id} ${model.label}`.toLowerCase().includes(word)))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id));
}
export function visibleModels(matches: readonly ModelEntry[], limit = ROW_LIMIT): { rows: ModelEntry[]; hidden: number } {
  const count = Math.max(0, Math.floor(limit));
  return { rows: matches.slice(0, count), hidden: Math.max(0, matches.length - count) };
}
