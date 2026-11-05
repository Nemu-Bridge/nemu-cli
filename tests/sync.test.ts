import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultApi } from "../src/vault/api.js";
import { run_sync, type SyncReport } from "../src/vault/engine.js";
import { mass_delete_blocked, plan_sync } from "../src/vault/plan.js";
import { is_ignored, parse_ignore } from "../src/vault/ignore.js";
import { check_path, conflict_path, is_conflict_copy, numbered_path } from "../src/vault/paths.js";
import { lock_path, write_marker, type DeviceSettings } from "../src/vault/state.js";
import { CliError } from "../src/errors.js";
import { FakeVault } from "./support/fake-vault.js";

let scratch = "";

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "nemu-sync-test-"));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

interface Device {
  name: string;
  root: string;
  state_path: string;
  api: VaultApi;
}

let counter = 0;

async function device(vault: FakeVault, name: string): Promise<Device> {
  counter += 1;
  const root = join(scratch, `${name}-${counter}`);
  await mkdir(root, { recursive: true });
  await write_marker(root, {
    version: 1,
    vault_id: vault.id,
    vault_name: "Test",
    workspace_id: "ws_test",
    server: "http://localhost:3002",
    linked_at: new Date().toISOString(),
  });
  return {
    name,
    root,
    state_path: join(scratch, `state-${name}-${counter}.json`),
    api: new VaultApi(vault.transport, vault.id, `test ${name}`),
  };
}

function sync(
  target: Device,
  options: { allow_deletes?: boolean; dry_run?: boolean; settings?: Partial<DeviceSettings>; quiet_ms?: number } = {},
): Promise<SyncReport> {
  return run_sync({
    root: target.root,
    api: target.api,
    state_path: target.state_path,
    device: target.name,
    quiet_ms: options.quiet_ms ?? 0,
    now: () => new Date(2026, 9, 27, 14, 3),
    ...options,
  });
}

async function put(target: Device, path: string, content: string | Buffer): Promise<void> {
  const full = join(target.root, ...path.split("/"));
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, content);
}

async function files(target: Device): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const walk = async (relative: string) => {
    const entries = await readdir(join(target.root, relative), { withFileTypes: true });
    for (const entry of entries) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (path === ".nemu") continue;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) found.set(path.normalize("NFC"), await readFile(join(target.root, path), "utf-8"));
    }
  };
  await walk("");
  return found;
}

function sorted(map: Map<string, string>): [string, string][] {
  return [...map.entries()].sort(([left], [right]) => (left < right ? -1 : 1));
}

