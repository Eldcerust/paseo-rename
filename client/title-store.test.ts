import { describe, expect, it, vi } from "vitest";
import { createTitleStore } from "./title-store";

describe("title store", () => {
  it("tells a chat with no title apart from an unknown chat", () => {
    const store = createTitleStore();
    store.set("a", null); store.set("b", "   ");
    expect(store.get("a")).toBeNull(); expect(store.get("b")).toBeNull(); expect(store.get("never-seen")).toBeUndefined();
  });
  it("notifies once per real change and not for a repeat", () => {
    const store = createTitleStore(); const listener = vi.fn(); store.subscribe(listener);
    store.set("a", "First"); store.set("a", "First"); expect(listener).toHaveBeenCalledTimes(1);
    store.set("a", "Second"); expect(listener).toHaveBeenCalledTimes(2); expect(store.get("a")).toBe("Second");
  });
  it("stops notifying an unsubscribed listener and tolerates a listener that unsubscribes while notified", () => {
    const store = createTitleStore(); const first = vi.fn(); const second = vi.fn();
    const stop = store.subscribe(() => { first(); stop(); }); store.subscribe(second);
    store.set("a", "One"); store.set("a", "Two");
    expect(first).toHaveBeenCalledTimes(1); expect(second).toHaveBeenCalledTimes(2);
  });
  it("forgets a deleted chat and stays quiet when the chat was never there", () => {
    const store = createTitleStore(); const listener = vi.fn(); store.set("a", "Kept"); store.subscribe(listener);
    store.delete("missing"); expect(listener).not.toHaveBeenCalled();
    store.delete("a"); expect(store.get("a")).toBeUndefined(); expect(listener).toHaveBeenCalledTimes(1);
  });
  it("clears everything with one notification, and none when it was already empty", () => {
    const store = createTitleStore(); const listener = vi.fn(); store.subscribe(listener); store.clear(); expect(listener).not.toHaveBeenCalled();
    store.set("a", "A"); store.set("b", "B"); listener.mockClear(); store.clear();
    expect(listener).toHaveBeenCalledTimes(1); expect(store.get("a")).toBeUndefined(); expect(store.get("b")).toBeUndefined();
  });
  it("keeps stores independent of each other", () => {
    const one = createTitleStore(); const two = createTitleStore(); one.set("a", "Mine");
    expect(two.get("a")).toBeUndefined();
  });
});
