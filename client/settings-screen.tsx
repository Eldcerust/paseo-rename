import { usePaseo, useRpc, useSettings, type PluginScreenProps, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSection, SettingsSwitch, TextInput, ScrollView } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import { chatTitleSettings, modelDefaults, WINDOW_MIN, WINDOW_MAX, CHARS_MIN, CHARS_MAX, EVERY_TURNS_MIN, EVERY_TURNS_MAX, type ChatTitleValues } from "../shared/settings";
import { titleJobStatus, titleModels, titleOverview, titleProviders, titleTest } from "../shared/rpc";
import { commandStore, describeResult } from "./commands";
import { HostLookProvider } from "./host-look";
import { ModelPicker } from "./model-picker";
import { ProviderPicker } from "./provider-picker";
import { boundedInteger, settingsWithModel } from "./settings-values";
import { observeJob } from "./jobs";

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

function NumberRow({ label, hint, value, min, max, disabled, color, onSave }: {
  label: string; hint: string; value: number; min: number; max: number; disabled: boolean; color: string; onSave(value: number): Promise<boolean>;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const number = boundedInteger(draft, min, max);
  const changed = draft !== String(value);
  return <SettingsRow label={label} hint={hint} error={number === undefined ? `Enter a whole number from ${min} to ${max}.` : null}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
      <TextInput accessibilityLabel={label} value={draft} onChangeText={setDraft} keyboardType="number-pad" editable={!disabled} style={{ color, minWidth: 72, minHeight: 44, padding: 8 }} />
      <Pressable accessibilityRole="button" accessibilityLabel={`Save ${label.toLowerCase()}`} disabled={disabled || !changed || number === undefined} onPress={() => { if (number !== undefined) void onSave(number); }} style={{ minHeight: 44, justifyContent: "center", opacity: disabled || !changed || number === undefined ? 0.5 : 1 }}>
        <Text style={{ color, fontWeight: "600" }}>Save</Text>
      </Pressable>
    </View>
  </SettingsRow>;
}

export function TitleSettingsScreen(props: PluginSurfaceProps) {
  return <TitleControls key={props.host.id} {...props} />;
}

export function TitleScreen(props: PluginScreenProps) {
  return <ScrollView style={{ flex: 1, backgroundColor: props.theme.colors.surface0 }}><TitleControls key={props.host.id} {...props} agentId={props.params.agentId} /></ScrollView>;
}

function TitleControls({ theme, layout, host, agentId }: PluginSurfaceProps & { agentId?: string }) {
  const store = commandStore(usePaseo());
  const command = useSyncExternalStore(store.subscribe, () => agentId ? store.forAgent(agentId) : store.snapshot(), () => agentId ? store.forAgent(agentId) : store.snapshot());
  const settings = useSettings(chatTitleSettings);
  const getProviders = useRpc(titleProviders);
  const getModels = useRpc(titleModels);
  const getOverview = useRpc(titleOverview);
  const testModel = useRpc(titleTest);
  const getJob = useRpc(titleJobStatus);
  const sampleRun = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; sampleRun.current?.abort(); sampleRun.current = null; };
  }, []);
  const providers = useQuery({ queryKey: ["chat-title", host.id, "providers"], queryFn: () => getProviders({}) });
  const overview = useQuery({ queryKey: ["chat-title", host.id, "overview"], queryFn: () => getOverview({}), refetchInterval: 2500 });
  // Browsing a provider does not write settings. Only selecting a complete model commits a choice.
  const [browsing, setBrowsing] = useState<string | undefined>();
  const provider = browsing ?? (settings.status === "ready" ? settings.values.model.provider : "");
  const models = useQuery({ queryKey: ["chat-title", host.id, "models", provider], queryFn: () => getModels({ provider }), enabled: Boolean(provider) });
  const sample = useMutation({ mutationFn: async (controller: AbortController) => {
    if (!mounted.current || sampleRun.current !== controller || controller.signal.aborted) throw new Error("Chat titles settings is no longer open. The model test was not started.");
    try {
      const job = await observeJob<"sample">(() => testModel({}), getJob, { signal: controller.signal, kind: "sample" });
      if (job.state === "failed") throw new Error(job.error.replace(/Check Recent outcomes before retrying\./i, "Wait for pending jobs to finish before testing the model again."));
      return job.result;
    } finally { if (sampleRun.current === controller) sampleRun.current = null; }
  } });
  const saving = useRef(false);
  function beginSample() {
    if (!mounted.current || sampleRun.current || saving.current || settings.status !== "ready" || settings.saving) return;
    // Claim synchronously at the click, before TanStack schedules mutationFn or React re-renders.
    const controller = new AbortController();
    sampleRun.current = controller;
    sample.mutate(controller);
  }
  const c = theme.colors;
  const text = { color: c.foreground };
  const muted = { color: c.foregroundMuted, fontSize: 13 };
  const padding = layout.compact ? 16 : 24;
  useEffect(() => { setBrowsing(undefined); sample.reset(); }, [host.id]);

  async function save(next: ChatTitleValues) {
    if (settings.status !== "ready" || settings.saving || saving.current || sampleRun.current || sample.isPending) return false;
    saving.current = true;
    try {
      const saved = await settings.save(next, settings.revision);
      if (saved) { sample.reset(); void overview.refetch(); }
      return saved;
    } finally { saving.current = false; }
  }

  if (settings.status === "loading") return <Text style={{ ...text, padding }}>Loading Chat titles settings…</Text>;
  if (settings.status !== "ready") return <View style={{ padding, gap: 12 }}>
    <Text accessibilityRole="alert" style={text}>{settings.error}</Text>
    <SettingsAction label="Read settings again" actionLabel="Retry" onPress={() => void settings.reload()} disabled={settings.saving} />
    {settings.status === "invalid" ? <SettingsAction label="Restore all default settings" hint="Replaces the invalid settings document on this host." actionLabel="Reset settings" onPress={() => void settings.reset()} disabled={settings.saving} /> : null}
    {settings.saveError ? <Text accessibilityRole="alert" style={text}>{settings.saveError}</Text> : null}
  </View>;

  const values = settings.values;
  const recentWindow = values["window"];
  const disabled = settings.saving || sample.isPending;
  const selectedProvider = providers.data?.providers.find((entry) => entry.id === provider);
  const modelLabel = values.model.provider ? `${values.model.provider}/${values.model.model}` : `Built-in preference${overview.data?.defaultModel ? `: ${overview.data.defaultModel}` : overview.isPending ? " (loading availability…)" : overview.isError ? " (availability unavailable)" : " (no preferred model available)"}`;
  const numberProps = { disabled, color: c.foreground };
  const recent = overview.data?.recent ?? [];
  const focused = agentId ? recent.find((result) => result.agentId === agentId) : undefined;
  return <HostLookProvider value={{ theme, layout }}><View style={{ padding, gap: 20 }}>
    {agentId ? <SettingsSection title="Current rename"><SettingsCard>
      <SettingsRow label={command?.agentId === agentId ? command.message : overview.data?.busy.includes(agentId) ? "Writing a title…" : focused ? describeResult(focused) : "No result recorded for this chat yet."} hint="Manual rename can replace a custom title. Results and any partial failures appear here and below." />
    </SettingsCard></SettingsSection> : null}
    <SettingsSection title="Title model"><SettingsCard>
      <SettingsRow label="Saved model" hint={modelLabel} />
      <SettingsAction label="Use built-in model preference" hint="Tries available preferred models, not an arbitrary catalog entry." actionLabel="Reset model" disabled={disabled || !values.model.provider} onPress={() => void save({ ...values, model: { ...modelDefaults } })} />
      {providers.isPending ? <SettingsRow label="Loading providers…" /> : providers.isError ? <SettingsAction label="Could not load providers" hint={errorText(providers.error)} actionLabel="Retry" onPress={() => void providers.refetch()} /> : <ProviderPicker providers={providers.data.providers} value={provider} disabled={disabled} onSelect={setBrowsing} />}
      {provider ? models.isPending ? <SettingsRow label="Loading models…" /> : models.isError ? <SettingsAction label="Could not load models" hint={errorText(models.error)} actionLabel="Retry" onPress={() => void models.refetch()} /> : <ModelPicker key={provider} all={models.data?.models ?? []} value={values.model.provider === provider ? values.model.model : ""} disabled={disabled || selectedProvider?.available !== true} onSelect={(model) => void save(settingsWithModel(values, provider, model))} /> : <SettingsRow label="Choose an agent provider to browse its models" hint="Browsing does not change the saved choice. Select a model to save the provider and model together." />}
      <SettingsAction label="Test saved model" hint="One helper run with a fixed sample conversation; does not rename any chat." actionLabel={sample.isPending ? "Testing…" : "Generate sample title"} disabled={disabled} onPress={beginSample} />
      {sample.isError ? <SettingsRow label="Model test failed" error={errorText(sample.error)} /> : null}
      {sample.data ? <SettingsRow label={sample.data.title} hint={`${sample.data.model} · ${(sample.data.ms / 1000).toFixed(1)} s`} /> : null}
    </SettingsCard></SettingsSection>
    <SettingsSection title="Recent conversation"><SettingsCard>
      <NumberRow {...numberProps} label="Messages" hint="Default: last 10 conversational messages. Tool and reasoning rows do not count." value={recentWindow.messages} min={WINDOW_MIN} max={WINDOW_MAX} onSave={(messages) => save({ ...values, window: { ...recentWindow, messages } })} />
      <NumberRow {...numberProps} label="Characters per message" hint="Default 600. Long messages keep 70% of the beginning and 30% of the end." value={recentWindow.charsPerMessage} min={CHARS_MIN} max={CHARS_MAX} onSave={(charsPerMessage) => save({ ...values, window: { ...recentWindow, charsPerMessage } })} />
    </SettingsCard></SettingsSection>
    <SettingsSection title="Rename targets"><SettingsCard>
      <SettingsSwitch label="Chat title" value={values.targets.chat} disabled={disabled} onValueChange={(chat) => void save({ ...values, targets: { ...values.targets, chat } })} />
      <SettingsSwitch label="Workspace title" hint="Named from every live chat in the workspace; one chat uses its own title." value={values.targets.workspace} disabled={disabled} onValueChange={(workspace) => void save({ ...values, targets: { ...values.targets, workspace } })} />
    </SettingsCard></SettingsSection>
    <SettingsSection title="Automatic renaming"><SettingsCard>
      <SettingsSwitch label="Allow automatic renaming" hint="The master switch. Automatic renaming is off for every chat until you switch it on in that chat's Auto rename tool (in the composer, or under Tools); each chat keeps its own choice. A chat that is on is renamed after its next completed turn, then at the interval below, at least a minute apart. Custom titles are left alone; /retitle can replace them. While this is off, no chat renames itself." value={values.auto.enabled} disabled={disabled} onValueChange={(enabled) => void save({ ...values, auto: { ...values.auto, enabled } })} />
      <NumberRow {...numberProps} label="Completed turns between renames" hint="Default 4. Applies to chats that have automatic renaming switched on. Helper chats and subagents are ignored." value={values.auto.everyTurns} min={EVERY_TURNS_MIN} max={EVERY_TURNS_MAX} onSave={(everyTurns) => save({ ...values, auto: { ...values.auto, everyTurns } })} />
    </SettingsCard></SettingsSection>
    {settings.saving ? <Text accessibilityLiveRegion="polite" style={muted}>Saving settings…</Text> : null}
    {settings.saveError ? <SettingsCard><SettingsRow label="Settings were not saved" error={settings.saveError} hint="Another client may have changed these settings. Reload before retrying your change." /><SettingsAction label="Load current settings" actionLabel="Reload" onPress={() => void settings.reload()} disabled={disabled} /></SettingsCard> : null}
    <SettingsSection title="Recent outcomes"><SettingsCard>
      <SettingsAction label={overview.data?.busy.length ? `${overview.data.busy.length} rename(s) running` : "Latest title changes on this host"} actionLabel="Refresh" onPress={() => void overview.refetch()} disabled={overview.isFetching} />
      {overview.isError ? <SettingsRow label="Could not load outcomes" error={errorText(overview.error)} /> : overview.isPending ? <SettingsRow label="Loading outcomes…" /> : recent.length === 0 ? <SettingsRow label="No outcomes yet" hint="Use /retitle in a chat or wait for a completed turn." /> : recent.map((result, index) => <SettingsRow key={`${result.agentId}-${result.at}-${index}`} label={describeResult(result)} hint={`${result.agentId} · ${new Date(result.at).toLocaleString()}${result.model ? ` · ${result.model}` : ""}${result.messages ? ` · ${result.messages} messages` : ""}`} />)}
    </SettingsCard></SettingsSection>
    <SettingsSection title="Privacy and cost"><SettingsCard><SettingsRow label="Recent message text goes to the chosen model" hint="The current title is sent too. Message text can contain sensitive information. Your provider's account, routing and data policies apply." /><SettingsRow label="Each rename attempt is one helper run" hint="Model tests also use one run. Your provider may charge or consume subscription quota, even if the title is unchanged. A larger window or shorter interval can cost more. Helpers use an empty scratch folder, request text-only replies, deny tool permissions, and are archived with their workspace after each run." /><SettingsRow label="Stored per host" hint="Settings and recent outcomes stay on this daemon. Outcomes include titles, model IDs and chat IDs, not copies of message text. Disabling automatic renaming stops new automatic attempts; manual actions remain available." /></SettingsCard></SettingsSection>
  </View></HostLookProvider>;
}
