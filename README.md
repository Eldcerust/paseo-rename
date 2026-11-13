# Paseo Rename

Rename a Paseo chat from its recent conversation instead of leaving it named after an old first prompt. Update chat and workspace titles independently, choose the model that writes them, and rename on demand or automatically in the chats you opt in.

The plugin appears in Paseo as **Chat titles**, with the installation ID **`chat-title`**. Its composer tool is called **Auto rename**. Automatic renaming is **off by default for every chat**.

[MIT license](LICENSE) · [Report an issue](https://github.com/Eldcerust/paseo-rename/issues)

## Install

Requires Paseo **0.15.4 or later** on both the daemon and app, an available agent provider, and the Paseo CLI on the daemon machine. The chat rename uses the CLI because this SDK version has a workspace title setter but no agent title setter. The implementation has been checked against the Windows daemon; macOS, Linux and native mobile rendering have not been exercised.

Plugins are trusted, unsandboxed code. Enable plugins on the intended daemon only if you trust this source.

### From the app

1. Open **Settings → Plugins** on the host where your chats run.
2. Turn on **Enable plugins** if needed.
3. Paste `https://github.com/Eldcerust/paseo-rename.git` into **Plugin source** and select **Install plugin**.
4. Confirm **Chat titles** shows **running**.

### From the CLI

Run these commands on the daemon machine after enabling plugins:

```sh
paseo plugin install https://github.com/Eldcerust/paseo-rename.git
paseo plugin ls chat-title
```

Paseo supplies the runtime libraries and compiles the plugin; installing from Git does not require a separate `npm install`. For another daemon, add the CLI's `--host` option to select that host.

### First rename

1. Click **Rename Chat Title** in the sidebar header to open the settings directly. You can also open **Chat titles** in plugin settings, or **Chat titles settings** from the Command Center.
2. Choose an available provider and model, or keep the built-in preference described below.
3. Use **Generate sample title** to check the saved model without changing a chat.
4. Open a chat, then choose **Auto rename → Rename now**, or submit **`/retitle`**.

Settings belong to the selected host and are shared by that host's connected clients. Installing the plugin does not switch automatic renaming on for any chat.

## Use

- **Configure:** click **Rename Chat Title** in the sidebar header. This opens the existing settings for the selected host; it does not rename a chat. Paseo's **Settings → Sidebar** controls the row's visibility and order.
- Submit **`/retitle`**, without arguments, in the chat you want to rename. The command does not send a prompt to that chat's provider. It opens a result screen while the plugin runs a separate title helper.
- The Command Center's **Rename this chat from recent messages** does the same thing for its current chat.
- Click **Auto rename** in the composer. It shows this chat's current title and how the last rename went (renamed, title still fits, left unchanged, or what failed and for which target, with the time), then offers **Rename now**, a **Rename automatically** switch for this chat, and **Auto-rename settings**. If Pill hub is running and merging is enabled for Auto rename, these actions appear inside its **Tools** pill instead. Turn that tool's merge switch off in Pill hub to restore its standalone pill. No Pill hub installation is required.
- **Automatic renaming is off by default for every chat.** Switch it on for a chat with **Rename automatically** in that chat's Auto rename tool (under **Tools** in Pill hub, or in its own pill). The choice is remembered for that chat only, on the host and across restarts, and each chat keeps its own. A chat that is switched on is renamed after its next completed turn, then every four completed turns (the interval is a setting). The **Allow automatic renaming** setting is the master switch: while it is off no chat renames itself and the per-chat switches are disabled. Chats that renamed themselves before this switch existed start off and must be switched on.
- Manual renaming can replace a custom title. Automatic renaming leaves a title you chose alone. A manual title change while an automatic model request is running is protected too.
- Results describe the chat and workspace separately. A chat rename can succeed while a workspace rename fails or is skipped. Recent outcomes retain those details.

Pill hub v1 uses an app-wide bus, not host-qualified tool discovery. On a single host, merge/fallback follows its switch normally. With multiple connected hosts, install Pill hub on each host using Chat titles and keep their Auto rename merge choices aligned. A hub running only on another host can otherwise absorb the tool without displaying it locally. Turning Auto rename merging off in all active hubs restores the standalone tool. Normal Chat titles settings, `/retitle`, and Command Center actions remain available regardless. This plugin does not change the other plugin's protocol or settings.

### Background jobs and progress

Manual renames and saved-model samples return a job acknowledgement immediately, then the client polls that job until its real result or error arrives. Acknowledgement is not success. This avoids holding a plugin RPC open during generation, which may exceed Paseo's 30-second RPC deadline. The helper's model timeout and your selected model are unchanged.

The host serializes manual/sample jobs, permits up to 20 pending jobs, and keeps up to 100 job records for 15 minutes after completion. It refuses new jobs if those bounds are full rather than evicting an active job or a still-retained error. Automatic renaming keeps its existing trigger path and shares the serialized helper runner. Job records are in memory and do not survive a plugin restart; recent rename outcomes are stored separately.

Closing settings stops observing its sample. Plugin client cleanup stops command/tool polling. This does not cancel an already-acknowledged host job: it may still finish, so check **Recent outcomes** before retrying after a disconnect, lost job, or observation timeout. Polling backs off from half a second to 2.5 seconds and stops after 35 minutes. Graceful host shutdown instead cancels and drains its jobs. Sample results are not rename outcomes; an expired or restarted sample must be tested again if you still need its result.

For integrations, `chat-title.retitle` returns `{kind: "retitle", jobId, agentId}` and `chat-title.test` returns `{kind: "sample", jobId}`. `chat-title.job-status` accepts `{jobId}` and returns either `{found: true, job}` with queued/running/succeeded/failed state and terminal result/error, or `{found: false, jobId, error}` for a missing job. These replace the earlier synchronous RPC outputs; internal retitler results and saved settings are unchanged.

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
| Rename automatically (per chat) | Off | Remember whether this individual chat may rename itself |
| Allow automatic renaming (master switch) | On | Permit automatic attempts only for chats explicitly switched on |
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

The title comes from the helper's own first usable message, not necessarily its last. A provider can speak again after answering (OpenCode's plan mode has been seen adding a plan-mode reminder and answering it), and that second message does not replace the title. A reply that is the assistant talking rather than a title, such as an offer, a question or a few sentences, is refused: the rename fails with a clear reason and the title is left as it was.

