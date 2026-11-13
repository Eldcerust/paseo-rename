import type { PluginClientContext } from "@getpaseo/plugin/client";
import { createRenameActions, registerCommands, TITLES_SCREEN, TITLES_SETTINGS } from "./client/commands";
import { TitleScreen, TitleSettingsScreen } from "./client/settings-screen";
import { contributePills } from "./client/pills";

export default function contribute(client: PluginClientContext) {
  const actions = createRenameActions(client);
  const removers = [
    () => actions.dispose(),
    client.addSettingsScreen({ id: TITLES_SETTINGS, title: "Chat titles", icon: "CaseSensitive", Component: TitleSettingsScreen }),
    client.addScreen({ id: TITLES_SCREEN, title: "Chat titles", Component: TitleScreen }),
    registerCommands(client, actions),
    contributePills(client, actions),
  ];
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const remove of removers.reverse()) remove();
  };
}
