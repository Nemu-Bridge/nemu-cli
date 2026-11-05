import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultApi } from "../src/vault/api.js";
import { run_sync } from "../src/vault/engine.js";
import { new_vault_key, vault_keys } from "../src/vault/private/crypto.js";
import { PrivateVaultApi } from "../src/vault/private/api.js";
import { write_marker } from "../src/vault/state.js";
import { FakeVault } from "./support/fake-vault.js";

let scratch = "";
let counter = 0;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "nemu-private-sync-"));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function device(vault: FakeVault, vault_key: Buffer, name: string) {
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
  const api = new PrivateVaultApi(new VaultApi(vault.transport, vault.id, `test ${name}`), vault_keys(vault.id, vault_key));
  const state_path = join(scratch, `state-${name}-${counter}.json`);
  return {
    root,
    sync: () => run_sync({ root, api, state_path, device: name, quiet_ms: 0, now: () => new Date(2026, 9, 29, 22, 0) }),
    put: async (path: string, text: string) => {
      const full = join(root, ...path.split("/"));
      await mkdir(join(full, ".."), { recursive: true });
      await writeFile(full, text);
    },
    read: (path: string) => readFile(join(root, ...path.split("/")), "utf8"),
  };
}

const WORDS = ["lobby", "treasure", "ideas", "cave"];

function server_holds_plaintext(vault: FakeVault): string[] {
  const found: string[] = [];
  for (const note of vault.notes.values()) {
    const everything = [note.path, note.sealed_path ?? "", note.hash, note.content.toString("latin1")]
      .concat(note.versions.flatMap((version) => [version.path, version.content.toString("latin1")]))
      .join("\n")
      .toLowerCase();
    WORDS.filter((word) => everything.includes(word)).forEach((word) => found.push(`${note.id}:${word}`));
  }
  return found;
}

describe("private vault sync", () => {
  test("two devices stay identical and the server only ever holds sealed bytes", async () => {
    const vault = new FakeVault();
    vault.mode = "private";
    const vault_key = new_vault_key();
    const a = await device(vault, vault_key, "a");
    const b = await device(vault, vault_key, "b");

    await a.put("Ideas/Lobby.md", "# Lobby\n\nSee [[treasure]].\n");
    await a.put("treasure.md", "under the oak\n");
    expect((await a.sync()).pushed.sort()).toEqual(["Ideas/Lobby.md", "treasure.md"]);
    expect([...vault.notes.values()].every((note) => /^private\/[a-z2-7]{52}$/.test(note.path))).toBe(true);

    expect((await b.sync()).pulled.sort()).toEqual(["Ideas/Lobby.md", "treasure.md"]);
    expect(await b.read("Ideas/Lobby.md")).toBe("# Lobby\n\nSee [[treasure]].\n");

    expect((await b.sync()).pushed).toEqual([]);

    await a.put("Ideas/Lobby.md", "# Lobby\n\nSee [[treasure]].\nA writes here.\n");
    await b.put("Ideas/Lobby.md", "# Lobby\nB writes here.\n\nSee [[treasure]].\n");
    await a.sync();
    const merged = await b.sync();
    expect(merged.merged).toEqual(["Ideas/Lobby.md"]);
    await a.sync();
    expect(await a.read("Ideas/Lobby.md")).toBe(await b.read("Ideas/Lobby.md"));
    expect(await a.read("Ideas/Lobby.md")).toContain("A writes here.");
    expect(await a.read("Ideas/Lobby.md")).toContain("B writes here.");

    await rm(join(b.root, "treasure.md"));
    await b.put("cave.md", "under the oak\n");
    await b.sync();
    await a.sync();
    await expect(stat(join(a.root, "treasure.md"))).rejects.toThrow();
    expect(await a.read("cave.md")).toBe("under the oak\n");

    expect(server_holds_plaintext(vault)).toEqual([]);
  });

  test("a device with another key cannot read the vault and changes nothing", async () => {
    const vault = new FakeVault();
    vault.mode = "private";
    const a = await device(vault, new_vault_key(), "a");
    await a.put("note.md", "hello\n");
    await a.sync();
    const stranger = await device(vault, new_vault_key(), "x");
    await expect(stranger.sync()).rejects.toMatchObject({ code: "private_key_mismatch" });
    expect([...vault.notes.values()].map((note) => note.version)).toEqual([1]);
  });
});
