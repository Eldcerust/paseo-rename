import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { retitleResultSchema } from "./types";
import { jobStatusSchema, retitleJobAckSchema, sampleJobAckSchema } from "./jobs";

/** Starts an owned background retitle. The acknowledgement is not its generated result. */
export const retitleChat = defineRpc({
  name: "chat-title.retitle",
  input: z.object({ agentId: z.string().min(1), force: z.boolean().optional() }),
  output: retitleJobAckSchema,
});

/** The most recent results and the chats being retitled right now, for the settings screen. */
export const titleOverview = defineRpc({
  name: "chat-title.overview",
  input: z.object({}),
  output: z.object({
    recent: z.array(retitleResultSchema),
    busy: z.array(z.string()),
    /** The `provider/model` used when none is chosen, or undefined when none of the preferences is available. */
    defaultModel: z.string().optional(),
  }),
});

/** The agent providers of the daemon, with whether each can run a helper agent right now. */
export const titleProviders = defineRpc({
  name: "chat-title.providers",
  input: z.object({}),
  output: z.object({
    providers: z.array(z.object({ id: z.string(), label: z.string(), available: z.boolean(), error: z.string().optional() })),
  }),
});

/** The models of one provider. OpenCode lists around a thousand, so the client searches them. */
export const titleModels = defineRpc({
  name: "chat-title.models",
  input: z.object({ provider: z.string().min(1) }),
  output: z.object({ models: z.array(z.object({ id: z.string(), label: z.string() })) }),
});

/** Starts a sample job without holding a plugin RPC open during model generation. */
export const titleTest = defineRpc({
  name: "chat-title.test",
  input: z.object({}),
  output: sampleJobAckSchema,
});

export const titleJobStatus = defineRpc({
  name: "chat-title.job-status",
  input: z.object({ jobId: z.string().min(1).max(200) }),
  output: jobStatusSchema,
});
