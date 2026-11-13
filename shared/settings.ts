import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { modelChoiceSchema, type ModelChoice } from "./types";

/** Bounds of the settings a person can change. */
export const WINDOW_MIN = 4;
export const WINDOW_MAX = 40;
export const CHARS_MIN = 200;
export const CHARS_MAX = 4000;
export const EVERY_TURNS_MIN = 1;
export const EVERY_TURNS_MAX = 50;

/**
 * How much of a chat the model sees. Measured on 20 real chats (see the README): the last 10
 * messages hold about 2 user prompts, a title built from them follows a change of topic after 5
 * messages (a 20 message window needs 10), and 600 characters per message keeps the window near
 * 2.3k characters (p90 3.6k).
 */
export const windowDefaults = { messages: 10, charsPerMessage: 600 };
export const targetDefaults = { chat: true, workspace: true };
export const autoDefaults = { enabled: true, everyTurns: 4 };
export const modelDefaults: ModelChoice = { provider: "", model: "" };

/**
 * Used when no model is chosen: the first one whose provider is available and whose model the
 * provider lists. Cheap, fast models, since a title is a few words.
 */
export const DEFAULT_MODEL_PREFERENCE: readonly ModelChoice[] = [
  { provider: "opencode", model: "opencode-go/deepseek-v4.1-flash" },
  { provider: "opencode", model: "opencode/deepseek-v4.1-flash" },
  { provider: "claude", model: "claude-haiku-5-5" },
];

export const chatTitleSettings = defineSettings({
  id: "chat-title",
  scope: "host",
  version: 1,
  schema: z.object({
    model: modelChoiceSchema.default(modelDefaults),
    window: z
      .object({
        messages: z.number().int().min(WINDOW_MIN).max(WINDOW_MAX).default(windowDefaults.messages),
        charsPerMessage: z.number().int().min(CHARS_MIN).max(CHARS_MAX).default(windowDefaults.charsPerMessage),
      })
      .default(windowDefaults),
    targets: z
      .object({
        chat: z.boolean().default(targetDefaults.chat),
        workspace: z.boolean().default(targetDefaults.workspace),
      })
      .default(targetDefaults),
    auto: z
      .object({
        enabled: z.boolean().default(autoDefaults.enabled),
        everyTurns: z.number().int().min(EVERY_TURNS_MIN).max(EVERY_TURNS_MAX).default(autoDefaults.everyTurns),
      })
      .default(autoDefaults),
  }),
});

export type ChatTitleValues = z.output<typeof chatTitleSettings.schema>;

/** The values to use before settings have been read, and when they cannot be. */
export const settingsFallback: ChatTitleValues = {
  model: modelDefaults,
  window: windowDefaults,
  targets: targetDefaults,
  auto: autoDefaults,
};
