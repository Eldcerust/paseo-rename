import type { PluginButtonContentProps, PluginClientContext } from "@getpaseo/plugin/client";
import { useMutation } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import { commandStore, TITLES_SETTINGS, type RenameActions } from "./commands";

/** Explicit callbacks retain Chat titles ownership even under Pill hub's React providers. */
export function createTitlePopover(client: PluginClientContext, actions: RenameActions, agentId: string) {
  const store = commandStore(client.paseo);
  return function TitlePopover({ theme, layout, close }: PluginButtonContentProps) {
    const current = useSyncExternalStore(store.subscribe, () => store.forAgent(agentId), () => store.forAgent(agentId));
    const rename = useMutation({ mutationFn: () => actions.rename(agentId) });
    const busy = Boolean(current?.pending || rename.isPending);
    const c = theme.colors;
    return <View style={{ padding: layout.compact ? 12 : 8, gap: 12 }}>
      <Text style={{ color: c.foreground, fontWeight: "600" }}>Auto rename</Text>
      <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>Rename this chat from recent messages, or change automatic renaming and its model in settings.</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Rename now" disabled={busy} onPress={() => rename.mutate()} style={{ minHeight: 44, justifyContent: "center", opacity: busy ? 0.5 : 1 }}>
        <Text style={{ color: c.foreground, fontWeight: "600" }}>{busy ? "Writing a title…" : "Rename now"}</Text>
      </Pressable>
      <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Manual rename can replace a custom title.</Text>
      {current || rename.isError ? <Text accessibilityLiveRegion="polite" accessibilityRole={rename.isError && !current?.pending ? "alert" : undefined} style={{ color: c.foreground, fontSize: 13 }}>{current?.message ?? rename.error?.message}</Text> : null}
      <Pressable accessibilityRole="button" accessibilityLabel="Auto-rename settings" onPress={() => { close(); client.openSettings(TITLES_SETTINGS); }} style={{ minHeight: 44, justifyContent: "center" }}>
        <Text style={{ color: c.foreground, fontWeight: "600" }}>Auto-rename settings</Text>
      </Pressable>
    </View>;
  };
}
