import { createPaseoClient, type PaseoClient } from "@getpaseo/client";

/** Whether the `*.live.test.ts` files should talk to the local Paseo daemon. Off unless asked for. */
export const LIVE = process.env.CHAT_TITLE_LIVE === "1";

/** Opens the same SDK client the plugin runtime hands to a handler, against the local daemon. */
export async function connectLive(): Promise<PaseoClient> {
  const client = createPaseoClient({
    url: process.env.PASEO_URL ?? "ws://127.0.0.1:6767/ws",
    clientId: `chat-title-live-${process.pid}`,
    connectTimeoutMs: 15_000,
    reconnect: { enabled: false },
  });
  await client.connect();
  return client;
}