describe("paths and ignore rules", () => {
  test("Windows names are refused like the server refuses them", () => {
    expect(check_path("notes/CON.md").ok).toBe(false);
    expect(check_path("a:b.md").ok).toBe(false);
    expect(check_path("trailing.").ok).toBe(false);
    expect(check_path("x".repeat(241)).ok).toBe(false);
    expect(check_path(".nemu/vault.json").ok).toBe(false);
    expect(check_path("Notes/Ideas.md").ok).toBe(true);
  });

  test("NFD names compare equal to NFC names", () => {
    const nfd = "Café.md";
    const checked = check_path(nfd);
    expect(checked.ok && checked.path).toBe("Café.md");
  });

  test("conflict copies are named after the device and the minute", () => {
    const name = conflict_path("Notes/Plan.md", "Dragos's Mac", new Date(2026, 9, 27, 14, 3), () => false);
    expect(name).toBe("Notes/Plan (conflict, Dragos's Mac, 2026-10-27 14-03).md");
    expect(is_conflict_copy(name)).toBe(true);
    const second = conflict_path("Plan.md", "mac", new Date(2026, 9, 27, 14, 3), (key) => key === "plan (conflict, mac, 2026-10-27 14-03).md");
    expect(second).toBe("Plan (conflict, mac, 2026-10-27 14-03 2).md");
    expect(check_path(name).ok).toBe(true);
  });

  test("numbered names start at (2)", () => {
    expect(numbered_path("a/Note.md", () => false)).toBe("a/Note (2).md");
    expect(numbered_path("Note.md", (key) => key === "note (2).md")).toBe("Note (3).md");
  });

  test("default ignores and .nemuignore", () => {
    const plain = { obsidian: false, obsidian_plugins: false, rules: parse_ignore("drafts/\n*.log\n!keep.log\n/root-only.md\n") };
    expect(is_ignored(".obsidian/app.json", plain)).toBe(true);
    expect(is_ignored(".obsidian/workspace.json", { obsidian: true, obsidian_plugins: false, rules: [] })).toBe(true);
    expect(is_ignored(".obsidian/workspace-mobile.json", { obsidian: true, obsidian_plugins: false, rules: [] })).toBe(true);
    expect(is_ignored(".obsidian/app.json", { obsidian: true, obsidian_plugins: false, rules: [] })).toBe(false);
    expect(is_ignored(".obsidian/plugins/dataview/main.js", { obsidian: true, obsidian_plugins: false, rules: [] })).toBe(true);
    expect(is_ignored(".obsidian/plugins", { obsidian: true, obsidian_plugins: false, rules: [] }, true)).toBe(true);
    expect(is_ignored(".obsidian/plugins/dataview/main.js", { obsidian: true, obsidian_plugins: true, rules: [] })).toBe(false);
    expect(is_ignored(".obsidian/themes/Minimal/theme.css", { obsidian: true, obsidian_plugins: false, rules: [] })).toBe(false);
    expect(is_ignored(".trash/old.md", plain)).toBe(true);
    expect(is_ignored("a/.DS_Store", plain)).toBe(true);
    expect(is_ignored("._Note.md", plain)).toBe(true);
    expect(is_ignored(".git/config", plain)).toBe(true);
    expect(is_ignored("x/node_modules/y.js", plain)).toBe(true);
    expect(is_ignored("drafts/a.md", plain)).toBe(true);
    expect(is_ignored("deep/drafts/a.md", plain)).toBe(true);
    expect(is_ignored("drafts", plain)).toBe(false);
    expect(is_ignored("drafts", plain, true)).toBe(true);
    expect(is_ignored("x/build.log", plain)).toBe(true);
    expect(is_ignored("keep.log", plain)).toBe(false);
    expect(is_ignored("root-only.md", plain)).toBe(true);
    expect(is_ignored("sub/root-only.md", plain)).toBe(false);
    expect(is_ignored("Notes/Idea.md", plain)).toBe(false);
  });

  test("the mass delete guard", () => {
    expect(mass_delete_blocked(0, 100)).toBe(false);
    expect(mass_delete_blocked(1, 5)).toBe(false);
    expect(mass_delete_blocked(2, 5)).toBe(false);
    expect(mass_delete_blocked(5, 5)).toBe(true);
    expect(mass_delete_blocked(2, 2)).toBe(true);
    expect(mass_delete_blocked(3, 20)).toBe(true);
    expect(mass_delete_blocked(10, 1000)).toBe(false);
    expect(mass_delete_blocked(11, 1000)).toBe(true);
  });

  test("a delete plus a create with the same hash is a move", () => {
    const plan = plan_sync({
      base: new Map([["a.md", { path: "a.md", note_id: "n1", version: 1, hash: "h" }]]),
      local: new Map([["b/a.md", { path: "b/a.md", disk: "b/a.md", hash: "h", size: 1 }]]),
      remote: new Map([["a.md", { path: "a.md", note_id: "n1", version: 1, hash: "h" }]]),
      skipped: new Set(),
      conflicts: "merge",
      device: "d",
      now: new Date(),
    });
    expect(plan.actions.filter((action) => action.kind === "move_remote")).toHaveLength(1);
    expect(plan.actions.some((action) => action.kind === "push" || action.kind === "delete_remote")).toBe(false);
  });
});

