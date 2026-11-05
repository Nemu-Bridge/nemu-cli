import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { project_file } from "../src/commands/hook.js";

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const SESSION = "s1";
let directory = "";
let root = "";

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "nemu-cli-hook-"));
  root = join(directory, "repo");
  await mkdir(join(directory, "config", "sessions"), { recursive: true });
  await mkdir(root, { recursive: true });
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

function state_file(): string {
  return join(directory, "config", "sessions", `claude-code-${SESSION}.json`);
}

async function start_state(): Promise<void> {
  await writeFile(
    state_file(),
    JSON.stringify({
      cwd: root,
      root,
      branch: "main",
      files: [],
      since_checkpoint: [],
      edits_since_checkpoint: 0,
      last_asked_at: null,
      compacted: false,
      updated_at: Date.now(),
    }),
  );
}

function run_hook(event: string, input: Record<string, unknown>): string {
  const result = spawnSync("bun", [ENTRY, "hook", event, "--client", "claude-code"], {
    input: JSON.stringify({ session_id: SESSION, cwd: root, ...input }),
    env: { ...process.env, NEMU_CONFIG_DIR: join(directory, "config"), NEMU_NO_UPDATE_CHECK: "1" },
    encoding: "utf-8",
  });
  return result.stdout.trim();
}

function edit(file: string): string {
  return run_hook("tool", { tool_name: "Edit", tool_input: { file_path: file } });
}

describe("project files", () => {
  test("keeps files inside the project, relative and with forward slashes", () => {
    expect(project_file("/repo", "/repo", "/repo/src/a.ts")).toBe("src/a.ts");
    expect(project_file("/repo", "/repo/src", "b.ts")).toBe("src/b.ts");
  });

  test("drops files outside it, like an agent's scratchpad", () => {
    expect(project_file("/repo", "/repo", "/tmp/claude/scratchpad/gen.mjs")).toBeNull();
    expect(project_file("/repo", "/repo", "../other/x.ts")).toBeNull();
    expect(project_file("/repo", "/repo", "/repo")).toBeNull();
  });
});

describe("asking for a handoff", () => {
  test("scratchpad edits never count", async () => {
    await start_state();
    for (const name of ["a", "b", "c", "d"]) expect(edit(join(directory, "scratch", `${name}.mjs`))).toBe("");
    expect(run_hook("stop", {})).toBe("");
  });

  test("the third project edit adds a quiet note, once", async () => {
    await start_state();
    expect(edit(join(root, "a.ts"))).toBe("");
    expect(edit(join(root, "b.ts"))).toBe("");
    const output = JSON.parse(edit(join(root, "c.ts")));
    expect(output.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(output.hookSpecificOutput.additionalContext).toContain("handoff/main");
    expect(output.hookSpecificOutput.additionalContext).not.toContain("Do not mention");
    expect(edit(join(root, "d.ts"))).toBe("");
  });

  test("Stop asks once per session while the work is unsaved", async () => {
    const output = JSON.parse(run_hook("stop", {}));
    expect(output.decision).toBe("block");
    expect(output.reason).toContain("a.ts");
    for (const name of ["e", "f", "g"]) edit(join(root, `${name}.ts`));
    await writeFile(
      state_file(),
      JSON.stringify({ ...JSON.parse(await readFile(state_file(), "utf-8")), last_asked_at: 0 }),
    );
    expect(run_hook("stop", {})).toBe("");
  });

  test("saving with memory_write means Stop has nothing to ask", async () => {
    await start_state();
    for (const name of ["a", "b", "c"]) edit(join(root, `${name}.ts`));
    expect(run_hook("tool", { tool_name: "mcp__nemu__memory_write", tool_input: { name: "handoff/main" } })).toBe("");
    expect(run_hook("stop", {})).toBe("");
    const state = JSON.parse(await readFile(state_file(), "utf-8"));
    expect(state.since_checkpoint).toEqual([]);
    expect(state.files).toEqual(["a.ts", "b.ts", "c.ts"]);
  });
});
