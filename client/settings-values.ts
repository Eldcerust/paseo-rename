import { chatTitleSettings, type ChatTitleValues } from "../shared/settings";

export function boundedInteger(text: string, min: number, max: number): number | undefined {
  if (!/^\d+$/.test(text.trim())) return undefined;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
}

/** Model clicks produce one complete settings document, never a partially saved provider. */
export function settingsWithModel(values: ChatTitleValues, provider: string, model: string): ChatTitleValues {
  if (!provider.trim() || !model.trim()) throw new Error("Select both a provider and a model.");
  return chatTitleSettings.schema.parse({ ...values, model: { provider, model } });
}
