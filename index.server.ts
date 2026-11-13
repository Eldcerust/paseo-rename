import type { PluginServerContext } from "@getpaseo/plugin/server";
import { chatTitleSettings } from "./shared/settings";
import { retitleChat, setTitleChatAuto, titleChatAuto, titleJobStatus, titleModels, titleOverview, titleProviders, titleTest } from "./shared/rpc";
import { createAuto } from "./server/auto";
import { createRetitler } from "./server/retitle";
import { createStateStore, statePath } from "./server/state";
import { createJobs } from "./server/jobs";

export default function contribute(server: PluginServerContext) {
  const document = server.registerSettings(chatTitleSettings);
  const settings = async () => {
    const state = await document.read();
    if (state.status !== "ready") throw new Error("Chat titles settings could not be read. Open the plugin settings to repair them.");
    return state.values;
  };
  const state = createStateStore(statePath());
  const retitler = createRetitler({ settings, state });
  const auto = createAuto({ settings, state, retitler });
  const jobs = createJobs();
  const active = new Set<Promise<unknown>>();
  let disposed = false;
  let cleanup: Promise<void> | undefined;
  function admit<T>(start: () => Promise<T>): Promise<T> {
    if (disposed) return Promise.reject(new Error("Chat titles is stopping. Try again after the plugin is active."));
    // Register before running the callback, including synchronously re-entrant teardown.
    const request = Promise.resolve().then(start);
    active.add(request);
    request.then(() => active.delete(request), () => active.delete(request));
    return request;
  }
  server.handle(retitleChat, (input, { paseo }) => admit(async () => jobs.startRetitle(input.agentId, (signal) => retitler.retitle(paseo, { ...input, source: "manual", signal }))));
  server.handle(titleOverview, (_input, { paseo }) => admit(() => retitler.overview(paseo)));
  server.handle(titleProviders, (_input, { paseo }) => admit(async () => ({ providers: await retitler.catalog(paseo).providers() })));
  server.handle(titleModels, ({ provider }, { paseo }) => admit(async () => ({ models: await retitler.catalog(paseo).models(provider) })));
  server.handle(titleTest, (_input, { paseo }) => admit(async () => jobs.startSample((signal) => retitler.test(paseo, { signal }))));
  // Every chat starts with automatic renaming off. The answer also carries the host's master switch, so a client can say
  // why a chat's own switch has no effect. Settings are read first, so an unreadable document fails before anything is saved.
  const chatAuto = async (agentId: string) => {
    const values = await settings();
    return { agentId, enabled: await state.chatAuto(agentId), allowed: values.auto.enabled, everyTurns: values.auto.everyTurns };
  };
  server.handle(titleChatAuto, ({ agentId }) => admit(() => chatAuto(agentId)));
  server.handle(setTitleChatAuto, ({ agentId, enabled }) => admit(async () => { await settings(); await state.setChatAuto(agentId, enabled); return chatAuto(agentId); }));
  server.handle(titleJobStatus, ({ jobId }) => admit(async () => jobs.status(jobId)));
  const unhook = server.addHook("agent.turn.after", (event, { paseo }) => disposed ? Promise.resolve() : admit(() => auto.onTurnEnded(event, paseo)));
  // RPC registrations belong to the plugin session; Paseo removes them after this cleanup.
  return () => {
    if (cleanup) return cleanup;
    disposed = true;
    // Install the same drain promise before abort listeners can re-enter cleanup.
    cleanup = Promise.resolve().then(async () => {
      try { unhook(); }
      finally { await Promise.all([jobs.idle(), auto.idle(), Promise.allSettled([...active])]); }
    });
    jobs.stop();
    auto.stop();
    return cleanup;
  };
}
