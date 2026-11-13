import type { PluginClientContext } from "@getpaseo/plugin/client";
import { registerCommands, TITLES_SCREEN, TITLES_SETTINGS } from "./client/commands";
import { TitleScreen, TitleSettingsScreen } from "./client/settings-screen";

export default function contribute(client: PluginClientContext) {
  const removers = [
    client.addSettingsScreen({ id: TITLES_SETTINGS, title: "Chat titles", icon: "CaseSensitive", Component: TitleSettingsScreen }),
    client.addScreen({ id: TITLES_SCREEN, title: "Chat titles", Component: TitleScreen }),
    registerCommands(client),
  ];
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const remove of removers.reverse()) remove();
  };
}
