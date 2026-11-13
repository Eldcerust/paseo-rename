import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TitleSettingsScreen } from "./settings-screen";
import React, { isValidElement } from "react";
import { settingsFallback } from "../shared/settings";

// Exercise the actual screen's mutation/lifecycle callbacks without claiming native rendering.
const f = vi.hoisted(() => ({ refs: [] as any[], effects: [] as (() => void | (() => void))[], mutation: undefined as any, promise: undefined as any, mutate: vi.fn(), rpc: vi.fn(), saves: vi.fn() }));
vi.mock("react-native", () => ({ Pressable: "Pressable", Text: "Text", View: "View" }));
vi.mock("@getpaseo/plugin/client/ui", () => ({ SettingsAction: "SettingsAction", SettingsCard: "SettingsCard", SettingsRow: "SettingsRow", SettingsSection: "SettingsSection", SettingsSwitch: "SettingsSwitch", TextInput: "TextInput", ScrollView: "ScrollView" }));
vi.mock("@getpaseo/plugin/client", () => ({
  usePaseo: () => ({}), useRpc: (contract: any) => (input: any) => f.rpc(contract.name, input),
  useSettings: () => ({ status: "ready", values: settingsFallback, revision: 1, save: f.saves }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: any) => ({ data: queryKey.includes("providers") ? { providers: [] } : { recent: [], busy: [] }, refetch: vi.fn() }),
  useMutation: (options: any) => {
    f.mutation = options;
    f.mutate.mockImplementation((value) => { f.promise = Promise.resolve().then(() => options.mutationFn(value)); });
    return { mutate: f.mutate, reset: vi.fn(), isPending: false };
  },
}));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(),
  useRef: (value: unknown) => { const ref = { current: value }; f.refs.push(ref); return ref; },
  useEffect: (effect: () => void | (() => void)) => { f.effects.push(effect); },
  useState: (value: unknown) => [value, vi.fn()], useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
vi.mock("./model-picker", () => ({ ModelPicker: () => null }));
vi.mock("./provider-picker", () => ({ ProviderPicker: () => null }));
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function mount() {
  const inner: any = TitleSettingsScreen({ host: { id: "h" }, theme: { colors: {} }, layout: { compact: false } } as any);
  const tree = inner.type(inner.props);
  const cleanups = f.effects.map((effect) => effect()).filter((effect): effect is () => void => typeof effect === "function");
  return { unmount: () => cleanups.reverse().forEach((cleanup) => cleanup()), start: () => { find(tree, "Test saved model").onPress(); return f.promise; }, save: () => find(tree, "Chat title").onValueChange(false) };
}
function find(tree: any, label: string): any {
  if (!isValidElement(tree)) return;
  const props = tree.props as any; if (props.label === label) return props;
  for (const child of React.Children.toArray(props.children)) { const result = find(child, label); if (result) return result; }
}
beforeEach(() => { f.refs = []; f.effects = []; f.mutation = undefined; f.promise = undefined; f.mutate.mockReset(); f.rpc.mockReset(); f.saves.mockReset(); });
afterEach(() => vi.useRealTimers());

describe("saved-model sample screen lifecycle", () => {
  it("keeps the mutation promise pending past acknowledgement until the real sample title arrives", async () => {
    vi.useFakeTimers(); let done = false; let finished = false;
    f.rpc.mockImplementation(async (name) => name === "chat-title.test" ? { jobId: "sample", kind: "sample" } : { found: true, job: { jobId: "sample", kind: "sample", state: finished ? "succeeded" : "running", result: finished ? { title: "Actual sample", model: "p/m", ms: 40_000 } : undefined } });
    const { unmount, start } = mount(); const promise = start().then((value: unknown) => { done = true; return value; });
    await vi.advanceTimersByTimeAsync(35_000); expect(done).toBe(false); finished = true;
    await vi.advanceTimersByTimeAsync(2500); expect(await promise).toEqual({ title: "Actual sample", model: "p/m", ms: 40_000 });
    expect(f.saves).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0); unmount();
  });
  it("throws the actual terminal sample error rather than reporting an acknowledgement as success", async () => {
    f.rpc.mockImplementation(async (name) => name === "chat-title.test" ? { jobId: "sample", kind: "sample" } : { found: true, job: { jobId: "sample", kind: "sample", state: "failed", error: "Model quota exhausted" } });
    const { unmount, start } = mount(); await expect(start()).rejects.toThrow("Model quota exhausted"); unmount();
  });
  it("aborts its own polling on unmount without sending a remote cancellation or writing settings", async () => {
    vi.useFakeTimers(); f.rpc.mockImplementation(async (name) => name === "chat-title.test" ? { jobId: "sample", kind: "sample" } : { found: true, job: { jobId: "sample", kind: "sample", state: "running" } });
    const { unmount, start } = mount(); const promise = start(); const failure = expect(promise).rejects.toThrow("may still finish");
    await tick(); unmount(); await failure; expect(vi.getTimerCount()).toBe(0);
    expect(f.rpc.mock.calls.map(([name]) => name)).toEqual(["chat-title.test", "chat-title.job-status"]); expect(f.saves).not.toHaveBeenCalled();
  });
  it("does not start a mutation scheduled after the settings screen has already unmounted", async () => {
    const { unmount, start } = mount(); const promise = start(); unmount(); await expect(promise).rejects.toThrow("not started"); expect(f.rpc).not.toHaveBeenCalled();
  });
  it("admits only one paid sample on same-tick presses and prevents a concurrent settings save", async () => {
    vi.useFakeTimers(); f.rpc.mockImplementation(async (name) => name === "chat-title.test" ? { jobId: "sample", kind: "sample" } : { found: true, job: { jobId: "sample", kind: "sample", state: "running" } });
    const { unmount, start, save } = mount(); const first = start(); start(); save();
    const failure = expect(first).rejects.toThrow("Stopped waiting"); await tick();
    expect(f.mutate).toHaveBeenCalledTimes(1); expect(f.rpc.mock.calls.filter(([name]) => name === "chat-title.test")).toHaveLength(1); expect(f.saves).not.toHaveBeenCalled();
    unmount(); await failure; expect(vi.getTimerCount()).toBe(0);
  });
  it("does not begin a sample while a settings save has synchronously claimed admission", async () => {
    let resolve!: (value: boolean) => void; f.saves.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const { unmount, start, save } = mount(); save(); start(); expect(f.mutate).not.toHaveBeenCalled(); expect(f.rpc).not.toHaveBeenCalled(); resolve(true); await tick(); unmount();
  });
});
