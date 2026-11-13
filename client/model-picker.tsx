import { Icon, ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, Text, View, type ScrollView as NativeScrollView } from "react-native";
import { useHostLook } from "./host-look";
import { modelsFor, providerOf, providersOf, ROW_LIMIT, visibleModels, type ModelEntry } from "./model-pick";

function Row({ selected, disabled, label, onPress, children }: { selected: boolean; disabled?: boolean; label: string; onPress(): void; children(color: string, muted: string): ReactNode }) {
  const { theme } = useHostLook(); const c = theme.colors;
  return <Pressable accessibilityRole="radio" accessibilityLabel={label} accessibilityState={{ checked: selected, disabled: Boolean(disabled) }} disabled={disabled} onPress={onPress}
    style={{ minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8, padding: 10, borderRadius: 10, backgroundColor: selected ? c.accent : c.surface1, opacity: disabled ? 0.6 : 1 }}>
    {children(selected ? c.accentForeground : c.foreground, selected ? c.accentForeground : c.foregroundMuted)}
  </Pressable>;
}

/** Same bounded, searchable two-column model picker as Pill hub; flat catalogs need no group column. */
export function ModelPicker({ all, value, disabled, onSelect }: { all: readonly ModelEntry[]; value: string; disabled: boolean; onSelect(id: string): void }) {
  const { theme, layout } = useHostLook(); const c = theme.colors;
  const groups = useMemo(() => providersOf(all), [all]);
  const grouped = groups.some((group) => group.id !== "other");
  const [provider, setProvider] = useState<string | undefined>(() => value ? providerOf(value) : undefined);
  const [query, setQuery] = useState("");
  const matches = useMemo(() => modelsFor(all, provider, query), [all, provider, query]);
  const { rows, hidden } = visibleModels(matches);
  const list = useRef<NativeScrollView>(null);
  useEffect(() => { setProvider(value && groups.some((group) => group.id === providerOf(value)) ? providerOf(value) : undefined); }, [value, groups]);
  useEffect(() => { list.current?.scrollTo({ y: 0, animated: false }); }, [provider, query]);
  return <View style={{ padding: 12, gap: 10 }}>
    <View style={{ flexDirection: "row", alignItems: "center", minHeight: 44, gap: 8, paddingHorizontal: 12, borderRadius: 10, backgroundColor: c.surface1 }}>
      <Icon name="Search" size={16} color={c.foregroundMuted} />
      <TextInput accessibilityLabel="Search models" placeholder="Search models" placeholderTextColor={c.foregroundMuted} value={query} onChangeText={setQuery} autoCapitalize="none" autoCorrect={false} style={{ flex: 1, minWidth: 0, color: c.foreground, fontSize: 14 }} />
      {query ? <Pressable accessibilityRole="button" accessibilityLabel="Clear model search" hitSlop={8} onPress={() => setQuery("")}><Icon name="X" size={16} color={c.foregroundMuted} /></Pressable> : null}
    </View>
    <View style={{ flexDirection: "row", gap: 8, height: 300 }}>
      {grouped ? <ScrollView nestedScrollEnabled style={{ width: layout.compact ? 108 : 164 }}><View accessibilityRole="radiogroup" style={{ gap: 4 }}>
        {[{ id: undefined, label: "All providers", count: all.length }, ...groups.map((g) => ({ ...g, id: g.id as string | undefined, label: g.id === "other" ? "Other" : g.id }))].map((g) =>
          <Row key={g.id ?? "*"} selected={provider === g.id} label={`${g.label}, ${g.count} models`} onPress={() => setProvider(g.id)}>{(color, muted) => <View style={{ flex: 1, minWidth: 0, gap: 2 }}><Text style={{ color, fontSize: 13, fontWeight: "600" }}>{g.label}</Text><Text style={{ color: muted, fontSize: 12 }}>{g.count}</Text></View>}</Row>)}
      </View></ScrollView> : null}
      <ScrollView ref={list} nestedScrollEnabled style={{ flex: 1, minWidth: 0 }}><View accessibilityRole="radiogroup" style={{ gap: 4 }}>
        {rows.map((m) => <Row key={m.id} label={`${m.label}, ${m.id}`} selected={m.id === value} disabled={disabled} onPress={() => onSelect(m.id)}>{(color, muted) => <><View style={{ flex: 1, minWidth: 0, gap: 2 }}><Text style={{ color, fontSize: 14, fontWeight: "600" }}>{m.label}</Text><Text style={{ color: muted, fontSize: 12 }}>{m.id}</Text></View>{m.id === value ? <Icon name="Check" size={16} color={color} /> : null}</>}</Row>)}
        {rows.length === 0 ? <Text style={{ color: c.foregroundMuted, padding: 8 }}>No models match. Try another search or provider.</Text> : null}
      </View></ScrollView>
    </View>
    <Text accessibilityLiveRegion="polite" style={{ color: c.foregroundMuted, fontSize: 12 }}>{matches.length} models{hidden ? `. Showing the first ${ROW_LIMIT}; search to narrow the list.` : "."}</Text>
  </View>;
}
