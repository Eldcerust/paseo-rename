import { describe, expect, it } from "vitest";
import { planRename, renameAgentWithCli, type CliEnvironment, type Invocation, type RunCli, type RunResult } from "./cli";

const APP = "C:\\Program Files\\Paseo\\Paseo.exe";
const RESOURCES = "C:\\Program Files\\Paseo\\resources";
const RUNNER = `${RESOURCES}\\app.asar.unpacked\\dist\\daemon\\node-entrypoint-runner.js`;
const CLI_INDEX = `${RESOURCES}\\app.asar\\node_modules\\@getpaseo\\cli\\dist\\index.js`;
const WINDOWS_INSTALL = [APP, `${RESOURCES}\\app.asar`, RUNNER];

function environment(overrides: Partial<CliEnvironment> & { files?: string[] } = {}): CliEnvironment {
  const files = new Set(overrides.files ?? []);
  return {
    platform: overrides.platform ?? "win32",
    execPath: overrides.execPath ?? "C:\\Program Files\\nodejs\\node.exe",
    env: overrides.env ?? {},
    exists: (path) => files.has(path),
  };
}

const ID = "826ed8f4-dbb8-4b00-a73a-ece3c85cbe88";

describe("planRename: where the command comes from", () => {
  it("starts the app's own executable directly, with an argument list and no shell, when this process is the app", () => {
    const { candidates } = planRename(environment({ execPath: APP, files: WINDOWS_INSTALL }), ID, "Fix the archive button");
    expect(candidates[0]).toMatchObject({
      command: APP,
      shell: false,
      args: ["--disable-warning=DEP0040", RUNNER, "node-script", CLI_INDEX, "agent", "update", ID, "--name", "Fix the archive button"],
    });
    expect(candidates[0]?.env).toMatchObject({ ELECTRON_RUN_AS_NODE: "1", PASEO_NODE_ENV: "production" });
  });

  it("finds the app from the PASEO_CLI shim when this process is plain Node", () => {
    const { candidates } = planRename(environment({ env: { PASEO_CLI: `${RESOURCES}\\bin\\paseo.cmd` }, files: WINDOWS_INSTALL }), ID, "Fix the archive button");
    expect(candidates[0]).toMatchObject({ command: APP, shell: false });
  });

  it("finds the app in the usual install folders", () => {
    const local = "C:\\Users\\Alvin\\AppData\\Local\\Programs\\Paseo";
    const files = [`${local}\\Paseo.exe`, `${local}\\resources\\app.asar`, `${local}\\resources\\app.asar.unpacked\\dist\\daemon\\node-entrypoint-runner.js`];
    const { candidates } = planRename(environment({ env: { ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\Alvin\\AppData\\Local" }, files }), ID, "Fix the archive button");
    const direct = candidates.filter((candidate) => !candidate.shell);
    expect(direct).toHaveLength(1);
    expect(direct[0]?.command).toBe(`${local}\\Paseo.exe`);
    expect(candidates[0]).toBe(direct[0]);
  });

  it("does not offer an app whose files are not all there", () => {
    const { candidates } = planRename(environment({ execPath: APP, files: [APP] }), ID, "Fix the archive button");
    expect(candidates.filter((candidate) => candidate.command === APP)).toEqual([]);
  });

  it("finds the app on macOS from its own executable", () => {
    const app = "/Applications/Paseo.app/Contents/MacOS/Paseo";
    const resources = "/Applications/Paseo.app/Contents/Resources";
    const files = [app, `${resources}/app.asar`, `${resources}/app.asar.unpacked/dist/daemon/node-entrypoint-runner.js`];
    const { candidates } = planRename(environment({ platform: "darwin", execPath: app, files }), ID, "Fix the archive button");
    expect(candidates[0]).toMatchObject({ command: app, shell: false });
    expect(candidates[0]?.args[1]).toBe(`${resources}/app.asar.unpacked/dist/daemon/node-entrypoint-runner.js`);
  });

  it("falls back to paseo on PATH without a shell on Linux and macOS", () => {
    const { candidates } = planRename(environment({ platform: "linux", execPath: "/usr/bin/node" }), ID, "Fix the archive button");
    expect(candidates).toEqual([expect.objectContaining({ command: "paseo", shell: false, args: ["agent", "update", ID, "--name", "Fix the archive button"] })]);
  });

  it("adds --home when PASEO_HOME is set", () => {
    const { candidates } = planRename(environment({ execPath: APP, files: WINDOWS_INSTALL, env: { PASEO_HOME: "D:\\paseo-home" } }), ID, "Fix the archive button");
    expect(candidates[0]?.args.slice(-2)).toEqual(["--home", "D:\\paseo-home"]);
  });
});

describe("planRename: what is allowed on a command line", () => {
  it("hands a title full of shell characters over as one untouched argument on the shell-free path", () => {
    const title = 'Fix "archive" & 100% | done ^ <now> é 修复';
    const { candidates } = planRename(environment({ execPath: APP, files: WINDOWS_INSTALL }), ID, title);
    expect(candidates[0]?.shell).toBe(false);
    expect(candidates[0]?.args.at(-1)).toBe(title);
    expect(candidates[0]?.args.filter((arg) => arg === title)).toHaveLength(1);
  });

  it("uses paseo.cmd through a shell only for a title made of safe characters, quoted", () => {
    const { candidates, notes } = planRename(environment(), ID, "Fix the archive button (v2): part 1/2");
    expect(candidates).toEqual([expect.objectContaining({ shell: true, args: [], command: `paseo agent update ${ID} --name "Fix the archive button (v2): part 1/2"` })]);
    expect(notes).toEqual([]);
  });

  it("never sends an unsafe title through a shell, and says why", () => {
    for (const title of ['say "hi"', "100% done", "a & b", "a | b", "a ^ b", "a < b", "price in €", "line\\", "wait!"]) {
      const { candidates, notes } = planRename(environment(), ID, title);
      expect(candidates, title).toEqual([]);
      expect(notes.join(" "), title).toContain("cannot be passed safely through a shell");
    }
  });

  it("refuses a chat id or a title that no command may carry", () => {
    const env = environment({ execPath: APP, files: WINDOWS_INSTALL });
    for (const id of ["", "a b", "x&calc", "id\n", "a".repeat(200)]) expect(() => planRename(env, id, "Fine title"), id).toThrow("chat id");
    for (const title of ["", "   ", "tab\there", "a".repeat(201), "bell\u0007"]) expect(() => planRename(env, ID, title)).toThrow("That title cannot be passed");
  });
});

describe("renameAgentWithCli", () => {
  const winApp = () => environment({ execPath: APP, files: WINDOWS_INSTALL });
  const ok: RunResult = { status: 0, stdout: "", stderr: "" };
  const runWith = (...results: RunResult[]) => {
    const seen: Invocation[] = [];
    const run: RunCli = async (invocation) => {
      seen.push(invocation);
      return results[seen.length - 1] ?? ok;
    };
    return { run, seen };
  };

  it("succeeds when the first command exits 0", async () => {
    const { run, seen } = runWith(ok);
    await renameAgentWithCli(winApp(), run, ID, "Fix the archive button");
    expect(seen).toHaveLength(1);
  });

  it("moves on to the next candidate when a program is missing", async () => {
    const files = [...WINDOWS_INSTALL, "/Applications/x"];
    const { run, seen } = runWith({ status: null, stdout: "", stderr: "spawn ENOENT", error: "missing" }, ok);
    await renameAgentWithCli(environment({ execPath: APP, files, env: { PASEO_CLI: `${RESOURCES}\\bin\\paseo.cmd` } }), run, ID, "Fix the archive button");
    expect(seen).toHaveLength(2);
    expect(seen[1]?.shell).toBe(true);
  });

  it("stops at the first command that runs and fails, reporting its first error line", async () => {
    const { run, seen } = runWith({ status: 1, stdout: "", stderr: "\nError: agent not found\nstack...\n" });
    await expect(renameAgentWithCli(winApp(), run, ID, "Fix the archive button")).rejects.toThrow("The Paseo command failed: Error: agent not found");
    expect(seen).toHaveLength(1);
  });

  it("reports a command that timed out", async () => {
    const { run } = runWith({ status: null, stdout: "", stderr: "", error: "timeout" });
    await expect(renameAgentWithCli(winApp(), run, ID, "Fix the archive button")).rejects.toThrow("The Paseo command did not finish: timeout.");
  });

  it("treats a shell's 'not recognized' as a missing program, not as a failed rename", async () => {
    const { run } = runWith({ status: 1, stdout: "", stderr: "'paseo' is not recognized as an internal or external command" });
    await expect(renameAgentWithCli(environment(), run, ID, "Fix the archive button")).rejects.toThrow("Could not find the Paseo command to rename the chat. Looked for: paseo.cmd on PATH.");
  });

  it("says what it looked for when nothing can be found, including a title it would not send to a shell", async () => {
    const { run, seen } = runWith();
    await expect(renameAgentWithCli(environment(), run, ID, "100% done")).rejects.toThrow(/Could not find the Paseo command to rename the chat\. Looked for: .*cannot be passed safely through a shell/);
    expect(seen).toHaveLength(0);
  });
});
