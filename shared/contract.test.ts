import { describe, expect, it } from "vitest";
import { retitleChat, titleJobStatus, titleModels, titleOverview, titleProviders, titleTest } from "./rpc";
import { jobSnapshotSchema, sampleResultSchema } from "./jobs";
import {
  CHARS_MAX,
  CHARS_MIN,
  DEFAULT_MODEL_PREFERENCE,
  WINDOW_MAX,
  WINDOW_MIN,
  autoDefaults,
  chatTitleSettings,
  settingsFallback,
  targetDefaults,
  windowDefaults,
} from "./settings";
import { retitleResultSchema } from "./types";

const schema = chatTitleSettings.schema;

describe("settings contract", () => {
  it("fills every value from nothing", () => {
    expect(schema.parse({})).toEqual(settingsFallback);
  });

  it("starts with the measured window, both targets on and automatic renaming on", () => {
    const values = schema.parse({});
    expect(values.window).toEqual(windowDefaults);
    expect(values.targets).toEqual(targetDefaults);
    expect(values.auto).toEqual(autoDefaults);
    expect(values.model).toEqual({ provider: "", model: "" });
  });

  it("accepts the edges of the window and cap and refuses values outside them", () => {
    expect(schema.parse({ window: { messages: WINDOW_MIN, charsPerMessage: CHARS_MIN } }).window.messages).toBe(WINDOW_MIN);
    expect(schema.parse({ window: { messages: WINDOW_MAX, charsPerMessage: CHARS_MAX } }).window.messages).toBe(WINDOW_MAX);
    expect(() => schema.parse({ window: { messages: WINDOW_MIN - 1 } })).toThrow();
    expect(() => schema.parse({ window: { messages: WINDOW_MAX + 1 } })).toThrow();
    expect(() => schema.parse({ window: { charsPerMessage: CHARS_MIN - 1 } })).toThrow();
    expect(() => schema.parse({ auto: { everyTurns: 0 } })).toThrow();
  });

  it("keeps a chosen model and trims it", () => {
    expect(schema.parse({ model: { provider: " claude ", model: " claude-haiku-5-5 " } }).model).toEqual({ provider: "claude", model: "claude-haiku-5-5" });
  });

  it("prefers the model used day to day, then OpenCode's own copy, then a cheap Claude model", () => {
    expect(DEFAULT_MODEL_PREFERENCE.map((choice) => `${choice.provider}/${choice.model}`)).toEqual([
      "opencode/opencode-go/deepseek-v4.1-flash",
      "opencode/opencode/deepseek-v4.1-flash",
      "claude/claude-haiku-5-5",
    ]);
  });
});

describe("rpc contract", () => {
  const result = { agentId: "a1", status: "renamed", title: "Fix the archive button", previous: "/unlazy tree 5 adjust the archive function", at: "2026-11-13T04:00:00.000Z" };

  it("round-trips a result with per-target outcomes", () => {
    const full = { ...result, chat: { status: "renamed" }, workspace: { status: "skipped", detail: "another chat shares it" }, model: "opencode/opencode-go/deepseek-v4.1-flash", messages: 10 };
    expect(retitleResultSchema.parse(full)).toEqual(full);
    const ack = { kind: "retitle", jobId: "job-1", agentId: "a1" };
    expect(retitleChat.output.parse(ack)).toEqual(ack);
    const terminal = { ...ack, createdAt: result.at, updatedAt: result.at, expiresAt: result.at, state: "succeeded", result: full };
    expect(titleJobStatus.output.parse({ found: true, job: terminal })).toEqual({ found: true, job: terminal });
    expect(() => retitleChat.output.parse(full)).toThrow();
  });

  it("refuses a result with an unknown status or no timestamp", () => {
    expect(() => retitleResultSchema.parse({ ...result, status: "done" })).toThrow();
    expect(() => retitleResultSchema.parse({ agentId: "a1", status: "renamed" })).toThrow();
  });

  it("requires an agent id to retitle and a provider to list models", () => {
    expect(retitleChat.input.parse({ agentId: "a1", force: true })).toEqual({ agentId: "a1", force: true });
    expect(() => retitleChat.input.parse({ agentId: "" })).toThrow();
    expect(() => titleModels.input.parse({ provider: "" })).toThrow();
  });

  it("describes providers, models, the overview and the test result", () => {
    expect(titleProviders.output.parse({ providers: [{ id: "claude", label: "Claude", available: true }, { id: "codex", label: "Codex", available: false, error: "not installed" }] }).providers).toHaveLength(2);
    expect(titleModels.output.parse({ models: [{ id: "claude-haiku-5-5", label: "Haiku 5.5" }] }).models[0]?.id).toBe("claude-haiku-5-5");
    expect(titleOverview.output.parse({ recent: [result], busy: ["a2"], defaultModel: "claude/claude-haiku-5-5" }).busy).toEqual(["a2"]);
    expect(titleTest.output.parse({ jobId: "sample-1", kind: "sample" })).toEqual({ jobId: "sample-1", kind: "sample" });
    expect(sampleResultSchema.parse({ title: "Fix the archive button", model: "claude/claude-haiku-5-5", ms: 1800 }).ms).toBe(1800);
  });

  it("keeps queued/running snapshots result-free and requires typed terminal results or errors", () => {
    const base = { jobId: "job-1", kind: "retitle", agentId: "a1", createdAt: result.at, updatedAt: result.at };
    for (const state of ["queued", "running"]) expect(jobSnapshotSchema.parse({ ...base, state })).toEqual({ ...base, state });
    expect(jobSnapshotSchema.safeParse({ ...base, state: "succeeded", expiresAt: result.at }).success).toBe(false);
    expect(jobSnapshotSchema.safeParse({ ...base, state: "failed", expiresAt: result.at }).success).toBe(false);
    expect(jobSnapshotSchema.safeParse({ ...base, state: "succeeded", expiresAt: result.at, result: { ...result, agentId: "other" } }).success).toBe(false);
    const failed = { ...base, state: "failed", expiresAt: result.at, error: "Model unavailable", result: { ...result, status: "failed", reason: "Model unavailable" } };
    expect(jobSnapshotSchema.parse(failed)).toEqual(failed);
  });

  it("correlates sample terminal data and explicit unknown/restarted responses with opaque IDs", () => {
    const sample = { jobId: "sample-1", kind: "sample", createdAt: result.at, updatedAt: result.at, expiresAt: result.at, state: "succeeded", result: { title: "Sample title", model: "provider/model", ms: 0 } };
    expect(titleJobStatus.output.parse({ found: true, job: sample })).toEqual({ found: true, job: sample });
    expect(jobSnapshotSchema.safeParse({ ...sample, result }).success).toBe(false);
    expect(jobSnapshotSchema.safeParse({ ...sample, result: { ...sample.result, ms: -1 } }).success).toBe(false);
    const missing = { found: false, jobId: "old-1", error: "Unknown or expired job; check Recent outcomes after a restart." };
    expect(titleJobStatus.output.parse(missing)).toEqual(missing);
    expect(titleJobStatus.input.parse({ jobId: "opaque-id" })).toEqual({ jobId: "opaque-id" });
    expect(titleJobStatus.input.safeParse({ jobId: "" }).success).toBe(false);
    expect(titleTest.output.safeParse({ jobId: "sample-1", kind: "retitle" }).success).toBe(false);
  });
});
