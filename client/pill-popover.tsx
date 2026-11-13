import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginButtonContentProps, PluginClientContext } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useMutation } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { commandStore, TITLES_SETTINGS, type CommandState, type RenameActions } from "./commands";
import { describePillStatus, type PillChip, type PillStatus } from "./pill-status";
import { CARD_RADIUS, RADIUS, TOUCH, interaction, statusSurface, toneColor } from "./pill-style";
import type { TitleStore } from "./title-store";

type Colors = PluginTheme["colors"];

// A phone's bottom sheet does not re-anchor when its content grows, so on a compact layout the title and
// status areas keep the height of their largest ordinary content instead of changing with the state.
const STABLE_STATUS = 96;

function Chip({ chip, colors }: { chip: PillChip; colors: Colors }) {
  return <View style={{ flexDirection: "row", alignItems: "center", gap: 6, height: 24, paddingHorizontal: 9, borderRadius: 999, backgroundColor: colors.surface2 }}>
    <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: toneColor(chip.tone, colors) }} />
    <Text style={{ color: colors.foreground, fontSize: 12 }}>{`${chip.label} · ${chip.outcome}`}</Text>
  </View>;
}

/** What the last run did. A finished run gets an icon, a headline, an optional reason and one chip per target. */
function StatusZone({ status, colors, compact }: { status: PillStatus; colors: Colors; compact: boolean }) {
  const spoken = [status.headline, status.detail, ...status.chips.map((chip) => `${chip.label} ${chip.outcome}`)].filter(Boolean).join(". ");
  return <View accessible accessibilityLabel={spoken} accessibilityLiveRegion="polite" accessibilityRole={status.tone === "danger" ? "alert" : undefined}
    style={{ flexDirection: "row", alignItems: "flex-start", gap: 10, padding: 12, minHeight: compact ? STABLE_STATUS : 0, backgroundColor: statusSurface(status.tone, colors) }}>
    <View style={{ width: 20, height: 20, marginTop: 1, alignItems: "center", justifyContent: "center" }}>
      {status.tone === "working" ? <ActivityIndicator size="small" color={colors.foregroundMuted} /> : status.icon ? <Icon name={status.icon} size={18} color={toneColor(status.tone, colors)} /> : null}
    </View>
    <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
        <Text style={{ flexShrink: 1, color: colors.foreground, fontSize: 14, lineHeight: 20, fontWeight: "600" }}>{status.headline}</Text>
        {status.when ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{status.when}</Text> : null}
      </View>
      {status.detail ? <Text numberOfLines={3} selectable={status.tone === "danger"} style={{ color: colors.foreground, fontSize: 13, lineHeight: 18 }}>{status.detail}</Text> : null}
      {status.chips.length > 0 ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 2 }}>
        {status.chips.map((chip) => <Chip key={chip.key} chip={chip} colors={colors} />)}
      </View> : null}
    </View>
  </View>;
}

/** The chat being renamed, with its live title, above the status of the last run. */
function TitleCard({ title, status, colors, compact }: { title: string | null | undefined; status: PillStatus; colors: Colors; compact: boolean }) {
  return <View style={{ borderRadius: CARD_RADIUS, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1, overflow: "hidden" }}>
    <View style={{ padding: 14, gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Icon name="MessageSquareText" size={13} color={colors.foregroundMuted} />
        <Text style={{ color: colors.foregroundMuted, fontSize: 11, fontWeight: "600", letterSpacing: 0.8 }}>THIS CHAT</Text>
      </View>
      <Text numberOfLines={2} style={{ minHeight: compact ? 44 : 0, color: title ? colors.foreground : colors.foregroundMuted, fontSize: 16, lineHeight: 22, fontWeight: "600" }}>{title || "Untitled chat"}</Text>
    </View>
    <View style={{ height: 1, backgroundColor: colors.border }} />
    <StatusZone status={status} colors={colors} compact={compact} />
  </View>;
}

/** The popover Pill hub shows under Tools, or the standalone Auto rename pill when no hub merges it. */
export function createTitlePopover(client: PluginClientContext, actions: RenameActions, agentId: string, titles: TitleStore) {
  const store = commandStore(client.paseo);
  // Explicit callbacks keep Chat titles ownership even when Pill hub's React providers wrap this content,
  // so the only hooks here read this plugin's own stores and the shared query client.
  return function TitlePopover({ theme, layout, close }: PluginButtonContentProps) {
    const current = useSyncExternalStore(store.subscribe, () => store.forAgent(agentId), () => store.forAgent(agentId));
    const title = useSyncExternalStore(titles.subscribe, () => titles.get(agentId), () => titles.get(agentId));
    const rename = useMutation({ mutationFn: () => actions.rename(agentId) });
    const busy = Boolean(current?.pending || rename.isPending);
    const c = theme.colors;
    // A failure raised before a run starts (a duplicate request, a plugin shutting down) never reaches the store.
    const failure: CommandState | undefined = rename.isError ? { agentId, pending: false, failed: true, message: rename.error?.message ?? "Could not start the rename." } : undefined;
    const status = describePillStatus(busy ? { agentId, pending: true, message: "" } : current ?? failure);
    return <View style={{ gap: 12, padding: layout.compact ? 8 : 4 }}>
      <TitleCard title={title} status={status} colors={c} compact={layout.compact} />
      <Pressable accessibilityRole="button" accessibilityLabel="Rename now" accessibilityState={{ busy, disabled: busy }} disabled={busy} onPress={() => rename.mutate()}
        style={(state) => ({ minHeight: TOUCH + 2, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingHorizontal: 16, borderRadius: RADIUS, backgroundColor: c.accent, opacity: busy ? 0.6 : interaction(state as { pressed: boolean; hovered?: boolean }) })}>
        {busy ? <ActivityIndicator size="small" color={c.accentForeground} /> : <Icon name="Sparkles" size={16} color={c.accentForeground} />}
        <Text style={{ color: c.accentForeground, fontSize: 15, fontWeight: "600" }}>{busy ? "Renaming…" : "Rename now"}</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Auto-rename settings" onPress={() => { close(); client.openSettings(TITLES_SETTINGS); }}
        style={(state) => {
          const { pressed, hovered } = state as { pressed: boolean; hovered?: boolean };
          return { minHeight: TOUCH + 8, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 12, paddingVertical: 8, borderRadius: RADIUS, borderWidth: 1, borderColor: c.border, backgroundColor: pressed ? c.surface2 : hovered ? c.surface1 : "transparent" };
        }}>
        <View style={{ width: 32, height: 32, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: c.surface2 }}>
          <Icon name="Settings2" size={16} color={c.foreground} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
          <Text numberOfLines={1} style={{ color: c.foreground, fontSize: 14, fontWeight: "600" }}>Auto-rename settings</Text>
          <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 12 }}>Model, interval and what gets renamed</Text>
        </View>
        <Icon name="ChevronRight" size={16} color={c.foregroundMuted} />
      </Pressable>
    </View>;
  };
}