describe("nemu sync against a fake vault", () => {
  test("refuses a folder without the root marker", async () => {
    const vault = new FakeVault();
    const root = join(scratch, "unmarked");
    await mkdir(root, { recursive: true });
    const error = await run_sync({
      root,
      api: new VaultApi(vault.transport, vault.id, "t"),
      state_path: join(scratch, "unmarked.json"),
      device: "d",
    }).catch((caught: unknown) => caught);
    expect(error instanceof CliError && error.code).toBe("not_linked");
    expect(vault.requests).toBe(0);
  });

  test("two folders converge through the vault", async () => {
    const vault = new FakeVault();
    const a = await device(vault, "a");
    const b = await device(vault, "b");
    await put(a, "Inbox.md", "# Inbox\n");
    await put(a, "Projects/Plan.md", "plan\r\nwith crlf\r\n");
    await put(a, "img/pic.png", Buffer.from([0, 1, 2, 255]));
    const first = await sync(a);
    expect(first.pushed.sort()).toEqual(["Inbox.md", "Projects/Plan.md", "img/pic.png"]);
    await sync(b);
    expect(sorted(await files(b))).toEqual(sorted(await files(a)));
    expect(await readFile(join(b.root, "Projects", "Plan.md"), "utf-8")).toBe("plan\r\nwith crlf\r\n");
    const again = await sync(b);
    expect(again.pulled.length + again.pushed.length).toBe(0);
  });

  test("an edit on one device reaches the other", async () => {
    const vault = new FakeVault();
    const a = await device(vault, "a");
    const b = await device(vault, "b");
    await put(a, "Note.md", "one\n");
    await sync(a);
    await sync(b);
    await put(b, "Note.md", "two\n");
    await sync(b);
    const report = await sync(a);
    expect(report.pulled).toEqual(["Note.md"]);
    expect(await readFile(join(a.root, "Note.md"), "utf-8")).toBe("two\n");
  });

  test("edits to different parts of a note merge without a conflict", async () => {
    const vault = new FakeVault();
    const a = await device(vault, "a");
    const b = await device(vault, "b");
    await put(a, "Note.md", "1\n2\n3\n4\n5\n6\n");
    await sync(a);
    await sync(b);
    await put(a, "Note.md", "ONE\n2\n3\n4\n5\n6\n");
    await put(b, "Note.md", "1\n2\n3\n4\n5\nSIX\n");
    await sync(a);
    const report = await sync(b);
    expect(report.merged).toEqual(["Note.md"]);
    expect(report.conflicts).toHaveLength(0);
    await sync(a);
    expect(await readFile(join(a.root, "Note.md"), "utf-8")).toBe("ONE\n2\n3\n4\n5\nSIX\n");
    expect(await readFile(join(b.root, "Note.md"), "utf-8")).toBe("ONE\n2\n3\n4\n5\nSIX\n");
  });

  test("an automatic merge is recorded in the merge log with this device's text", async () => {
    const vault = new FakeVault();
    const a = await device(vault, "a");
    const b = await device(vault, "b");
    await put(a, "Note.md", "1\n2\n3\n4\n5\n6\n");
    await sync(a);
    await sync(b);
    await put(a, "Note.md", "ONE\n2\n3\n4\n5\n6\n");
    await put(b, "Note.md", "1\n2\n3\n4\n5\nSIX\n");
    await sync(a);
    const report = await sync(b);
    expect(report.merged).toEqual(["Note.md"]);
    expect(vault.merges).toHaveLength(1);
    const merge = vault.merges[0]!;
    const note = [...vault.notes.values()].find((entry) => entry.path === "Note.md")!;
    expect(merge.path).toBe("Note.md");
    expect(merge.merged_version).toBe(note.version);
    expect(merge.remote_version).toBe(note.version - 1);
    expect(merge.client).toBe("test b");
    expect(Buffer.from(merge.content, "base64").toString("utf-8")).toBe("1\n2\n3\n4\n5\nSIX\n");
    expect(note.versions.find((entry) => entry.version === merge.remote_version)?.content.toString("utf-8")).toBe(
      "ONE\n2\n3\n4\n5\n6\n",
    );
  });

  test("a merge log failure is reported and the sync still succeeds", async () => {
    const vault = new FakeVault();
    vault.refuse_merges = { status: 500, code: "internal_error" };
    const a = await device(vault, "a");
    const b = await device(vault, "b");
    await put(a, "Note.md", "1\n2\n3\n4\n5\n6\n");
    await sync(a);
    await sync(b);
    await put(a, "Note.md", "ONE\n2\n3\n4\n5\n6\n");
    await put(b, "Note.md", "1\n2\n3\n4\n5\nSIX\n");
    await sync(a);
    const report = await sync(b);
    expect(report.merged).toEqual(["Note.md"]);
    expect(report.notices.some((notice) => notice.includes("merge log"))).toBe(true);
    expect(vault.live().get("Note.md")).toBe("ONE\n2\n3\n4\n5\nSIX\n");
    const again = await sync(b);
    expect(again.merged).toHaveLength(0);
    expect(again.pushed).toHaveLength(0);
  });

  test("a merge that adds nothing to the vault's version is not logged", async () => {
    const vault = new FakeVault();
    const a = await device(vault, "a");
    const b = await device(vault, "b");
    await put(a, "Note.md", "1\n2\n3\n");
    await sync(a);
    await sync(b);
    await put(a, "Note.md", "1\n2\n3\n4\n");
    await put(b, "Note.md", "1\n2\n3\n4\n");
    await sync(a);
    await sync(b);
    expect(vault.merges).toHaveLength(0);
  });

  test("overlapping edits keep both, the remote keeps the path", async () => {
    const vault = new FakeVault();
    const a = await device(vault, "a");
    const b = await device(vault, "laptop");
    await put(a, "Note.md", "line\n");
    await sync(a);
    await sync(b);
    await put(a, "Note.md", "from a\n");
    await put(b, "Note.md", "from laptop\n");
    await sync(a);
    const report = await sync(b);
    const copy = "Note (conflict, laptop, 2026-10-27 14-03).md";
    expect(report.conflicts).toEqual([{ path: "Note.md", copy }]);
    await sync(a);
    for (const target of [a, b]) {
      const found = await files(target);
      expect(found.get("Note.md")).toBe("from a\n");
      expect(found.get(copy)).toBe("from laptop\n");
      for (const text of found.values()) expect(text.includes("<<<<<<<")).toBe(false);
    }
  });

  test("--conflicts=file writes a conflict file even when a merge would work", async () => {
    const vault = new FakeVault();
    const a = await device(vault, "a");
    const b = await device(vault, "b");
    await put(a, "Note.md", "1\n2\n3\n4\n");
    await sync(a);
    await sync(b);
    await put(a, "Note.md", "X\n2\n3\n4\n");
    await put(b, "Note.md", "1\n2\n3\nY\n");
    await sync(a);
    const report = await sync(b, { settings: { conflicts: "file" } });
    expect(report.merged).toHaveLength(0);
    expect(report.conflicts).toHaveLength(1);
    const later = await sync(b);
    expect(later.cycles).toBe(1);
  });

  test("binary files changed on both sides keep both", async () => {
    const vault = new FakeVault();
    const a = await device(vault, "a");
    const b = await device(vault, "b");
    await put(a, "pic.png", Buffer.from([1]));
    await sync(a);
    await sync(b);
    await put(a, "pic.png", Buffer.from([2]));
    await put(b, "pic.png", Buffer.from([3]));
    await sync(a);
    const report = await sync(b);
    expect(report.conflicts[0]?.copy).toBe("pic (conflict, b, 2026-10-27 14-03).png");
    expect([...(await readFile(join(b.root, "pic.png")))]).toEqual([2]);
  });

  test("an edit wins over a delete, in both directions", async () => {
    const vault = new FakeVault();
    const a = await device(vault, "a");
    const b = await device(vault, "b");
    await put(a, "Keep.md", "v1\n");
    await put(a, "Other.md", "v1\n");
    await sync(a);
    await sync(b);
    await rm(join(a.root, "Keep.md"));
    await put(b, "Keep.md", "v2 edited\n");
    await rm(join(b.root, "Other.md"));
    await put(a, "Other.md", "edited on a\n");
    await sync(a);
    await sync(b);
    await sync(a);
    expect(sorted(await files(a))).toEqual(sorted(await files(b)));
    expect((await files(a)).get("Keep.md")).toBe("v2 edited\n");
    expect((await files(a)).get("Other.md")).toBe("edited on a\n");
  });

  test("a delete reaches the other device", async () => {
    const vault = new FakeVault();
    const a = await device(vault, "a");
    const b = await device(vault, "b");
    await put(a, "x/Gone.md", "bye\n");
    await put(a, "Stay.md", "hi\n");
    await sync(a);
    await sync(b);
    await rm(join(a.root, "x", "Gone.md"));
    const report = await sync(a);
    expect(report.deleted_remote).toEqual(["x/Gone.md"]);
    const pulled = await sync(b);
    expect(pulled.deleted_local).toEqual(["x/Gone.md"]);
    expect([...(await files(b)).keys()]).toEqual(["Stay.md"]);
    await expect(stat(join(b.root, "x"))).rejects.toThrow();
  });

  test("a rename is sent as one move and keeps the note id", async () => {
    const vault = new FakeVault();
    const a = await device(vault, "a");
    const b = await device(vault, "b");
    await put(a, "Old.md", "content\n");
    await sync(a);
    await sync(b);
    const id = [...vault.notes.values()][0]!.id;
    await mkdir(join(a.root, "Folder"));
    await rm(join(a.root, "Old.md"));
    await put(a, "Folder/New.md", "content\n");
    const report = await sync(a);
    expect(report.moved).toEqual([{ from: "Old.md", to: "Folder/New.md" }]);
    expect(vault.notes.size).toBe(1);
    expect(vault.notes.get(id)?.path).toBe("Folder/New.md");
    const other = await sync(b);
    expect(other.moved).toEqual([{ from: "Old.md", to: "Folder/New.md" }]);
    expect([...(await files(b)).keys()]).toEqual(["Folder/New.md"]);
  });

  test("a rename on one device and an edit on another both apply", async () => {
    const vault = new FakeVault();
    const a = await device(vault, "a");
    const b = await device(vault, "b");
    await put(a, "Draft.md", "one\n");
    await sync(a);
    await sync(b);
    await rm(join(a.root, "Draft.md"));
    await put(a, "Final.md", "one\n");
    await put(b, "Draft.md", "one\ntwo\n");
    await sync(a);
    await sync(b);
    await sync(a);
    for (const target of [a, b]) {
      expect(sorted(await files(target))).toEqual([["Final.md", "one\ntwo\n"]]);
    }
    expect(vault.notes.size).toBe(1);
  });

  test("two devices renaming different notes onto one path: the second gets (2)", async () => {
    const vault = new FakeVault();
    const a = await device(vault, "a");
    const b = await device(vault, "b");
    await put(a, "One.md", "first\n");
    await put(a, "Two.md", "second\n");
    await sync(a);
    await sync(b);
    await rm(join(a.root, "One.md"));
    await put(a, "Same.md", "first\n");
    await rm(join(b.root, "Two.md"));
    await put(b, "Same.md", "second\n");
    await sync(a);
    const report = await sync(b);
    expect(report.notices.some((notice) => notice.includes("Same (2).md"))).toBe(true);
    await sync(a);
    const expected = [
      ["Same (2).md", "second\n"],
      ["Same.md", "first\n"],
    ];
    expect(sorted(await files(a))).toEqual(expected as [string, string][]);
    expect(sorted(await files(b))).toEqual(expected as [string, string][]);
    expect(vault.notes.size).toBe(2);
  });

  test("the same new file on two devices is adopted, not duplicated", async () => {
    const vault = new FakeVault();
    const a = await device(vault, "a");
    const b = await device(vault, "b");
    await put(a, "Same.md", "same\n");
    await put(b, "Same.md", "same\n");
    await sync(a);
    const report = await sync(b);
    expect(report.conflicts).toHaveLength(0);
    expect(report.pushed).toHaveLength(0);
    expect(vault.notes.size).toBe(1);
  });

  test("different new files at one path keep both", async () => {
    const vault = new FakeVault();
    const a = await device(vault, "a");
    const b = await device(vault, "b");
    await put(a, "Same.md", "from a\n");
    await put(b, "Same.md", "from b\n");
    await sync(a);
    const report = await sync(b);
    expect(report.conflicts).toHaveLength(1);
    await sync(a);
    expect(sorted(await files(a))).toEqual(sorted(await files(b)));
  });

  test("emptying the folder stops the sync and deletes nothing", async () => {
    const vault = new FakeVault();
    const a = await device(vault, "a");
    for (let index = 0; index < 20; index += 1) await put(a, `n${index}.md`, `note ${index}\n`);
    await sync(a);
    for (let index = 0; index < 20; index += 1) await rm(join(a.root, `n${index}.md`));
    const error = await sync(a).catch((caught: unknown) => caught);
    expect(error instanceof CliError && error.code).toBe("mass_delete");
    expect(vault.live().size).toBe(20);
    const allowed = await sync(a, { allow_deletes: true });
    expect(allowed.deleted_remote).toHaveLength(20);
    expect(vault.live().size).toBe(0);
  });

  test("a few deletes in a large vault are not blocked", async () => {
    const vault = new FakeVault();
    const a = await device(vault, "a");
    for (let index = 0; index < 30; index += 1) await put(a, `n${index}.md`, `note ${index}\n`);
    await sync(a);
    await rm(join(a.root, "n1.md"));
    await rm(join(a.root, "n2.md"));
    const report = await sync(a);
    expect(report.deleted_remote).toHaveLength(2);
  });

  test("a lock held by a live process refuses, a dead one is taken over", async () => {
    const vault = new FakeVault();
    const a = await device(vault, "a");
    const { hostname } = await import("node:os");
    await writeFile(lock_path(a.root), JSON.stringify({ pid: process.pid, host: hostname(), started_at: "x", token: "t" }));
    const error = await sync(a).catch((caught: unknown) => caught);
    expect(error instanceof CliError && error.code).toBe("sync_locked");
    await writeFile(lock_path(a.root), JSON.stringify({ pid: 2_147_000_000, host: hostname(), started_at: "x", token: "t" }));
    await put(a, "x.md", "x\n");
    const report = await sync(a);
    expect(report.pushed).toEqual(["x.md"]);
    await expect(stat(lock_path(a.root))).rejects.toThrow();
  });

  test("a file above one request's size goes up in parts when the plan allows it", async () => {
    const vault = new FakeVault();
    vault.max_file_bytes = 1000;
    vault.max_upload_file_bytes = 10_000;
    const a = await device(vault, "a");
    const big = Buffer.from(Array.from({ length: 2500 }, (_, index) => index % 251));
    await put(a, "art/map.png", big);
    await put(a, "huge.bin", Buffer.alloc(20_000));
    const report = await sync(a);
    expect(report.pushed).toEqual(["art/map.png"]);
    expect(vault.uploads.size).toBe(0);
    const stored = [...vault.notes.values()].find((note) => note.path === "art/map.png");
    expect(stored?.content.equals(big)).toBe(true);
    expect(report.skipped.map((entry) => entry.path)).toEqual(["huge.bin"]);

    const b = await device(vault, "b");
    await sync(b);
    expect((await readFile(join(b.root, "art/map.png"))).equals(big)).toBe(true);
  });

  test("ignored, symlinked, oversized and Windows-forbidden files are skipped and reported", async () => {
    const vault = new FakeVault();
    vault.max_file_bytes = 1000;
    const a = await device(vault, "a");
    await put(a, "Note.md", "ok\n");
    await put(a, ".obsidian/workspace.json", "{}");
    await put(a, ".obsidian/app.json", "{}");
    await put(a, ".DS_Store", "x");
    await put(a, "._Note.md", "x");
    await put(a, ".trash/old.md", "x");
    await put(a, "node_modules/x.js", "x");
    await put(a, "big.bin", Buffer.alloc(2000));
    await put(a, "CON.md", "reserved\n");
    await put(a, "trailing. ", "x");
    await put(a, "drafts/secret.md", "x");
    await put(a, ".nemuignore", "drafts/\n");
    await symlink(join(a.root, "Note.md"), join(a.root, "link.md"));
    const report = await sync(a);
    expect(report.pushed.sort()).toEqual([".nemuignore", "Note.md"]);
    const reasons = Object.fromEntries(report.skipped.map((entry) => [entry.path, entry.reason]));
    expect(reasons["link.md"]).toContain("symbolic link");
    expect(reasons["big.bin"]).toContain("above");
    expect(reasons["CON.md"]).toContain("reserves");
    expect(reasons["trailing. "]).toContain("dot or a space");
    const obsidian = await sync(a, { settings: { obsidian: true } });
    expect(obsidian.pushed).toEqual([".obsidian/app.json"]);
  });

  test("Obsidian plugins sync only on a device that turned them on, in both directions", async () => {
    const vault = new FakeVault();
    const a = await device(vault, "a");
    const b = await device(vault, "b");
    await put(a, ".obsidian/app.json", "{}");
    await put(a, ".obsidian/plugins/evil/main.js", "run()");
    const first = await sync(a, { settings: { obsidian: true } });
    expect(first.pushed).toEqual([".obsidian/app.json"]);
    const opted = await sync(a, { settings: { obsidian: true, obsidian_plugins: true } });
    expect(opted.pushed).toEqual([".obsidian/plugins/evil/main.js"]);
    await sync(b, { settings: { obsidian: true } });
    await expect(stat(join(b.root, ".obsidian/plugins/evil/main.js"))).rejects.toThrow();
    expect(await readFile(join(b.root, ".obsidian/app.json"), "utf-8")).toBe("{}");
    const off = await sync(a, { settings: { obsidian_plugins: false } });
    expect(off.deleted_remote).toEqual([]);
    expect(await readFile(join(a.root, ".obsidian/plugins/evil/main.js"), "utf-8")).toBe("run()");
  });

  test("NFD names are synced under their NFC path without a loop", async () => {
    const vault = new FakeVault();
    const a = await device(vault, "a");
    const b = await device(vault, "b");
    await put(a, "Café.md", "nfd\n");
    await sync(a);
    expect([...vault.live().keys()]).toEqual(["Café.md"]);
    await sync(b);
    const second = await sync(a);
    const third = await sync(b);
    expect(second.pushed.length + second.pulled.length + third.pushed.length + third.pulled.length).toBe(0);
    expect((await files(b)).get("Café.md")).toBe("nfd\n");
  });

  test("a stale cursor gets 410 and reconciles in full", async () => {
    const vault = new FakeVault();
    const a = await device(vault, "a");
    const b = await device(vault, "b");
    await put(a, "One.md", "1\n");
    await sync(a);
    await sync(b);
    await put(a, "Two.md", "2\n");
    await put(a, "One.md", "1 changed\n");
    await sync(a);
    vault.pruned_revision = vault.revision;
    const report = await sync(b);
    expect(report.full).toBe(true);
    expect(sorted(await files(b))).toEqual(sorted(await files(a)));
  });

  test("a lost state file reconciles without conflicts or duplicates", async () => {
    const vault = new FakeVault();
    const a = await device(vault, "a");
    await put(a, "One.md", "1\n");
    await put(a, "Two.md", "2\n");
    await sync(a);
    await rm(a.state_path);
    const report = await sync(a);
    expect(report.conflicts).toHaveLength(0);
    expect(report.pushed).toHaveLength(0);
    expect(vault.notes.size).toBe(2);
  });

  test("out of storage stops uploads and keeps downloading", async () => {
    const vault = new FakeVault();
    const a = await device(vault, "a");
    const b = await device(vault, "b");
    await put(a, "One.md", "1\n");
    await sync(a);
    vault.write("FromWeb.md", Buffer.from("web\n"));
    vault.refuse_write = { status: 413, code: "storage_full" };
    await put(a, "Two.md", "2\n");
    const report = await sync(a);
    expect(report.blocked?.code).toBe("storage_full");
    expect(report.pulled).toEqual(["FromWeb.md"]);
    expect(vault.live().has("Two.md")).toBe(false);
    vault.refuse_write = null;
    const later = await sync(a);
    expect(later.pushed).toEqual(["Two.md"]);
    await sync(b);
  });

  test("a revoked credential stops the sync and never deletes local files", async () => {
    const vault = new FakeVault();
    const a = await device(vault, "a");
    await put(a, "One.md", "1\n");
    await sync(a);
    vault.refuse = { status: 403, code: "device_revoked" };
    const error = await sync(a).catch((caught: unknown) => caught);
    expect(error instanceof CliError && error.code).toBe("sync_stopped");
    expect((await files(a)).get("One.md")).toBe("1\n");
  });

  test("a dry run changes nothing", async () => {
    const vault = new FakeVault();
    const a = await device(vault, "a");
    await put(a, "One.md", "1\n");
    const report = await sync(a, { dry_run: true });
    expect(report.planned.some((action) => action.kind === "push")).toBe(true);
    expect(vault.notes.size).toBe(0);
  });

  test("a file still being written waits for the next run", async () => {
    const vault = new FakeVault();
    const a = await device(vault, "a");
    await put(a, "Busy.md", "start\n");
    const pending = sync(a, { quiet_ms: 300 });
    setTimeout(() => void put(a, "Busy.md", "start\nmore\n"), 100);
    const report = await pending;
    expect(report.waiting).toContain("Busy.md");
    expect(vault.live().get("Busy.md")).toBe("start\nmore\n");
  });

  test("duplicated writes are recognised as already applied", async () => {
    const vault = new FakeVault();
    const original = vault.transport;
    vault.transport = async (method, path, options) => {
      if (method === "GET") return original(method, path, options);
      await original(method, path, options);
      return original(method, path, options);
    };
    const a = await device(vault, "a");
    const b = await device(vault, "b");
    await put(a, "One.md", "1\n");
    await put(a, "Two.md", "2\n");
    await sync(a);
    await sync(b);
    await put(a, "One.md", "1 edited\n");
    await rm(join(a.root, "Two.md"));
    await put(a, "Moved.md", "1 edited\n");
    await sync(a);
    await sync(b);
    await sync(a);
    expect(sorted(await files(a))).toEqual(sorted(await files(b)));
    expect(sorted(await files(a))).toEqual(sorted(vault.live()));
  });
});
