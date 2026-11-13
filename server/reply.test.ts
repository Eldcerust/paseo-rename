import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { settingsFallback } from "../shared/settings";
import type { HelperAgent } from "./llm";
import { createRetitler, type RetitleDaemon } from "./retitle";
import { createStateStore } from "./state";

/**
 * The real retitle service with the real runner (only the daemon and the title write are faked), given a helper whose
 * timeline is the one recorded from the real failure: the title first, then a second message answering a plan-mode
 * reminder, which the daemon reported as the helper's last message.
 */
const TITLE = "Polish Auto rename popover UI and per-chat toggle";
const SPURIOUS = "I'm in Plan mode and there's no new request to work on. Tell me what you'd like planned and I'll walk through the approach here.";
const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

function setup(rows: { type: string; text?: string }[], lastMessage: string | null, initialTitle: string | null = "[Switch] You are taking over a task from another coding agen") {
  const folder = mkdtempSync(join(tmpdir(), "chat-title-reply-")); folders.push(folder);
  const written: string[] = [];
  const helper: HelperAgent = {
    id: "helper", workspaceId: "helper-workspace", pendingPermissions: [],
    refresh: async () => ({}), respondToPermission: async () => {},
    waitForFinish: async () => ({ status: "idle", lastMessage }),
    archive: async () => {},
    timeline: { refetch: async () => ({ entries: rows.map((item) => ({ item })) }) },
  };
  let title: string | null = initialTitle;
  const daemon: RetitleDaemon = {
    providers: {
      snapshot: async () => ({ entries: [{ provider: "opencode", status: "ready", enabled: true }] }),
      listModels: async () => ({ models: [{ id: "opencode-go/deepseek-v4.1-flash", label: "Flash" }] }),
      listModes: async () => ({ modes: [{ id: "plan" }] }),
    },
    agents: {
      create: async () => helper,
      list: async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null } }),
      ref: (id) => ({
        refresh: async () => ({ agent: { id, title, workspaceId: null } }),
        timeline: { refetch: async () => ({ entries: [{ item: { type: "user_message", text: "Design the Auto rename popover" } }], hasOlder: false, startCursor: null }) },
      }),
    },
    workspaces: { archive: async () => ({}), ref: () => ({ refresh: async () => null, setTitle: async (next) => ({ title: next }) }) },
  };
  const retitler = createRetitler({
    settings: async () => settingsFallback, state: createStateStore(join(folder, "state.json")), scratchRoot: folder,
    setChatTitle: async (_id, next) => { title = next; written.push(next); },
  });
  return { retitler, daemon, written, title: () => title };
}
const recorded = [{ type: "notification" }, { type: "user_message", text: "the prompt" }, { type: "reasoning", text: "thinking about the popover" }, { type: "assistant_message", text: TITLE }, { type: "reasoning", text: "the user message is just a system reminder about Plan mode" }, { type: "assistant_message", text: SPURIOUS }];

describe("the title written is the helper's reply to the prompt", () => {
  it("writes the real title even though the helper spoke again and the daemon called that its last message", async () => {
    const w = setup(recorded, SPURIOUS);
    expect(await w.retitler.retitle(w.daemon, { agentId: "chat", source: "manual", force: true })).toMatchObject({ status: "renamed", title: TITLE });
    expect(w.written).toEqual([TITLE]);
  });
  it("writes the real title for an automatic rename too, on a chat that has no title of its own", async () => {
    const w = setup(recorded, SPURIOUS, null);
    expect(await w.retitler.retitle(w.daemon, { agentId: "chat", source: "auto" })).toMatchObject({ status: "renamed", title: TITLE });
  });
  it("never writes an assistant answer as a title: when that is all there is, the rename fails and the title stays", async () => {
    const w = setup([{ type: "user_message", text: "the prompt" }, { type: "assistant_message", text: SPURIOUS }], SPURIOUS);
    const result = await w.retitler.retitle(w.daemon, { agentId: "chat", source: "manual", force: true });
    expect(result).toMatchObject({ status: "failed", reason: expect.stringContaining("could not be used as a title") });
    expect(w.written).toEqual([]); expect(w.title()).toBe("[Switch] You are taking over a task from another coding agen");
  });
  it("still writes the title of an ordinary single-message reply", async () => {
    const w = setup([{ type: "user_message", text: "the prompt" }, { type: "assistant_message", text: "Fix the archive button" }], "Fix the archive button");
    expect(await w.retitler.retitle(w.daemon, { agentId: "chat", source: "manual", force: true })).toMatchObject({ status: "renamed", title: "Fix the archive button" });
  });
  it("uses the model test's sample the same way", async () => {
    const w = setup(recorded, SPURIOUS);
    expect(await w.retitler.test(w.daemon, {})).toMatchObject({ title: TITLE });
  });
});