On graceful plugin shutdown, new requests are refused, automatic/manual/sample generation is cancelled, and active requests are drained while helper archival is attempted. Late provider replies cannot resume a cancelled title request. Archival is best effort: an unavailable daemon, a slow agent-creation or archive operation, or a forced process kill can prevent cleanup from completing within the host's shutdown window.

Host-local state records the last titles written, automatic turn counters, which chats have automatic renaming switched on (up to 5000; beyond that a chat cannot be switched on until another is switched off), and up to 20 recent outcomes. Outcomes include titles, chat IDs, model IDs and failure details, not a copy of the conversation window. The provider's own helper history can still retain the prompt. There is no automatic fallback to an unrelated model when an explicit choice fails.

Workspace titles are deliberately left alone when another live chat shares the workspace. An automatic attempt also protects a workspace title you changed after this plugin last wrote it. Renaming does not rename directories or Git branches. Duplicate requests for the same chat are rejected while a rename is in progress. Unavailable providers, authentication failures, quota errors and missing CLI routes are reported rather than treated as successful renames.

## Update, troubleshoot and remove

For a Git-installed copy, check for and approve an update with:

```sh
paseo plugin update chat-title
```

If the tool is missing or a rename fails, confirm you are viewing the intended host, check the plugin status, and inspect its backend logs:

```sh
paseo plugin ls chat-title
paseo plugin logs chat-title
```

Unavailable models, authentication failures and provider quota errors need to be resolved for the selected provider. The plugin does not silently switch to another model. If the app still shows an old tool after a plugin update or reload, reload the app once.

To remove the plugin:

```sh
paseo plugin remove chat-title
```

## Development

Clone the repository and install its locked development dependencies:

```sh
git clone https://github.com/Eldcerust/paseo-rename.git
cd paseo-rename
npm ci
```

Run the typecheck and non-live tests:

```text
npm run typecheck
node node_modules/vitest/vitest.mjs run --exclude "**/*.live.test.ts"
```

To work on a local copy, install its absolute directory path instead of the Git URL. After editing it, typecheck and reload that installation:

```sh
paseo plugin install /absolute/path/to/paseo-rename
npm run typecheck
paseo plugin reload chat-title
```

Do not install a second copy under the same `chat-title` ID while another installation is present. Use a separate test daemon or an explicit `--id` for a development copy. The source tests do not establish that the reloaded app UI or installed subprocess works; check those separately after reloading.

The opt-in live suites require a running local daemon. Set `CHAT_TITLE_LIVE=1` and run `server/e2e.live.test.ts` to exercise real model calls and throwaway title changes. This consumes provider quota. The suite archives only its own test agents and workspaces, and verifies cleanup. It does not install or reload the plugin, so it does not establish that the app UI or plugin subprocess environment works.

## License

[MIT](LICENSE). Copyright © 2026 Eldcerust.
