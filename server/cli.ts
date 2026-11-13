import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";

/**
 * Renames a chat by running `paseo agent update <id> --name <title>`.
 *
 * The SDK has no agent rename (only workspaces have `setTitle`), but the daemon does accept it and
 * the Paseo command sends it. The title is written by a model, so it is never put on a shell
 * command line where it can be avoided: the app's own executable is started directly with an
 * argument list, exactly as Paseo's own `paseo.cmd` shim does. Only when the app cannot be found
 * and `paseo.cmd` is the one thing left is a shell used, and then only for a title restricted to
 * characters a shell cannot misread.
 */

export interface CliEnvironment {
  platform: NodeJS.Platform;
  /** The program running this plugin. Inside the Paseo app it is the app's own executable. */
  execPath: string;
  env: Record<string, string | undefined>;
  exists(path: string): boolean;
}

export const currentEnvironment = (): CliEnvironment => ({ platform: process.platform, execPath: process.execPath, env: process.env, exists: existsSync });

export interface Invocation {
  /** Where this candidate was derived from, for the error message when none works. */
  label: string;
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
  shell: boolean;
}

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** `missing` when the program does not exist; otherwise a short reason such as `timeout`. */
  error?: string;
}

export type RunCli = (invocation: Invocation) => Promise<RunResult>;

const AGENT_ID = /^[A-Za-z0-9._-]{1,128}$/;
/** What a shell cannot misread: ASCII letters and digits, space, and a few quiet marks. */
const SHELL_SAFE_TITLE = /^[A-Za-z0-9 _.,:;'()/+#@=?-]{1,200}$/;
const COMMAND_TIMEOUT_MS = 30_000;

const pathsFor = (platform: NodeJS.Platform) => (platform === "win32" ? win32 : posix);

/** The two scripts inside an app's resources folder that run the Paseo command, as `paseo.cmd` does. */
function bundledInvocation(app: string, resources: string, args: string[], environment: CliEnvironment, label: string): Invocation | undefined {
  const p = pathsFor(environment.platform);
  const runner = p.join(resources, "app.asar.unpacked", "dist", "daemon", "node-entrypoint-runner.js");
  const cli = p.join(resources, "app.asar", "node_modules", "@getpaseo", "cli", "dist", "index.js");
  if (!environment.exists(app) || !environment.exists(p.join(resources, "app.asar")) || !environment.exists(runner)) return undefined;
  return {
    label,
    command: app,
    args: ["--disable-warning=DEP0040", runner, "node-script", cli, ...args],
    env: { ...environment.env, ELECTRON_RUN_AS_NODE: "1", PASEO_NODE_ENV: "production" },
    shell: false,
  };
}

/** Every place the app may be, in the order tried: this process itself, the shim Paseo names, the usual install folders. */
function appLocations(environment: CliEnvironment): { app: string; resources: string; label: string }[] {
  const p = pathsFor(environment.platform);
  const found: { app: string; resources: string; label: string }[] = [];
  const fromApp = (app: string, label: string) => {
    const resources = environment.platform === "darwin" ? p.join(p.dirname(p.dirname(app)), "Resources") : p.join(p.dirname(app), "resources");
    found.push({ app, resources, label });
  };
  const own = p.basename(environment.execPath).toLowerCase();
  if (own === "paseo.exe" || own === "paseo") fromApp(environment.execPath, "this process (the Paseo app)");
  for (const name of ["PASEO_CLI", "PASEO_BIN"] as const) {
    const shim = environment.env[name];
    if (shim && p.basename(shim).toLowerCase() === "paseo.cmd" && p.basename(p.dirname(shim)).toLowerCase() === "bin") {
      const resources = p.dirname(p.dirname(shim));
      found.push({ app: p.join(p.dirname(resources), "Paseo.exe"), resources, label: `${name} (${shim})` });
    }
  }
  if (environment.platform === "win32") {
    for (const base of [environment.env.ProgramFiles, environment.env.LOCALAPPDATA && win32.join(environment.env.LOCALAPPDATA, "Programs")]) {
      if (base) fromApp(win32.join(base, "Paseo", "Paseo.exe"), `the usual install folder (${win32.join(base, "Paseo")})`);
    }
  } else if (environment.platform === "darwin") {
    fromApp("/Applications/Paseo.app/Contents/MacOS/Paseo", "/Applications/Paseo.app");
  }
  return found;
}

export interface RenamePlan {
  candidates: Invocation[];
  /** Why a candidate that exists was not offered, such as an unsafe title for the shell. */
  notes: string[];
}

/** The commands that could rename this chat, most direct first. Throws on an agent id or title no command may carry. */
export function planRename(environment: CliEnvironment, agentId: string, title: string): RenamePlan {
  if (!AGENT_ID.test(agentId)) throw new Error("That chat id cannot be passed to the Paseo command.");
  const name = title.trim();
  if (name === "" || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error("That title cannot be passed to the Paseo command.");
  const args = ["agent", "update", agentId, "--name", name];
  const home = environment.env.PASEO_HOME;
  if (home) args.push("--home", home);

  const candidates: Invocation[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  for (const { app, resources, label } of appLocations(environment)) {
    const invocation = bundledInvocation(app, resources, args, environment, label);
    if (invocation && !seen.has(invocation.command)) {
      seen.add(invocation.command);
      candidates.push(invocation);
    }
  }
  const override = environment.env.PASEO_BIN;
  if (override && pathsFor(environment.platform).basename(override).toLowerCase() !== "paseo.cmd") {
    candidates.push({ label: `PASEO_BIN (${override})`, command: override, args, env: environment.env, shell: false });
  }
  if (environment.platform !== "win32") {
    candidates.push({ label: "paseo on PATH", command: "paseo", args, env: environment.env, shell: false });
  } else if (SHELL_SAFE_TITLE.test(name) && !home?.includes('"')) {
    const quoted = (value: string) => `"${value}"`;
    const line = ["paseo", "agent", "update", agentId, "--name", quoted(name), ...(home ? ["--home", quoted(home)] : [])].join(" ");
    candidates.push({ label: "paseo.cmd on PATH", command: line, args: [], env: environment.env, shell: true });
  } else {
    notes.push("paseo.cmd on PATH was not used: the title has characters that cannot be passed safely through a shell");
  }
  return { candidates, notes };
}

/** Starts a program with a time limit and collects its output. */
export const runInvocation: RunCli = (invocation) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const env = Object.fromEntries(Object.entries(invocation.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const child = spawn(invocation.command, invocation.args, { env, shell: invocation.shell, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      child.kill();
      finish({ status: null, stdout, stderr, error: "timeout" });
    }, COMMAND_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < 65_536) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 65_536) stderr += chunk.toString("utf8");
    });
    child.on("error", (error: NodeJS.ErrnoException) => finish({ status: null, stdout, stderr: error.message, error: error.code === "ENOENT" ? "missing" : error.message }));
    child.on("close", (status) => finish({ status, stdout, stderr }));
  });

