import { z } from "zod";

/** A conversational message: one user prompt, or all of one turn's assistant text joined together. */
export interface WindowMessage {
  role: "user" | "assistant";
  text: string;
}

/**
 * The provider and model chosen to write titles. `provider` is a daemon agent provider such as
 * `claude` or `opencode`; `model` is one of that provider's model ids. Both empty means "use the
 * built-in preference" (DEFAULT_MODEL_PREFERENCE in ./settings).
 */
export const modelChoiceSchema = z.object({
  provider: z.string().trim().max(100),
  model: z.string().trim().max(300),
});
export type ModelChoice = z.infer<typeof modelChoiceSchema>;

export const OUTCOME_STATUSES = ["renamed", "unchanged", "skipped", "failed"] as const;
export type OutcomeStatus = (typeof OUTCOME_STATUSES)[number];

/** What happened to one thing that can be renamed: the chat's own title, or its workspace row. */
export const targetOutcomeSchema = z.object({
  status: z.enum(OUTCOME_STATUSES),
  detail: z.string().optional(),
});
export type TargetOutcome = z.infer<typeof targetOutcomeSchema>;

/** `manual` is a person asking (the slash command or Command Center); `auto` is the turn hook. */
export type RetitleSource = "manual" | "auto";

export const retitleResultSchema = z.object({
  agentId: z.string(),
  status: z.enum(OUTCOME_STATUSES),
  /** The title the chat has now, when it was renamed or already had it. */
  title: z.string().optional(),
  /** The title before this run. */
  previous: z.string().nullable().optional(),
  /** Plain-language reason for a skipped or failed run. */
  reason: z.string().optional(),
  chat: targetOutcomeSchema.optional(),
  workspace: targetOutcomeSchema.optional(),
  /** The `provider/model` that wrote the title. */
  model: z.string().optional(),
  /** How many conversational messages the model was shown. */
  messages: z.number().int().nonnegative().optional(),
  at: z.string(),
});
export type RetitleResult = z.infer<typeof retitleResultSchema>;
