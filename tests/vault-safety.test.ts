import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { write_atomic_file } from "../src/vault/files.js";
import { is_default_ignored } from "../src/vault/ignore.js";

let directory = "";
let root = "";
let outside = "";

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "nemu-vault-safety-"));
  root = join(directory, "vault");
  outside = join(directory, "outside");
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("files a vault may not place", () => {
  test("agent and editor config folders never sync", () => {
    expect(is_default_ignored(".claude/settings.json", false)).toBe(true);
    expect(is_default_ignored(".vscode/tasks.json", false)).toBe(true);
    expect(is_default_ignored("notes/.idea/workspace.xml", false)).toBe(true);
    expect(is_default_ignored(".github/workflows/ci.yml", false)).toBe(true);
    expect(is_default_ignored(".github/ISSUE_TEMPLATE.md", false)).toBe(false);
    expect(is_default_ignored("Notes/Claude.md", false)).toBe(false);
  });

  test.skipIf(process.platform === "win32")("a pulled note is never written through a symlinked folder", async () => {
    await symlink(outside, join(root, "linked"));
    const written = await write_atomic_file(root, "linked/escape.md", new TextEncoder().encode("x"), null);
    expect(written).toBe(false);
    expect(await readdir(outside)).toEqual([]);
  });

  test("a normal note is written inside the vault", async () => {
    const written = await write_atomic_file(root, "inside/ok.md", new TextEncoder().encode("ok"), null);
    expect(written).toBe(true);
  });
});
