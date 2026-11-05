import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  has_quoted_program,
  hook_command,
  install_hooks,
  installed_hooks,
  is_own_command,
  needs_repair,
} from "../src/clients/hooks.js";

const PLAIN = "C:\\Users\\Ana\\AppData\\Roaming\\npm\\nemu.cmd";
const SPACED = "C:\\Users\\Ana Maria\\AppData\\Roaming\\npm\\nemu.cmd";
let directory = "";

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "nemu-cli-winhooks-"));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("hook commands for Codex on Windows", () => {
  test("never start with a quoted program, which Codex cannot launch", () => {
    expect(hook_command(PLAIN, "start", "codex", "win32")).toBe(`${PLAIN} hook start --client codex`);
    expect(hook_command(SPACED, "stop", "codex", "win32")).toBe("nemu.cmd hook stop --client codex");
    expect(hook_command("C:\\Tools&Co\\nemu.cmd", "tool", "codex", "win32")).toBe("nemu.cmd hook tool --client codex");
    for (const nemu of [PLAIN, SPACED]) {
      expect(hook_command(nemu, "start", "codex", "win32")).not.toMatch(/^["']/);
    }
  });

  test("Claude Code and other systems keep the shell quoted form", () => {
    expect(hook_command(PLAIN, "start", "claude-code", "win32")).toMatch(/^"C:/);
    expect(hook_command("/usr/local/bin/nemu", "start", "codex", "darwin")).toBe("/usr/local/bin/nemu hook start --client codex");
  });

  test("old and new forms are both recognised as Nemu's own", () => {
    const old = `"C:\\\\Users\\\\Ana\\\\AppData\\\\Roaming\\\\npm\\\\nemu.cmd" hook start --client codex`;
    expect(is_own_command(old)).toBe(true);
    expect(has_quoted_program(old)).toBe(true);
    expect(is_own_command(hook_command(PLAIN, "start", "codex", "win32"))).toBe(true);
    expect(is_own_command("nemu.cmd hook end --client codex")).toBe(true);
    expect(has_quoted_program(hook_command(PLAIN, "start", "codex", "win32"))).toBe(false);
    expect(has_quoted_program('"C:\\\\other\\\\tool.exe" --flag')).toBe(false);
  });

  test("setup again replaces the broken hooks and keeps other hooks", async () => {
    const path = join(directory, "hooks.json");
    const broken = {
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "my-own-hook.exe" }] },
          { matcher: "^(startup)$", hooks: [{ type: "command", command: `"C:\\\\Users\\\\Ana\\\\AppData\\\\Roaming\\\\npm\\\\nemu.cmd" hook start --client codex`, timeout: 20 }] },
        ],
      },
    };
    await writeFile(path, JSON.stringify(broken, null, 2));
    expect(await needs_repair(path, "win32")).toBe(true);
    expect(await needs_repair(path, "darwin")).toBe(false);
    await install_hooks(path, PLAIN, "codex", "win32");
    const text = await readFile(path, "utf-8");
    expect(text).toContain("my-own-hook.exe");
    expect(text).not.toContain('\\"C:');
    expect(text).toContain(`"command": ${JSON.stringify(`${PLAIN} hook start --client codex`)}`);
    expect(await needs_repair(path, "win32")).toBe(false);
    expect(await installed_hooks(path)).toEqual(["SessionStart", "PostToolUse", "Stop", "PreCompact", "SessionEnd"]);
  });
});
