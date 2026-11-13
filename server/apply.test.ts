import { describe, expect, it } from "vitest";
import { applyChatTitle, type ApplyChatInput, type ApplyChatPaseo } from "./apply";

interface Options {
  chatTitle?: string | null;
  cliFails?: boolean;
  cliNoEffect?: boolean;
  refreshFails?: boolean;
}

function fake(options: Options = {}) {
  const state = { chat: options.chatTitle ?? "old chat title" };
  const log = { cli: [] as [string, string][] };
  const paseo: ApplyChatPaseo = {
    agents: {
      ref: () => ({
        refresh: async () => {
          if (options.refreshFails) throw new Error("daemon unreachable");
          return { agent: { title: state.chat } };
        },
      }),
    },
  };
  const setChatTitle = async (agentId: string, title: string) => {
    log.cli.push([agentId, title]);
    if (options.cliFails) throw new Error("The Paseo command failed: agent not found");
    if (!options.cliNoEffect) state.chat = title;
  };
  return { deps: { paseo, setChatTitle }, log, state };
}

const input = (overrides: Partial<ApplyChatInput> = {}): ApplyChatInput => ({
  agentId: "me",
  title: "Rename chats from recent messages",
  currentChatTitle: "old chat title",
  enabled: true,
  ...overrides,
});

describe("applyChatTitle", () => {
  it("writes the title and verifies the daemon shows it", async () => {
    const { deps, log, state } = fake();
    expect(await applyChatTitle(deps, input())).toEqual({ status: "renamed" });
    expect(log.cli).toEqual([["me", "Rename chats from recent messages"]]);
    expect(state.chat).toBe("Rename chats from recent messages");
  });

  it("does not run the command when the chat already has the title", async () => {
    const { deps, log } = fake();
    expect(await applyChatTitle(deps, input({ currentChatTitle: "Rename chats from recent messages" }))).toEqual({ status: "unchanged" });
    expect(log.cli).toEqual([]);
  });

  it("leaves the chat alone when its target is off", async () => {
    const { deps, log } = fake();
    expect(await applyChatTitle(deps, input({ enabled: false }))).toEqual({ status: "skipped", detail: "Turned off in the settings." });
    expect(log.cli).toEqual([]);
  });

  it("does not start a write when already cancelled", async () => {
    const { deps, log, state } = fake();
    const controller = new AbortController();
    controller.abort();
    expect(await applyChatTitle(deps, input({ signal: controller.signal }))).toEqual({ status: "skipped", detail: "The rename was cancelled." });
    expect(log.cli).toEqual([]);
    expect(state.chat).toBe("old chat title");
  });

  it("reports a failed command without throwing", async () => {
    const { deps } = fake({ cliFails: true });
    expect(await applyChatTitle(deps, input())).toEqual({ status: "failed", detail: "The Paseo command failed: agent not found" });
  });

  it("reports a command that the daemon does not reflect as failed", async () => {
    const { deps } = fake({ cliNoEffect: true });
    expect(await applyChatTitle(deps, input())).toEqual({ status: "failed", detail: "The command finished, but the daemon does not show the new title." });
  });

  it("reports an unreadable chat as failed", async () => {
    const { deps } = fake({ refreshFails: true });
    expect(await applyChatTitle(deps, input())).toEqual({ status: "failed", detail: "daemon unreachable" });
  });
});
