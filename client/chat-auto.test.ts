import { describe, expect, it } from "vitest";
import { autoQueryKey, describeAutoRow, type ChatAuto } from "./chat-auto";

const data = (extra: Partial<ChatAuto> = {}): ChatAuto => ({ agentId: "a", enabled: false, allowed: true, everyTurns: 4, ...extra });
const row = (input: Partial<Parameters<typeof describeAutoRow>[0]>) => describeAutoRow({ loading: false, ...input });

describe("describeAutoRow", () => {
  it("waits for the first answer with a disabled, busy switch that reads off", () => {
    expect(row({ loading: true })).toEqual({ label: "Rename automatically", hint: "Checking…", checked: false, disabled: true, busy: true });
  });
  it("says it could not read the setting, shows why, and does not let the switch be pressed", () => {
    expect(row({ loadError: "Host offline" })).toEqual({ label: "Rename automatically", hint: "Couldn't read this chat's setting", checked: false, disabled: true, busy: false, problem: "Host offline" });
  });
  it("shows a chat that was never switched on as off and pressable", () => {
    expect(row({ data: data() })).toEqual({ label: "Rename automatically", hint: "Off for this chat", checked: false, disabled: false, busy: false, problem: undefined });
  });
  it("shows an on chat with the host interval, in singular and plural wording", () => {
    expect(row({ data: data({ enabled: true }) })).toMatchObject({ checked: true, disabled: false, hint: "On · every 4 completed turns" });
    expect(row({ data: data({ enabled: true, everyTurns: 2 }) }).hint).toBe("On · every 2 completed turns");
    expect(row({ data: data({ enabled: true, everyTurns: 1 }) }).hint).toBe("On · after each completed turn");
  });
  it("keeps the chat's own choice visible but disabled while the host master switch is off", () => {
    expect(row({ data: data({ allowed: false }) })).toMatchObject({ checked: false, disabled: true, busy: false, hint: "Turned off for all chats in settings" });
    expect(row({ data: data({ allowed: false, enabled: true }) })).toMatchObject({ checked: true, disabled: true });
  });
  it("shows the value being saved at once and refuses a second press", () => {
    expect(row({ data: data(), saving: true, savingValue: true })).toMatchObject({ checked: true, disabled: true, busy: true, hint: "Saving…" });
    expect(row({ data: data({ enabled: true }), saving: true, savingValue: false })).toMatchObject({ checked: false, disabled: true, busy: true });
    expect(row({ data: data({ enabled: true }), saving: true })).toMatchObject({ checked: true });
  });
  it("saving wins over the master switch note, so a press that was already sent is never hidden", () => {
    expect(row({ data: data({ allowed: false }), saving: true, savingValue: true }).hint).toBe("Saving…");
  });
  it("goes back to the saved value after a failed save and shows the problem without disabling the switch", () => {
    expect(row({ data: data({ enabled: true }), saveError: "Disk full" })).toMatchObject({ checked: true, disabled: false, problem: "Disk full", hint: "On · every 4 completed turns" });
    expect(row({ data: data(), saveError: "Disk full" })).toMatchObject({ checked: false, problem: "Disk full" });
  });
  it("keeps showing the last answer while a newer read is loading or has failed", () => {
    expect(row({ data: data({ enabled: true }), loading: true })).toMatchObject({ checked: true, disabled: false });
    expect(row({ data: data({ enabled: true }), loadError: "Host offline" })).toMatchObject({ checked: true, disabled: false, problem: undefined });
  });
});

describe("autoQueryKey", () => {
  it("names the host and the chat", () => {
    expect(autoQueryKey("host-1", "chat-1")).toEqual(["chat-title", "chat-auto", "host-1", "chat-1"]);
    expect(autoQueryKey(undefined, "chat-1")).toEqual(["chat-title", "chat-auto", "", "chat-1"]);
  });
  it("never gives two chats, or two hosts, the same key", () => {
    const keys = [autoQueryKey("h1", "a"), autoQueryKey("h1", "b"), autoQueryKey("h2", "a"), autoQueryKey("h2", "b")].map((key) => JSON.stringify(key));
    expect(new Set(keys).size).toBe(4);
  });
  it("cannot collide with another plugin's query key, which starts with its own name", () => {
    expect(autoQueryKey("h", "a")[0]).toBe("chat-title");
  });
});
