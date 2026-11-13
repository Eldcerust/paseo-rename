import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { settingsFallback } from "../shared/settings";
import { createAuto, type TurnEvent } from "./auto";
import { HELPER_TITLE } from "./llm";
import { createRetitler, type RetitleDaemon } from "./retitle";
import { createStateStore } from "./state";

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { force: true, recursive: true }); });
function setup(title: string | null = null) {
  const folder = mkdtempSync(join(tmpdir(), "chat-title-triggers-")); folders.push(folder);
  const state = createStateStore(join(folder, "state.json"));
  let calls = 0;
  const daemon: RetitleDaemon = {
    providers: {
      snapshot: async () => ({ entries: [{ provider: "claude", status: "ready" }] }),
      listModels: async () => ({ models: [{ id: "claude-haiku-5-5", label: "Haiku" }] }),
      listModes: async () => ({ modes: [] }),
    },
    agents: {
      create: async () => { throw new Error("model injected"); },
      list: async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null } }),
      ref: (id) => ({ refresh: async () => ({ agent: { id, title, workspaceId: null } }), timeline: { refetch: async () => ({ entries: [{ item: { type: "user_message", text: "Design a model picker" } }], hasOlder: false, startCursor: null }) } }),
    },
    workspaces: { archive: async () => ({}), ref: () => ({ refresh: async () => null, setTitle: async (title) => ({ title }) }) },
  };
  const retitler = createRetitler({ settings: async () => settingsFallback, state, runModel: async () => { calls++; return "Design a model picker"; }, setChatTitle: async (_, next) => { title = next; } });
  const auto = createAuto({ settings: async () => settingsFallback, state, retitler, debounceMs: 0 });
  const event: TurnEvent = { agent: { id: "chat", workspaceId: null, parentAgentId: null, cwd: folder, title }, outcome: { kind: "completed" } };
  return { auto, retitler, daemon, state, event, calls: () => calls, title: () => title };
}
describe("turns through the real retitle service", () => {
  it("a completed turn writes and remembers a title", async () => { const w = setup(); await w.auto.onTurnEnded(w.event, w.daemon); await w.auto.idle(); expect(w.title()).toBe("Design a model picker"); expect(await w.state.get("chat")).toMatchObject({ title: w.title(), turns: 0, attemptedAt: expect.any(String) }); });
  it("a helper's turn never calls the model again", async () => { const w = setup(HELPER_TITLE); await w.auto.onTurnEnded(w.event, w.daemon); await w.auto.idle(); expect(w.calls()).toBe(0); });
  it("a subagent's turn does not rename", async () => { const w = setup(); w.event.agent.parentAgentId = "parent"; await w.auto.onTurnEnded(w.event, w.daemon); await w.auto.idle(); expect(w.calls()).toBe(0); });
  it("automatic mode leaves a user-named chat untouched", async () => { const w = setup("My chosen title"); await w.auto.onTurnEnded(w.event, w.daemon); await w.auto.idle(); expect(w.title()).toBe("My chosen title"); expect(w.calls()).toBe(0); });
  it("a manual request overrides a user-named chat", async () => { const w = setup("My chosen title"); expect(await w.retitler.retitle(w.daemon, { agentId: "chat", source: "manual", force: true })).toMatchObject({ status: "renamed" }); expect(w.title()).toBe("Design a model picker"); });
});
