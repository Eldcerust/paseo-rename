import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { retitleResultSchema, type RetitleResult } from "../shared/types";

/** What the plugin remembers about one chat. Without it, automatic renaming could not tell its own title from a person's. */
export interface AgentMemory {
  /** The last chat title this plugin wrote or confirmed. */
  title?: string;
  /** The last workspace title this plugin wrote or confirmed. */
  workspaceTitle?: string;
  /** Completed turns seen since the last automatic attempt or rename. */
  turns: number;
  renamedAt?: string;
  /** When an automatic rename last looked at this chat, whatever it decided. */
  attemptedAt?: string;
}

const memorySchema = z.object({
  title: z.string().optional(),
  workspaceTitle: z.string().optional(),
  turns: z.number().int().nonnegative().catch(0),
  renamedAt: z.string().optional(),
  attemptedAt: z.string().optional(),
});

export const DEFAULT_MAX_AGENTS = 500;
export const DEFAULT_MAX_RECENT = 20;
/** How many chats may have automatic renaming switched on. Refused beyond it; a chat is never silently dropped. */
export const MAX_AUTO_CHATS = 5000;

export interface StateStore {
  get(agentId: string): Promise<AgentMemory>;
  /** Changes one chat's memory and saves it. The chat becomes the most recently used. */
  update(agentId: string, change: (current: AgentMemory) => AgentMemory): Promise<AgentMemory>;
  /** Adds a result to the list the settings screen shows, newest first. */
  pushResult(result: RetitleResult): Promise<void>;
  recent(): Promise<RetitleResult[]>;
  /** Whether automatic renaming is switched on for this chat. Every chat starts off. */
  chatAuto(agentId: string): Promise<boolean>;
  /**
   * Switches automatic renaming on or off for one chat and saves it. Switching on starts the chat fresh (the next
   * completed turn is its first look); switching off leaves its memory alone. Throws, changing nothing, when the
   * save fails or too many chats are already on.
   */
  setChatAuto(agentId: string, enabled: boolean): Promise<boolean>;
}

export function paseoRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PASEO_HOME?.trim();
  return configured && configured.length > 0 ? configured : join(homedir(), ".paseo");
}

export const statePath = (root: string = paseoRoot()) => join(root, "plugin-data", "chat-title", "state.json");

interface Doc {
  agents: Map<string, AgentMemory>;
  recent: RetitleResult[];
  /** The chats with automatic renaming on. Kept apart from `agents`, which forgets the quietest chats; absent means off. */
  auto: Set<string>;
}

/** Reads what it can: one malformed record never costs the rest, and an unreadable file starts over. */
function parseDoc(text: string): Doc {
  const doc: Doc = { agents: new Map(), recent: [], auto: new Set() };
  const raw: unknown = JSON.parse(text);
  if (!raw || typeof raw !== "object") return doc;
  const { agents, recent, auto } = raw as { agents?: unknown; recent?: unknown; auto?: unknown };
  if (Array.isArray(auto)) for (const id of auto) if (typeof id === "string" && id.length > 0) doc.auto.add(id);
  if (agents && typeof agents === "object") {
    for (const [id, value] of Object.entries(agents)) {
      const parsed = memorySchema.safeParse(value);
      if (parsed.success) doc.agents.set(id, parsed.data);
    }
  }
  if (Array.isArray(recent)) {
    for (const value of recent) {
      const parsed = retitleResultSchema.safeParse(value);
      if (parsed.success) doc.recent.push(parsed.data);
    }
  }
  return doc;
}

export function createStateStore(file: string, { maxAgents = DEFAULT_MAX_AGENTS, maxRecent = DEFAULT_MAX_RECENT, maxAutoChats = MAX_AUTO_CHATS }: { maxAgents?: number; maxRecent?: number; maxAutoChats?: number } = {}): StateStore {
  let loaded: Promise<Doc> | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  const load = () =>
    (loaded ??= (async () => {
      let text: string;
      try {
        text = await fs.readFile(file, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`[chat-title] cannot read ${file}; starting over`, error);
        return { agents: new Map(), recent: [], auto: new Set() } satisfies Doc;
      }
      try {
        return parseDoc(text);
      } catch (error) {
        console.error(`[chat-title] ignoring unreadable ${file}`, error);
        return { agents: new Map(), recent: [], auto: new Set() } satisfies Doc;
      }
    })());

  /** One writer at a time: turn ends can land together, and each change is a read-modify-write of one document. */
  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function save(doc: Doc): Promise<void> {
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    const body = JSON.stringify({ version: 1, agents: Object.fromEntries(doc.agents), recent: doc.recent, auto: [...doc.auto] });
    try {
      await fs.mkdir(dirname(file), { recursive: true });
      await fs.writeFile(temporary, `${body}\n`, "utf8");
      await fs.rename(temporary, file);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw new Error(`[chat-title] cannot write ${file}`, { cause: error });
    }
  }

  return {
    async get(agentId) {
      return { ...((await load()).agents.get(agentId) ?? { turns: 0 }) };
    },
    update(agentId, change) {
      return serialize(async () => {
        const doc = await load();
        const next = change({ ...(doc.agents.get(agentId) ?? { turns: 0 }) });
        doc.agents.delete(agentId);
        doc.agents.set(agentId, next);
        while (doc.agents.size > maxAgents) {
          const oldest = doc.agents.keys().next().value;
          if (oldest === undefined) break;
          doc.agents.delete(oldest);
        }
        await save(doc);
        return { ...next };
      });
    },
    pushResult(result) {
      return serialize(async () => {
        const doc = await load();
        doc.recent = [result, ...doc.recent].slice(0, maxRecent);
        await save(doc);
      });
    },
    async recent() {
      return [...(await load()).recent];
    },
    async chatAuto(agentId) {
      return (await load()).auto.has(agentId);
    },
    setChatAuto(agentId, enabled) {
      return serialize(async () => {
        const doc = await load();
        if (enabled === doc.auto.has(agentId)) return enabled;
        if (enabled && doc.auto.size >= maxAutoChats) {
          throw new Error(`Automatic renaming is already on for ${maxAutoChats} chats, which is the most this plugin remembers. Switch it off for a chat you no longer use first.`);
        }
        const memory = doc.agents.get(agentId);
        if (enabled) {
          doc.auto.add(agentId);
          if (memory) {
            // A fresh start: the next completed turn is the chat's first look, whatever the counters said before.
            const { attemptedAt: _attempted, ...rest } = memory;
            doc.agents.set(agentId, { ...rest, turns: 0 });
          }
        } else doc.auto.delete(agentId);
        try {
          await save(doc);
        } catch (error) {
          // The saved file did not change, so neither may what the trigger reads.
          if (enabled) {
            doc.auto.delete(agentId);
            if (memory) doc.agents.set(agentId, memory);
          } else doc.auto.add(agentId);
          throw error;
        }
        return enabled;
      });
    },
  };
}
