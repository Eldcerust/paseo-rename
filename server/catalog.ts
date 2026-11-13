import { DEFAULT_MODEL_PREFERENCE } from "../shared/settings";
import type { ModelChoice } from "../shared/types";

/** The part of the daemon connection the catalog reads. The SDK's `paseo.providers` is assignable to it. */
export interface CatalogSource {
  providers: {
    snapshot(): Promise<{ entries: readonly { provider: string; status: string; enabled?: boolean; label?: string; error?: string }[] }>;
    listModels(provider: string): Promise<{ models?: readonly { id: string; label: string; thinkingOptions?: readonly { id: string }[] }[]; error?: string | null }>;
    listModes(provider: string): Promise<{ modes?: readonly { id: string; label?: string }[]; error?: string | null }>;
  };
}

export interface ProviderInfo {
  id: string;
  label: string;
  available: boolean;
  error?: string;
}

export interface ModelInfo {
  id: string;
  label: string;
  /** The thinking levels the model offers, in the order the daemon lists them. */
  thinking: string[];
}

/** A provider and model that exist right now, with the cheapest thinking level and a read-only mode. */
export interface ResolvedModel {
  provider: string;
  model: string;
  thinking?: string;
  mode?: string;
}

/** `provider/model`, the string the daemon takes as an agent's provider. */
export const agentProviderOf = (choice: { provider: string; model: string }) => `${choice.provider}/${choice.model}`;

const THINKING_ORDER = ["off", "none", "minimal", "low"];

/** The thinking level that costs least: off, none, minimal or low; otherwise the first the model lists. */
export function lowestThinking(levels: readonly string[]): string | undefined {
  for (const wanted of THINKING_ORDER) if (levels.includes(wanted)) return wanted;
  return levels[0];
}

/** A mode in which the agent cannot edit or run anything: `plan` where it exists, else one named like it. */
export function readOnlyMode(modes: readonly { id: string; label?: string }[]): string | undefined {
  const exact = modes.find((mode) => mode.id === "plan");
  if (exact) return exact.id;
  const similar = modes.find((mode) => /plan|read[\s-]?only/i.test(`${mode.id} ${mode.label ?? ""}`));
  return similar?.id;
}

function describeUnavailable(entry: { status: string; enabled?: boolean; error?: string }): string {
  if (entry.error) return entry.error;
  if (entry.enabled === false) return "Not installed, or turned off in Paseo";
  return `Not ready (${entry.status})`;
}

export interface Catalog {
  providers(): Promise<ProviderInfo[]>;
  models(provider: string): Promise<ModelInfo[]>;
  /** Turns a person's choice, or the built-in preference when there is none, into a model that exists now. */
  resolve(choice: ModelChoice): Promise<ResolvedModel>;
  /** The `provider/model` that would be used with no choice made, or undefined when none is available. */
  defaultModel(): Promise<string | undefined>;
}

/**
 * Reads providers and models from the daemon. Listing OpenCode's models returns about a thousand
 * entries, so results are kept for `ttlMs`; the settings screen and every automatic rename would
 * otherwise ask again each time.
 */
export function createCatalog(source: CatalogSource, { ttlMs = 60_000, now = Date.now }: { ttlMs?: number; now?: () => number } = {}): Catalog {
  const cache = new Map<string, { at: number; value: Promise<unknown> }>();
  function remember<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.value as Promise<T>;
    const value = load();
    cache.set(key, { at: now(), value });
    // A failed read must not be remembered.
    value.catch(() => {
      if (cache.get(key)?.value === value) cache.delete(key);
    });
    return value;
  }

  const providers = () =>
    remember("providers", async () => {
      const { entries } = await source.providers.snapshot();
      const infos = entries.map<ProviderInfo>((entry) => {
        const available = entry.status === "ready" && entry.enabled !== false;
        return { id: entry.provider, label: entry.label || entry.provider, available, ...(available ? {} : { error: describeUnavailable(entry) }) };
      });
      return [...infos.filter((info) => info.available), ...infos.filter((info) => !info.available)];
    });

  const detail = (provider: string) =>
    remember(`models:${provider}`, async () => {
      const [models, modes] = await Promise.all([source.providers.listModels(provider), source.providers.listModes(provider)]);
      if (models.error) throw new Error(`Could not list the models of ${provider}: ${models.error}`);
      const list = (models.models ?? []).map<ModelInfo>((model) => ({ id: model.id, label: model.label || model.id, thinking: (model.thinkingOptions ?? []).map((option) => option.id) }));
      if (list.length === 0) throw new Error(`${provider} lists no models. Is it set up and available?`);
      return { models: list, mode: readOnlyMode(modes.modes ?? []) };
    });

  async function resolveOne(choice: ModelChoice): Promise<ResolvedModel> {
    const provider = (await providers()).find((info) => info.id === choice.provider);
    if (!provider) throw new Error(`The provider "${choice.provider}" is not known to this host.`);
    if (!provider.available) throw new Error(`The provider "${provider.label}" is not available: ${provider.error ?? "not ready"}.`);
    const { models, mode } = await detail(choice.provider);
    const model = models.find((entry) => entry.id === choice.model);
    if (!model) throw new Error(`${provider.label} does not offer "${choice.model}" any more.`);
    const thinking = lowestThinking(model.thinking);
    return { provider: choice.provider, model: model.id, ...(thinking ? { thinking } : {}), ...(mode ? { mode } : {}) };
  }

  async function firstPreferred(): Promise<ResolvedModel | undefined> {
    for (const preferred of DEFAULT_MODEL_PREFERENCE) {
      try {
        return await resolveOne(preferred);
      } catch {
        // Not available here: try the next preference.
      }
    }
    return undefined;
  }

  return {
    providers,
    models: async (provider) => (await detail(provider)).models,
    async resolve(choice) {
      const hasProvider = choice.provider.trim() !== "";
      const hasModel = choice.model.trim() !== "";
      if (hasProvider && hasModel) return resolveOne(choice);
      if (hasProvider !== hasModel) throw new Error("Choose both a provider and a model in the Chat titles settings.");
      const preferred = await firstPreferred();
      if (!preferred) throw new Error("None of the built-in models is available on this host. Choose a provider and model in the Chat titles settings.");
      return preferred;
    },
    async defaultModel() {
      const preferred = await firstPreferred();
      return preferred ? agentProviderOf(preferred) : undefined;
    },
  };
}
