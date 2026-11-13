# Chat titles for Paseo

Rename a chat from its recent conversation instead of leaving it named after an old first prompt. Chat titles can update the chat title and its workspace title independently, automatically after completed turns or on demand with `/retitle`.

## Setup

Requires Paseo **0.15.4 or later** on both the daemon and app, an available agent provider, and the Paseo CLI on the daemon machine. The chat rename uses the CLI because this SDK version has a workspace title setter but no agent title setter. The implementation has been checked against the Windows daemon; macOS, Linux and native mobile rendering have not been exercised.

Plugins are trusted, unsandboxed code. Enable plugins on the intended daemon only if you trust this source. Install the local repository through **Settings → Plugins → Plugin source**, or with:

```text
paseo plugin install /absolute/path/to/paseo-chat-title
```

Open **Chat titles settings** from the Command Center or the plugin's settings entry. Settings belong to the selected host and are shared by that host's connected clients. Installation, reload, and live app rendering are separate from the source-level tests; they have not been verified as part of this implementation.

## Use

- Submit **`/retitle`**, without arguments, in the chat you want to rename. The command does not send a prompt to that chat's provider. It opens a result screen while the plugin runs a separate title helper.
- The Command Center's **Rename this chat from recent messages** does the same thing for its current chat.
- Manual renaming can replace a custom title. Automatic renaming leaves a title you chose alone. A manual title change while an automatic model request is running is protected too.
- Results describe the chat and workspace separately. A chat rename can succeed while a workspace rename fails or is skipped. Recent outcomes retain those details.

## Provider and model

The picker lists every daemon provider, including unavailable providers with their actual reported reason. Choose an available agent provider, then search its models. Model IDs with prefixes, such as OpenCode's, get the Pill hub-style sub-provider column. A flat catalog such as Claude's has only a model list, without an invented provider level. Browsing a provider does not change settings; selecting a model saves the complete provider/model pair together.

With **Reset model**, the built-in preference tries these entries in order, only when both the provider and model are listed as available:

1. `opencode/opencode-go/deepseek-v4.1-flash`
2. `opencode/opencode/deepseek-v4.1-flash`
3. `claude/claude-haiku-5-5`

If none is available, choose a model explicitly. Availability is catalog information, not a guarantee of authentication, quota, or a successful response. **Generate sample title** tests the saved model against a fixed sample conversation without changing a real chat.

## Settings

| Setting | Default | Effect |
|---|---|---|
| Messages | 10 | Last 4 to 40 conversational messages |
| Characters per message | 600 | Cap from 200 to 4000; long text keeps 70% from the beginning and 30% from the end |
| Chat title | On | Rename the current agent's title |
| Workspace title | On | Rename its workspace only when no other live chat uses it |
| Automatic renaming | On | Attempt after the first completed turn, then at the interval below |
| Completed turns between renames | 4 | Interval from 1 to 50 completed turns |

Automatic attempts are debounced for four seconds and spaced at least a minute apart. Helper agents and subagents do not trigger recursive renaming. Both targets off means no title model call. A model may keep the current title when it still fits; an empty or unusable reply never replaces a title.

### Why the last 10 messages, not 20?

An exploratory calibration of 20 active chats found that **13 of 20** had at least 10 conversational messages, and 12 had at least 20. The last 10 messages contained an average of **2.35** distinct user prompts, versus **4.2** for 20 messages. Last-10 and last-20 windows shared about **66%** of their vocabulary. At a 600-character cap, a 10-message window held a median 2,270 characters and a 90th percentile of 3,628, compared with roughly 4,000 and 7,200 for 20 messages.

Ten is the smaller default that usually retains multiple user requests while following a topic shift sooner. The intuition that a majority-new-topic window turns over after about five messages rather than ten is a heuristic, not a measured model-quality result. This small convenience sample is not a benchmark and does not establish that 10 is optimal for every chat. Increase the window if your conversations need more context.

A message is one non-empty user message, or assistant text chunks merged for one turn. Tool, reasoning, notification and other non-conversational timeline rows do not count. The reader pages backward to find actual messages, rather than treating the last 10 raw timeline rows as 10 messages.

## Privacy, cost and limits

Recent message text and the current title are sent to the selected model through your daemon's provider configuration. They may include sensitive data. That provider's routing, account, retention and data policies apply; using a local daemon does not mean inference stays local.

Each rename attempt that reaches generation uses **one helper run**, even when the model keeps the title or its output cannot be used. A model test also uses one run. Provider charges or subscription quota can apply. Larger windows and shorter intervals can increase cost. The plugin does not estimate prices.

Helpers are serialized in an empty shared scratch folder, use a read-only mode when the provider offers one, request text-only replies, and deny permission requests. Helpers and their workspaces are archived after a run. These measures are not a sandbox: providers and installed hooks still run under your daemon account. The scratch folder is reused rather than repeatedly created and deleted because provider processes can keep directory handles open.

On graceful plugin shutdown, new requests are refused, automatic/manual/sample generation is cancelled, and active requests are drained while helper archival is attempted. Late provider replies cannot resume a cancelled title request. Archival is best effort: an unavailable daemon, a slow agent-creation or archive operation, or a forced process kill can prevent cleanup from completing within the host's shutdown window.

Host-local state records the last titles written, automatic turn counters, and up to 20 recent outcomes. Outcomes include titles, chat IDs, model IDs and failure details, not a copy of the conversation window. The provider's own helper history can still retain the prompt. There is no automatic fallback to an unrelated model when an explicit choice fails.

Workspace titles are deliberately left alone when another live chat shares the workspace. An automatic attempt also protects a workspace title you changed after this plugin last wrote it. Renaming does not rename directories or Git branches. Duplicate requests for the same chat are rejected while a rename is in progress. Unavailable providers, authentication failures, quota errors and missing CLI routes are reported rather than treated as successful renames.

## Development checks

```text
npm run typecheck
node node_modules/vitest/vitest.mjs run --exclude "**/*.live.test.ts"
```

The opt-in live suites require a running local daemon. Set `CHAT_TITLE_LIVE=1` and run `server/e2e.live.test.ts` to exercise real model calls and throwaway title changes. This consumes provider quota. The suite archives only its own test agents and workspaces, and verifies cleanup. It does not install or reload the plugin, so it does not establish that the app UI or plugin subprocess environment works.
