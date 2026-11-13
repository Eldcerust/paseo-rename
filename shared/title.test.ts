import { describe, expect, it } from "vitest";
import { PROVISIONAL_TITLE_CHARS, TITLE_MAX_CHARS, isAutoTitle, isUsableTitle, provisionalTitle, sanitizeTitle } from "./title";

describe("sanitizeTitle", () => {
  it("keeps a clean title as it is", () => {
    expect(sanitizeTitle("Fix archive button in the exporter")).toBe("Fix archive button in the exporter");
  });

  it("strips straight, curly and backtick quotes around the title", () => {
    expect(sanitizeTitle('"Fix the archive button"')).toBe("Fix the archive button");
    expect(sanitizeTitle("“Fix the archive button”")).toBe("Fix the archive button");
    expect(sanitizeTitle("`Fix the archive button`")).toBe("Fix the archive button");
    expect(sanitizeTitle("'\"Fix the archive button\"'")).toBe("Fix the archive button");
  });

  it("strips markdown emphasis, headings, bullets and numbering", () => {
    expect(sanitizeTitle("**Fix the archive button**")).toBe("Fix the archive button");
    expect(sanitizeTitle("# Fix the archive button")).toBe("Fix the archive button");
    expect(sanitizeTitle("- Fix the archive button")).toBe("Fix the archive button");
    expect(sanitizeTitle("1. Fix the archive button")).toBe("Fix the archive button");
  });

  it("keeps a title that merely starts with a digit", () => {
    expect(sanitizeTitle("2FA setup for the relay")).toBe("2FA setup for the relay");
  });

  it("drops a Title: label in any case", () => {
    expect(sanitizeTitle("Title: Fix the archive button")).toBe("Fix the archive button");
    expect(sanitizeTitle("chat title - Fix the archive button")).toBe("Fix the archive button");
    expect(sanitizeTitle("TITLE: **Fix the archive button**")).toBe("Fix the archive button");
  });

  it("takes the first line and ignores an explanation after it", () => {
    expect(sanitizeTitle("Fix the archive button\n\nThis title covers the archive discussion.")).toBe("Fix the archive button");
  });

  it("skips a lead-in line that ends with a colon", () => {
    expect(sanitizeTitle("Here is the title:\nFix the archive button")).toBe("Fix the archive button");
    expect(sanitizeTitle("Title:\nFix the archive button")).toBe("Fix the archive button");
  });

  it("reads a JSON reply and a fenced reply", () => {
    expect(sanitizeTitle('{"title": "Fix the archive button"}')).toBe("Fix the archive button");
    expect(sanitizeTitle("```\nFix the archive button\n```")).toBe("Fix the archive button");
  });

  it("removes a trailing period but keeps a question mark", () => {
    expect(sanitizeTitle("Fix the archive button.")).toBe("Fix the archive button");
    expect(sanitizeTitle("Why does archive keep the workspace?")).toBe("Why does archive keep the workspace?");
  });

  it("collapses whitespace and control characters", () => {
    expect(sanitizeTitle("  Fix \t the\u0007   archive   button  ")).toBe("Fix the archive button");
  });

  it("cuts a long title at a word boundary with no trailing punctuation", () => {
    const long = "Rebuild the plugin hub settings screen so that every provider can be searched and chosen quickly";
    const title = sanitizeTitle(long);
    expect(title).toBeDefined();
    expect(title!.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
    expect(long.startsWith(title!)).toBe(true);
    expect(long[title!.length]).toBe(" ");
  });

  it("hard-cuts one very long word and never splits an emoji", () => {
    expect(sanitizeTitle("x".repeat(500))).toHaveLength(TITLE_MAX_CHARS);
    const cutAtEmoji = sanitizeTitle(`${"y".repeat(TITLE_MAX_CHARS - 1)}😀 tail`);
    expect(cutAtEmoji).toBeDefined();
    expect(/[\ud800-\udbff]$/.test(cutAtEmoji!)).toBe(false);
  });

  it("honours a smaller limit", () => {
    expect(sanitizeTitle("Fix the archive button now please", 20)).toBe("Fix the archive");
  });

  it("returns undefined for nothing usable", () => {
    for (const reply of ["", "   \n  ", "...", "??", "ab", '""', "```\n```"]) expect(sanitizeTitle(reply), JSON.stringify(reply)).toBeUndefined();
  });

  it("returns undefined for a refusal or an apology so it never becomes a title", () => {
    expect(sanitizeTitle("I'm sorry, but I can't help with that.")).toBeUndefined();
    expect(sanitizeTitle("I cannot determine a title from this conversation")).toBeUndefined();
    expect(sanitizeTitle("As an AI language model, I do not have enough context")).toBeUndefined();
    expect(sanitizeTitle("Sorry, here is a title")).toBeUndefined();
  });

  it("drops leaked thinking and keeps the title after it", () => {
    expect(sanitizeTitle("<think>The user wants a rename plugin.\nSo the title is...</think>\nRename plugin for chats")).toBe("Rename plugin for chats");
    expect(sanitizeTitle("<think>never closed and no title yet")).toBeUndefined();
  });

  it("returns undefined for a placeholder so it never replaces a real title", () => {
    for (const reply of ["N/A", "n/a", "None", "Untitled", "New chat", "Title", "**Conversation**", '"Chat."']) expect(sanitizeTitle(reply), reply).toBeUndefined();
    expect(sanitizeTitle("Chat export bug")).toBe("Chat export bug");
  });

  it("keeps titles in other scripts", () => {
    expect(sanitizeTitle("修复归档按钮的问题")).toBe("修复归档按钮的问题");
    expect(sanitizeTitle("Arreglar el botón de archivar")).toBe("Arreglar el botón de archivar");
    expect(sanitizeTitle("🚀 Ship the plugin")).toBe("🚀 Ship the plugin");
  });
});

describe("sanitizeTitle refuses an assistant talking instead of titling", () => {
  it("refuses the reply a real helper gave after its title, whole or shortened", () => {
    const reply = "I'm in Plan mode and there's no new request to work on. Tell me what you'd like planned — e.g. further changes to the chat-title plugin's Auto rename popover, the per-chat toggle, or something else — and I'll walk through the approach here. I won't edit files or write a plan file until you ask.";
    expect(sanitizeTitle(reply)).toBeUndefined();
    expect(sanitizeTitle("I'm in Plan mode and there's no new request to work on. Tell me what you'd like")).toBeUndefined();
    expect(sanitizeTitle(reply, 30)).toBeUndefined();
  });
  it.each([
    "I'll walk through the approach here", "I am ready to help with whatever you need", "I can help with that once you share the request",
    "Let me know what you'd like planned", "Let me think about a good title", "Sure, here is a title", "Sure! Auto rename popover redesign",
    "Certainly, the title is below", "There's no new request to work on", "No request to work on", "How can I help you today",
    "Could you clarify what you want titled", "Can you share more details", "Thanks for the update", "Thank you!",
    "Fix the archive button. Then add tests for the exporter", "Nothing to title here. Tell me what to do next",
  ])("refuses %j", (reply) => { expect(sanitizeTitle(reply)).toBeUndefined(); });
  it.each([
    "Let's Encrypt certificate renewal", "Why does the build fail on Windows?", "I/O scheduler tuning for NVMe", "I Ching coin toss simulator",
    "Hello world program in Rust", "Plan mode behaviour in OpenCode helpers", "Implement rate limit handling in the API", "Fix v2.0 release notes",
    "Sure Footing: hiking app UI", "Thanks page redesign for checkout", "Can I use CSS container queries", "Tell me when build finishes notification hook",
    "Kubernetes ingress 502 errors after deploy", "ホームページのデザイン修正",
  ])("keeps the real title %j exactly", (title) => { expect(sanitizeTitle(title)).toBe(title); });
  it("still cleans what it always cleaned", () => {
    expect(sanitizeTitle("Here is the title:\nFix archive button")).toBe("Fix archive button");
    expect(sanitizeTitle("<think>hmm</think>Fix archive button.")).toBe("Fix archive button");
    expect(sanitizeTitle("Title: Fix archive button")).toBe("Fix archive button");
  });
  it("is stable: a cleaned title cleans to itself", () => {
    for (const title of ["Fix archive button in the exporter", "Why does the build fail?", "Let's Encrypt certificate renewal"]) expect(sanitizeTitle(sanitizeTitle(title)!)).toBe(title);
  });
  it("tells the runner which replies are usable", () => {
    expect(isUsableTitle("Fix archive button")).toBe(true); expect(isUsableTitle("I'm in Plan mode and there's no new request")).toBe(false); expect(isUsableTitle("   ")).toBe(false);
  });
});

describe("provisionalTitle", () => {
  it("is the first non-empty line, collapsed and clamped like Paseo's own", () => {
    expect(provisionalTitle("\n\n  hello   there \nsecond line")).toBe("hello there");
    expect(provisionalTitle("a".repeat(100))).toBe("a".repeat(PROVISIONAL_TITLE_CHARS));
  });

  it("matches the titles Paseo really gave to chats on this machine", () => {
    expect(provisionalTitle("/unlazy tree 5 develop a plugin too that would take the 10 or 20? last messages")).toBe("/unlazy tree 5 develop a plugin too that would take the 10 o");
    expect(provisionalTitle("is there that joke where my friend if solo queue gets giga chad teammates")).toBe("is there that joke where my friend if solo queue gets giga c");
  });

  it("is undefined for an empty prompt", () => {
    expect(provisionalTitle("  \n \n")).toBeUndefined();
  });
});

describe("isAutoTitle", () => {
  const prompt = "/unlazy tree 5 develop a plugin too that would take the 10 or 20? last messages and then rename the chat";

  it("treats an empty or missing title as machine-made", () => {
    expect(isAutoTitle({ title: "" })).toBe(true);
    expect(isAutoTitle({ title: null })).toBe(true);
    expect(isAutoTitle({ title: "   " })).toBe(true);
  });

  it("treats the title Paseo made from the first prompt as machine-made", () => {
    expect(isAutoTitle({ title: provisionalTitle(prompt), firstPrompt: prompt })).toBe(true);
  });

  it("treats the start of the prompt, with or without an ellipsis, as machine-made", () => {
    expect(isAutoTitle({ title: "/unlazy tree 5 develop a plugin", firstPrompt: prompt })).toBe(true);
    expect(isAutoTitle({ title: "/unlazy tree 5 develop a plugin…", firstPrompt: prompt })).toBe(true);
    expect(isAutoTitle({ title: "/unlazy tree 5 develop a plugin...", firstPrompt: prompt })).toBe(true);
  });

  it("uses only the first non-empty line of a multi-line prompt, with whitespace collapsed", () => {
    expect(isAutoTitle({ title: "fix   the bug", firstPrompt: "\n fix the   bug \nthen do more" })).toBe(true);
    expect(isAutoTitle({ title: "then do more", firstPrompt: "fix the bug\nthen do more" })).toBe(false);
  });

  it("treats the last title this plugin wrote as machine-made, ignoring whitespace", () => {
    expect(isAutoTitle({ title: "Chat title plugin", lastWritten: "Chat  title plugin " })).toBe(true);
  });

  it("treats a title a person typed as theirs", () => {
    expect(isAutoTitle({ title: "My notes on the relay", firstPrompt: prompt, lastWritten: "Chat title plugin" })).toBe(false);
  });

  it("treats a title that was written by this plugin but then edited as theirs", () => {
    expect(isAutoTitle({ title: "Chat title plugin (mine)", firstPrompt: prompt, lastWritten: "Chat title plugin" })).toBe(false);
  });

  it("does not guess without a first prompt or a last written title", () => {
    expect(isAutoTitle({ title: "/unlazy tree 5 develop a plugin too that would take the 10 o" })).toBe(false);
  });
});
