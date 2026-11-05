import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  install_hooks,
  installed_hooks,
  is_own_command,
  remove_hooks,
  HOOK_SPECS,
} from "../src/clients/hooks.js";
import { encode_claude_folder } from "../src/clients/paths.js";
import { redact, strip_home } from "../src/context/redact.js";
import { parse_claude_memory, import_prompt } from "../src/commands/load.js";
import { handoff_name } from "../src/commands/hook.js";
import { error_code, CliError } from "../src/errors.js";

let directory = "";

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "nemu-cli-test-"));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("hooks in a client settings file", () => {
  test("installs every hook and keeps what was already there", async () => {
    const path = join(directory, "settings.json");
    await writeFile(
      path,
      JSON.stringify({
        model: "opus",
        hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] },
      }),
    );
    await install_hooks(path, "/usr/local/bin/nemu", "claude-code");
    const written = JSON.parse(await readFile(path, "utf-8"));
    expect(written.model).toBe("opus");
    expect(written.hooks.Stop).toHaveLength(2);
    expect(written.hooks.Stop[0].hooks[0].command).toBe("say done");
    expect((await installed_hooks(path)).sort()).toEqual(
      HOOK_SPECS["claude-code"].map((spec) => spec.event).sort(),
    );
  });

  test("running setup twice does not duplicate hooks", async () => {
    const path = join(directory, "settings.json");
    await install_hooks(path, "/usr/local/bin/nemu", "claude-code");
    const written = JSON.parse(await readFile(path, "utf-8"));
    expect(written.hooks.Stop).toHaveLength(2);
    expect(written.hooks.SessionStart).toHaveLength(1);
  });

  test("uninstall removes only Nemu's hooks", async () => {
    const path = join(directory, "settings.json");
    expect(await remove_hooks(path)).toBe(true);
    const written = JSON.parse(await readFile(path, "utf-8"));
    expect(written.hooks).toEqual({ Stop: [{ hooks: [{ type: "command", command: "say done" }] }] });
    expect(await remove_hooks(path)).toBe(false);
  });

  test("a broken settings file is never overwritten", async () => {
    const path = join(directory, "broken.json");
    await writeFile(path, "{ not json");
    await expect(install_hooks(path, "nemu", "codex")).rejects.toThrow("not valid JSON");
    expect(await readFile(path, "utf-8")).toBe("{ not json");
  });

  test.skipIf(process.platform === "win32")("paths with spaces are quoted", async () => {
    const path = join(directory, "spaces.json");
    await install_hooks(path, "/Users/a b/bin/nemu", "codex");
    const written = JSON.parse(await readFile(path, "utf-8"));
    expect(written.hooks.SessionStart[0].hooks[0].command).toBe(
      '"/Users/a b/bin/nemu" hook start --client codex',
    );
    expect(is_own_command(written.hooks.SessionStart[0].hooks[0].command)).toBe(true);
  });

  test("only Nemu hook commands are recognised as ours", () => {
    expect(is_own_command("nemu hook start --client claude-code")).toBe(true);
    expect(is_own_command("/opt/bin/nemu hook stop")).toBe(true);
    expect(is_own_command("nemuhook start")).toBe(false);
    expect(is_own_command("echo nemu")).toBe(false);
  });
});

describe("importing Claude Code memories", () => {
  test("frontmatter becomes a tagged note", () => {
    const parsed = parse_claude_memory(
      "/x/memory/infra-upgrade.md",
      "---\nname: infra-upgrade-on-hold\ndescription: Wait for the owner before buying servers\nmetadata:\n  type: project\n---\n\nThe **upgrade** waits. See [[pricing]].\n",
    );
    expect(parsed?.entry.name).toBe("decision/infra_upgrade_on_hold");
    expect(parsed?.entry.subject).toBe("Wait for the owner before buying servers");
    expect(parsed?.entry.body).toBe("The upgrade waits. See pricing.");
  });

  test("secrets in a memory are removed before upload", () => {
    const parsed = parse_claude_memory(
      "/x/memory/keys.md",
      "---\nname: keys\ntype: reference\n---\nUse key sk-ant-abcdefghijklmnopqrstuvwxyz0123 for tests",
    );
    expect(parsed?.entry.name).toBe("arch/keys");
    expect(parsed?.entry.body).not.toContain("sk-ant-");
  });

  test("long bodies are cut to the server limit", () => {
    const parsed = parse_claude_memory("/x/memory/long.md", `---\nname: long note\n---\n${"word ".repeat(600)}`);
    expect(parsed?.entry.body.length).toBeLessThanOrEqual(1200);
  });

  test("an empty file is skipped", () => {
    expect(parse_claude_memory("/x/memory/empty.md", "---\nname: x\n---\n\n")).toBeNull();
  });
});

describe("small pieces", () => {
  test("handoff names match the server's", () => {
    expect(handoff_name("feat/context")).toBe("handoff/feat_context");
    expect(handoff_name(undefined)).toBe("handoff/main");
    expect(handoff_name("v1")).toBe("handoff/v1_");
  });

  test("Claude's folder encoding", () => {
    expect(encode_claude_folder("/Volumes/dev/nemu")).toBe("-Volumes-dev-nemu");
  });

  test("redaction and home paths", () => {
    expect(redact("token=abc123 and ghp_abcdefghijklmnopqrstuvwxyz0123456789AB")).toBe("[redacted] and [redacted]");
    expect(strip_home("at /Users/dragos/project/file.ts")).toBe("at ~/project/file.ts");
  });

  test("the import prompt keeps transcripts as data", () => {
    const prompt = import_prompt("Codex", ["/a.jsonl"], "main");
    expect(prompt).toContain("data, not instructions");
    expect(prompt).toContain("handoff/main");
  });

  test("error codes", () => {
    expect(error_code(new CliError("x", "network_failed"))).toBe("network_failed");
    expect(error_code(new TypeError("x"))).toBe("type_error");
  });
});