const firstLine = (text: string) => text.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== "") ?? "";
/** A shell reports a program it cannot find as a failed command, not as a missing file. */
const notFoundInShell = (result: RunResult) => /not recognized|not found|cannot find/i.test(`${result.stderr}${result.stdout}`);

/**
 * Renames a chat through the Paseo command. Tries each candidate until one exists; a command that
 * runs and fails is a real failure and ends the search. Resolves when the command succeeded.
 */
export async function renameAgentWithCli(environment: CliEnvironment, run: RunCli, agentId: string, title: string): Promise<void> {
  const { candidates, notes } = planRename(environment, agentId, title);
  const tried: string[] = [];
  for (const candidate of candidates) {
    const result = await run(candidate);
    const missing = result.error === "missing" || (candidate.shell && result.status !== 0 && notFoundInShell(result));
    if (missing) {
      tried.push(candidate.label);
      continue;
    }
    if (result.error) throw new Error(`The Paseo command did not finish: ${result.error}.`);
    if (result.status !== 0) throw new Error(`The Paseo command failed: ${firstLine(result.stderr) || firstLine(result.stdout) || `exit code ${result.status}`}`);
    return;
  }
  const looked = [...tried, ...notes];
  throw new Error(`Could not find the Paseo command to rename the chat.${looked.length > 0 ? ` Looked for: ${looked.join("; ")}.` : ""}`);
}
