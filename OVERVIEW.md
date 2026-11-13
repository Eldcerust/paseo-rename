Chat titles renames a Paseo chat to match its recent conversation. It can update the chat title and workspace title separately, either after completed turns or when you submit `/retitle` or choose the current-chat rename action in the Command Center.

The default window is the last 10 conversational messages, capped at 600 characters each. Tool and reasoning rows are excluded, and assistant text is merged by turn. Ten messages was chosen from a small exploratory sample, not a title-quality benchmark. Settings let you use 4 to 40 messages and 200 to 4000 characters per message.

## Setup and model choice

Requires Paseo 0.15.4 or later on the daemon and app, a configured agent provider, and the Paseo CLI on the daemon machine. Open Chat titles settings to choose any available daemon provider and search its models. Prefix-based model catalogs have a sub-provider column like Pill hub; flat catalogs do not. Unavailable providers show their reported reason. Choosing a model saves both provider and model together for the selected host.

The normal Chat titles settings entry controls automatic renaming, its interval, recent-message window, targets and model. The clickable Auto rename composer tool offers Rename now and Auto-rename settings. With Pill hub installed and its merge switch on, the same tool appears inside Tools; otherwise it has its own pill. Settings always open in Chat titles, even from inside Tools.

Pill hub v1 shares its bus across connected hosts. For multi-host use, install the hub on each host using Chat titles and align their Auto rename merge switches. Mixed installations can hide the composer tool on a host without its own hub. Turn that tool's merge switch off in all active hubs to use standalone pills instead. Standard settings and Command Center actions are unaffected.

Without an explicit choice, the plugin tries DeepSeek Flash through the available OpenCode routes, then Claude Haiku. If none of those listed models is available, choose another model. The sample test makes one real helper run without renaming a chat.

## Behavior and data

Automatic renaming is on by default: after the first completed turn, then every four completed turns, with at least a minute between attempts. Its interval is adjustable from 1 to 50 turns, or it can be disabled. Automatic attempts protect custom chat titles and ignore helpers and subagents. Manual actions can replace a custom title. A workspace shared by another live chat is not renamed. An unusable model reply leaves existing titles unchanged, and results show separate chat and workspace outcomes.

Manual actions and sample tests run as background jobs. Progress remains pending until the actual result or error, rather than holding one RPC open through slow model generation. If a client disconnects or closes the sample screen, the host job may still finish. Check Recent outcomes before retrying a rename. Jobs have bounded queues and retain results for 15 minutes; a plugin restart loses that in-memory job history, but not saved settings or stored rename outcomes.

Recent message text and the current title go to your chosen model through the daemon's provider configuration. Provider privacy policies, account charges and subscription quota apply. Each generation attempt or sample test is one helper run; a larger window or shorter interval can increase cost. Helpers request text-only replies in an empty scratch folder, use a read-only mode when available, deny permission requests, and are archived with their workspace after running. This is not a sandbox for providers or installed hooks.

Settings and recent outcome records stay on the selected host. Outcome records include generated titles and chat/model identifiers, not the message window; the provider's helper history can still retain the prompt. The Windows daemon is the exercised platform. Other operating systems and native mobile rendering have not been verified. Live app rendering, composer interaction and the installed subprocess environment require a separate installation check.
