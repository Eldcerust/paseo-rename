Chat titles renames a Paseo chat to match its recent conversation. It can update the chat title and workspace title separately, either after completed turns or when you submit `/retitle` or choose the current-chat rename action in the Command Center.

The default window is the last 10 conversational messages, capped at 600 characters each. Tool and reasoning rows are excluded, and assistant text is merged by turn. Ten messages was chosen from a small exploratory sample, not a title-quality benchmark. Settings let you use 4 to 40 messages and 200 to 4000 characters per message.

## Setup and model choice

Requires Paseo 0.15.4 or later on the daemon and app, a configured agent provider, and the Paseo CLI on the daemon machine. Open Chat titles settings to choose any available daemon provider and search its models. Prefix-based model catalogs have a sub-provider column like Pill hub; flat catalogs do not. Unavailable providers show their reported reason. Choosing a model saves both provider and model together for the selected host.

Without an explicit choice, the plugin tries DeepSeek Flash through the available OpenCode routes, then Claude Haiku. If none of those listed models is available, choose another model. The sample test makes one real helper run without renaming a chat.

## Behavior and data

Automatic renaming is on by default: after the first completed turn, then every four completed turns, with at least a minute between attempts. Its interval is adjustable from 1 to 50 turns, or it can be disabled. Automatic attempts protect custom chat titles and ignore helpers and subagents. Manual actions can replace a custom title. A workspace shared by another live chat is not renamed. An unusable model reply leaves existing titles unchanged, and results show separate chat and workspace outcomes.

Recent message text and the current title go to your chosen model through the daemon's provider configuration. Provider privacy policies, account charges and subscription quota apply. Each generation attempt or sample test is one helper run; a larger window or shorter interval can increase cost. Helpers request text-only replies in an empty scratch folder, use a read-only mode when available, deny permission requests, and are archived with their workspace after running. This is not a sandbox for providers or installed hooks.

Settings and recent outcome records stay on the selected host. Outcome records include generated titles and chat/model identifiers, not the message window; the provider's helper history can still retain the prompt. The Windows daemon is the exercised platform. Other operating systems and native mobile rendering have not been verified. Live app rendering, composer interaction and the installed subprocess environment require a separate installation check.
