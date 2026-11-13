import { z } from "zod";
import { retitleResultSchema } from "./types";

export const sampleResultSchema = z.object({ title: z.string(), model: z.string(), ms: z.number().int().nonnegative() });
const jobId = z.string().min(1).max(200);
export const retitleJobAckSchema = z.object({ jobId, kind: z.literal("retitle"), agentId: z.string().min(1) });
export const sampleJobAckSchema = z.object({ jobId, kind: z.literal("sample") });
export const jobAckSchema = z.discriminatedUnion("kind", [retitleJobAckSchema, sampleJobAckSchema]);
const times = { createdAt: z.string(), updatedAt: z.string() };
const retitleBase = { ...retitleJobAckSchema.shape, ...times };
const sampleBase = { ...sampleJobAckSchema.shape, ...times };
const terminal = { expiresAt: z.string() };
export const retitleJobSchema = z.discriminatedUnion("state", [
  z.object({ ...retitleBase, state: z.literal("queued") }),
  z.object({ ...retitleBase, state: z.literal("running") }),
  z.object({ ...retitleBase, ...terminal, state: z.literal("succeeded"), result: retitleResultSchema }),
  z.object({ ...retitleBase, ...terminal, state: z.literal("failed"), error: z.string().min(1), result: retitleResultSchema.optional() }),
]);
export const sampleJobSchema = z.discriminatedUnion("state", [
  z.object({ ...sampleBase, state: z.literal("queued") }),
  z.object({ ...sampleBase, state: z.literal("running") }),
  z.object({ ...sampleBase, ...terminal, state: z.literal("succeeded"), result: sampleResultSchema }),
  z.object({ ...sampleBase, ...terminal, state: z.literal("failed"), error: z.string().min(1) }),
]);
export const jobSnapshotSchema = z.union([retitleJobSchema, sampleJobSchema]).superRefine((job, context) => {
  if (job.kind === "retitle" && "result" in job && job.result && job.result.agentId !== job.agentId) {
    context.addIssue({ code: "custom", path: ["result", "agentId"], message: "A title job result must belong to the acknowledged chat." });
  }
});
export const jobStatusSchema = z.discriminatedUnion("found", [
  z.object({ found: z.literal(true), job: jobSnapshotSchema }),
  z.object({ found: z.literal(false), jobId, error: z.string().min(1) }),
]);
export type JobAck = z.infer<typeof jobAckSchema>;
export type JobSnapshot = z.infer<typeof jobSnapshotSchema>;
export type JobStatus = z.infer<typeof jobStatusSchema>;
export type SampleResult = z.infer<typeof sampleResultSchema>;
export const isTerminalJob = (job: JobSnapshot) => job.state === "succeeded" || job.state === "failed";
