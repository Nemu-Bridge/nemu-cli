import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hook_command, hooks_outdated, installed_hooks, refresh_hooks } from "../src/clients/hooks.js";
import { EDITORS, editor_outdated, refresh_editor } from "../src/clients/editors.js";
import { migrations_due, run_migrations, type Migration } from "../src/migrations.js";
import { VERSION } from "../src/version.js";

const NEMU = "C:\\Users\\Ana\\AppData\\Roaming\\npm\\nemu.cmd";
const OLD = `"C:\\\\Users\\\\Ana\\\\AppData\\\\Roaming\\\\npm\\\\nemu.cmd"`;
let directory = "";
let home = "";
const saved_home = process.env.HOME;
const saved_profile = process.env.USERPROFILE;
const saved_bin = process.env.NEMU_BIN;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "nemu-cli-migrations-"));
  home = join(directory, "home");
  await mkdir(home, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.NEMU_BIN = "/usr/local/bin/nemu";
});

afterAll(async () => {
  process.env.HOME = saved_home;
  if (saved_profile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = saved_profile;
  if (saved_bin === undefined) delete process.env.NEMU_BIN;
  else process.env.NEMU_BIN = saved_bin;
  await rm(directory, { recursive: true, force: true });
});

function codex_hooks(command_for: (hook: string) => string, events = ["SessionStart", "PostToolUse", "Stop", "PreCompact", "SessionEnd"]) {
  const hook_of: Record<string, string> = { SessionStart: "start", PostToolUse: "tool", Stop: "stop", PreCompact: "compact", SessionEnd: "end" };
  const hooks: Record<string, unknown[]> = {};
  for (const event of events) {
    hooks[event] = [{ hooks: [{ type: "command", command: command_for(hook_of[event] ?? "start"), timeout: 5 }] }];
  }
  return { hooks };
}

describe("refreshing hooks", () => {
  test("rewrites the broken Windows Codex hooks and keeps other hooks", async () => {
    const path = join(directory, "codex-old.json");
    const config = codex_hooks((hook) => `${OLD} hook ${hook} --client codex`);
    (config.hooks.SessionStart as unknown[]).push({ hooks: [{ type: "command", command: "my-own.exe" }] });
    await writeFile(path, JSON.stringify(config, null, 2));
    expect(await hooks_outdated(path, NEMU, "codex", "win32")).toBe(true);
    expect(await refresh_hooks(path, NEMU, "codex", "win32")).toBe(true);
    const text = await readFile(path, "utf-8");
    expect(text).toContain(JSON.stringify(hook_command(NEMU, "start", "codex", "win32")));
    expect(text).toContain("my-own.exe");
    expect(text).not.toContain('\\"C:');
    expect(await hooks_outdated(path, NEMU, "codex", "win32")).toBe(false);
    expect(await refresh_hooks(path, NEMU, "codex", "win32")).toBe(false);
  });

  test("does nothing when the hooks already match", async () => {
    const path = join(directory, "codex-current.json");
    const config = codex_hooks((hook) => hook_command("/usr/local/bin/nemu", hook as "start", "codex", "darwin"));
    for (const [event, groups] of Object.entries(config.hooks)) {
      const timeouts: Record<string, number> = { SessionStart: 20, PostToolUse: 5, Stop: 10, PreCompact: 5, SessionEnd: 3 };
      (groups[0] as { hooks: { timeout: number }[]; matcher?: string }).hooks[0]!.timeout = timeouts[event] ?? 5;
      if (event === "SessionStart") (groups[0] as { matcher?: string }).matcher = "^(startup|resume|clear|compact)$";
    }
    const text = JSON.stringify(config, null, 2);
    await writeFile(path, text);
    expect(await hooks_outdated(path, "/usr/local/bin/nemu", "codex", "darwin")).toBe(false);
    expect(await refresh_hooks(path, "/usr/local/bin/nemu", "codex", "darwin")).toBe(false);
    expect(await readFile(path, "utf-8")).toBe(text);
  });

  test("never adds back hooks the user removed", async () => {
    const path = join(directory, "codex-partial.json");
    await writeFile(path, JSON.stringify(codex_hooks((hook) => `${OLD} hook ${hook} --client codex`, ["SessionStart"]), null, 2));
    await refresh_hooks(path, NEMU, "codex", "win32");
    expect(await installed_hooks(path)).toEqual(["SessionStart"]);
  });

  test("a client with no Nemu hooks is never touched", async () => {
    const path = join(directory, "none.json");
    const text = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "other" }] }] } });
    await writeFile(path, text);
    expect(await hooks_outdated(path, NEMU, "codex", "win32")).toBe(false);
    expect(await refresh_hooks(path, NEMU, "codex", "win32")).toBe(false);
    expect(await readFile(path, "utf-8")).toBe(text);
  });
});

describe("refreshing editor entries", () => {
  test("updates an outdated entry and ignores key order", async () => {
    await mkdir(join(home, ".cursor"), { recursive: true });
    const path = EDITORS.cursor.config_path();
    await writeFile(path, '{ "mcpServers": { "nemu": { "args": ["mcp", "--client", "cursor"], "command": "/usr/local/bin/nemu" } } }\n');
    expect(await editor_outdated(EDITORS.cursor, "/usr/local/bin/nemu")).toBe(false);
    expect(await editor_outdated(EDITORS.cursor, "/opt/homebrew/bin/nemu")).toBe(true);
    expect(await refresh_editor(EDITORS.cursor, "/opt/homebrew/bin/nemu")).toBe(true);
    expect(await editor_outdated(EDITORS.cursor, "/opt/homebrew/bin/nemu")).toBe(false);
  });

  test("an editor without Nemu is left alone", async () => {
    expect(await editor_outdated(EDITORS.windsurf, "/usr/local/bin/nemu")).toBe(false);
  });
});

describe("running migrations", () => {
  test("applies only what is needed and reports failures without stopping", async () => {
    const ran: string[] = [];
    const migrations: Migration[] = [
      { id: "a", label: "A changed", needed: async () => true, apply: async () => (ran.push("a"), true) },
      { id: "b", label: "B already fine", needed: async () => false, apply: async () => (ran.push("b"), true) },
      { id: "c", label: "C broke", needed: async () => true, apply: async () => { throw new Error("boom"); } },
      { id: "d", label: "D changed", needed: async () => true, apply: async () => (ran.push("d"), true) },
    ];
    const report = await run_migrations(migrations);
    expect(ran).toEqual(["a", "d"]);
    expect(report).toEqual({ applied: ["A changed", "D changed"], failed: ["C broke"] });
  });

  test("runs once per version and never inside hooks or the MCP bridge", () => {
    expect(migrations_due("status", undefined)).toBe(true);
    expect(migrations_due("status", "0.0.1")).toBe(true);
    expect(migrations_due("status", VERSION)).toBe(false);
    expect(migrations_due("hook", undefined)).toBe(false);
    expect(migrations_due("mcp", undefined)).toBe(false);
    expect(migrations_due("session-start", undefined)).toBe(true);
  });
});
