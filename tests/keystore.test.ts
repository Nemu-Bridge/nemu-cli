import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forget_vault_key, keystore_kind, load_vault_key, save_vault_key } from "../src/vault/private/keystore.js";

let dir = "";
const previous = process.env.NEMU_CONFIG_DIR;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "nemu-keystore-"));
  process.env.NEMU_CONFIG_DIR = dir;
});

afterAll(async () => {
  if (previous === undefined) delete process.env.NEMU_CONFIG_DIR;
  else process.env.NEMU_CONFIG_DIR = previous;
  await rm(dir, { recursive: true, force: true });
});

describe("vault key store", () => {
  test("this platform's store keeps a key, gives it back, and forgets it", async () => {
    const id = randomUUID();
    const key = randomBytes(32);
    expect(await save_vault_key(id, key)).toBe(keystore_kind());
    expect((await load_vault_key(id))?.equals(key)).toBe(true);
    if (keystore_kind() === "dpapi") {
      const stored = await readFile(join(dir, "vault-keys", `${id}.key`), "utf8");
      expect(stored.startsWith("dpapi:")).toBe(true);
      expect(stored.includes(key.toString("base64"))).toBe(false);
    }
    await forget_vault_key(id);
    expect(await load_vault_key(id)).toBeNull();
  });

  test("a vault that was never unlocked has no key", async () => {
    expect(await load_vault_key(randomUUID())).toBeNull();
  });
});
