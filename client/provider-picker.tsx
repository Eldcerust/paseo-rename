import { Pressable, Text, View } from "react-native";
import { useHostLook } from "./host-look";

export interface AgentProvider { id: string; label: string; available: boolean; error?: string }
export function ProviderPicker({ providers, value, disabled, onSelect }: { providers: readonly AgentProvider[]; value: string; disabled: boolean; onSelect(id: string): void }) {
  const { theme } = useHostLook(); const colors = theme.colors;
  return <View accessibilityRole="radiogroup" style={{ padding: 12, gap: 6 }}>
    <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Agent provider</Text>
    {providers.length === 0 ? <Text style={{ color: colors.foregroundMuted }}>This host lists no providers.</Text> : null}
    {providers.map((p) => <Pressable key={p.id} accessibilityRole="radio" accessibilityLabel={`${p.label}${p.available ? "" : `, unavailable: ${p.error ?? "not ready"}`}`} accessibilityState={{ checked: value === p.id, disabled: disabled || !p.available }} disabled={disabled || !p.available} onPress={() => onSelect(p.id)}
      style={{ minHeight: 44, padding: 10, borderRadius: 10, gap: 3, backgroundColor: value === p.id ? colors.accent : colors.surface1, opacity: p.available ? 1 : 0.6 }}>
      <Text style={{ color: value === p.id ? colors.accentForeground : colors.foreground, fontWeight: "600" }}>{p.label}</Text>
      {!p.available ? <Text style={{ color: value === p.id ? colors.accentForeground : colors.foregroundMuted, fontSize: 12 }}>{p.error ?? "Not ready"}</Text> : null}
    </Pressable>)}
  </View>;
}
