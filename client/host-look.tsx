import type { PluginHostProps } from "@getpaseo/plugin/client";
import { createContext, useContext } from "react";

type HostLook = Pick<PluginHostProps, "theme" | "layout">;
const HostLookContext = createContext<HostLook | undefined>(undefined);
export const HostLookProvider = HostLookContext.Provider;
export function useHostLook(): HostLook {
  const look = useContext(HostLookContext);
  if (!look) throw new Error("Chat titles controls need a HostLookProvider.");
  return look;
}
