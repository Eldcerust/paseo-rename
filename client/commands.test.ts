import type { PluginAgentCommandContext, PluginClientContext, PluginClientSlashCommandContribution, PluginCommandCenterItemContribution } from "@getpaseo/plugin/client";
import { describe, expect, it, vi } from "vitest";
import { retitleChat, titleJobStatus } from "../shared/rpc";
import type { RetitleResult } from "../shared/types";
import { commandStore, describeResult, registerCommands } from "./commands";

const result: RetitleResult = { agentId: "current", status: "renamed", title: "Fix workspace archiving", chat: { status: "renamed" }, workspace: { status: "renamed" }, at: new Date(0).toISOString() };
function harness() {
  const slash: PluginClientSlashCommandContribution[] = [];
  const items: PluginCommandCenterItemContribution[] = [];
  const removers = [vi.fn(), vi.fn(), vi.fn()];
  const client = {
    paseo: {},
    addSlashCommand: (item: PluginClientSlashCommandContribution) => { slash.push(item); return removers[0]; },
    addCommandCenterItem: (item: PluginCommandCenterItemContribution) => { items.push(item); return removers[items.length]; },
  } as unknown as PluginClientContext;
  const cleanup = registerCommands(client);
  let outcome = result;
  let agentId = "current";
  const rpc = vi.fn(async (contract, input) => {
    if (contract.name === retitleChat.name) { agentId = input.agentId; return { jobId: "job", kind: "retitle", agentId }; }
    if (contract.name === titleJobStatus.name) return { found: true, job: { jobId: "job", kind: "retitle", agentId, state: "succeeded", result: { ...outcome, agentId } } };
    throw new Error("Unexpected RPC");
  });
  const openScreen = vi.fn(); const openSettings = vi.fn();
  const context = { context: "agent", agent: { id: "current" }, workspace: { id: "workspace" }, rpc, openScreen, openSettings, args: "" } as unknown as PluginAgentCommandContext & { args: string };
  const submit = () => { const command = slash[0]; if (command.context !== "agent") throw new Error("Wrong context"); return command.onSubmit(context); };
  return { slash, items, cleanup, rpc, openScreen, openSettings, context, submit, removers, client, result: (value: RetitleResult) => { outcome = value; } };
}

describe("chat-title client commands", () => {
  it("registers a current-agent slash command and action, plus global settings", () => {
    const h = harness();
    expect(h.slash.map(({ name, context }) => ({ name, context }))).toEqual([{ name: "retitle", context: "agent" }]);
    expect(h.items.map(({ id, context }) => ({ id, context }))).toEqual([{ id: "retitle", context: "agent" }, { id: "settings", context: "global" }]);
  });
  it("calls the real retitle contract with the current agent and manual force", async () => {
    const h = harness(); await h.submit();
    expect(h.rpc).toHaveBeenCalledWith(retitleChat, { agentId: "current", force: true });
    expect(h.openScreen).toHaveBeenCalledWith({ screenId: "titles", params: { agentId: "current" } });
  });
  it("uses the Command Center context, not a cached or globally selected chat", async () => {
    const h = harness(); const item = h.items[0];
    if (item.context !== "agent") throw new Error("Wrong context");
    await item.onSelect({ ...h.context, agent: { ...h.context.agent, id: "another" } });
    expect(h.rpc).toHaveBeenCalledWith(retitleChat, { agentId: "another", force: true });
  });
  it("opens the host settings registration globally without an RPC", async () => {
    const h = harness(); const item = h.items[1];
    if (item.context !== "global") throw new Error("Wrong context");
    await item.onSelect({ ...h.context, context: "global" });
    expect(h.openSettings).toHaveBeenCalledWith("titles"); expect(h.rpc).not.toHaveBeenCalled();
  });
  it("rejects accidental arguments before generating or opening a screen", async () => {
    const h = harness(); h.context.args = "other-agent";
    await expect(h.submit()).rejects.toThrow("without arguments");
    expect(h.rpc).not.toHaveBeenCalled(); expect(h.openScreen).not.toHaveBeenCalled();
  });
  it("prevents duplicate requests and releases pending state after transport failure", async () => {
    const h = harness(); let reject!: (error: Error) => void;
    h.rpc.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const first = h.submit(); await expect(h.submit()).rejects.toThrow("already running");
    expect(commandStore(h.client.paseo).snapshot()?.pending).toBe(true);
    reject(new Error("Host disconnected")); await expect(first).rejects.toThrow("Host disconnected");
    expect(commandStore(h.client.paseo).snapshot()).toMatchObject({ pending: false, message: expect.stringContaining("Host disconnected") });
    expect(commandStore(h.client.paseo).snapshot()?.message).toContain("may still finish");
    await h.submit(); expect(h.rpc).toHaveBeenCalledTimes(3);
  });
  it("makes partial failure actionable instead of reporting unqualified success", async () => {
    const h = harness(); h.result({ ...result, workspace: { status: "failed", detail: "Workspace access denied" } });
    await expect(h.submit()).rejects.toThrow("Workspace: failed (Workspace access denied)");
  });
  it("reports model failures to the host error toast", async () => {
    const h = harness(); h.result({ ...result, status: "failed", reason: "Provider quota exhausted" });
    await expect(h.submit()).rejects.toThrow("Provider quota exhausted");
  });
  it.each(["unchanged", "skipped"] as const)("keeps a %s outcome understandable", async (status) => {
    const h = harness(); h.result({ ...result, status, reason: "No new topic" });
    await h.submit(); expect(describeResult({ ...result, status, reason: "No new topic" })).toContain("No new topic");
  });
  it("removes all registrations once and rejects retained handlers after teardown", async () => {
    const h = harness(); h.cleanup(); h.cleanup();
    h.removers.forEach((remove) => expect(remove).toHaveBeenCalledTimes(1));
    await expect(h.submit()).rejects.toThrow("no longer active"); expect(h.rpc).not.toHaveBeenCalled();
  });
  it("isolates status by host and releases observers on cleanup", async () => {
    const first = harness(); const other = harness(); const listener = vi.fn();
    const store = commandStore(first.client.paseo); const unsubscribe = store.subscribe(listener);
    await first.submit(); expect(store.snapshot()).toMatchObject({ agentId: "current", pending: false });
    expect(commandStore(other.client.paseo).snapshot()).toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(2); unsubscribe(); first.cleanup();
    expect(store.snapshot()).toBeUndefined(); expect(listener).toHaveBeenCalledTimes(2);
  });
});
