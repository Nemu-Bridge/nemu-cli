import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  base32,
  content_mac,
  format_recovery,
  approval_code,
  commitment_of,
  new_request,
  new_request_keys,
  new_vault_key,
  open_content,
  open_path,
  password_kek,
  path_id,
  recovery_kek,
  remote_path,
  seal_content,
  seal_path,
  unbase32,
  unwrap_from_request,
  unwrap_key,
  vault_keys,
  wrap_for_request,
  wrap_key,
} from "../src/vault/private/crypto.js";

const FIXED_KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1));
const FIXED_VAULT = "11111111-1111-4111-8111-111111111111";

describe("private vault crypto", () => {
  const keys = vault_keys(FIXED_VAULT, FIXED_KEY);

  test("fixed vectors stay fixed, so every client derives the same names", () => {
    expect(path_id(keys, "Ideas/Lobby.md")).toBe(path_id(keys, "ideas/lobby.md"));
    expect(path_id(keys, "Ideas/Lobby.md")).toBe("k5s4enqstyaxpsclx7dqgas4ourdylp7unmlsnsoirdcbxcedlia");
    expect(content_mac(keys, Buffer.from("hello", "utf8"))).toBe(
      "a4ab08de9452e132f6880263c1482808987107aa45c4c1f2f17c45f42604888c",
    );
    expect(path_id(keys, "Ideas/Lobby.md")).toMatch(/^[a-z2-7]{52}$/);
  });

  test("a name and a body round trip and are bound to their note", () => {
    const sealed_name = seal_path(keys, "Ideas/Lobby.md");
    const remote = remote_path(keys, "Ideas/Lobby.md");
    expect(open_path(keys, remote, sealed_name)).toBe("Ideas/Lobby.md");
    const body = seal_content(keys, "Ideas/Lobby.md", Buffer.from("# Lobby\n"));
    expect(open_content(keys, remote, body).toString()).toBe("# Lobby\n");
    const other = remote_path(keys, "Ideas/Map.md");
    expect(() => open_content(keys, other, body)).toThrow("bad_content");
    expect(() => open_path(keys, other, sealed_name)).toThrow("bad_sealed_path");
  });

  test("another vault's key or a flipped byte does not open it", () => {
    const body = seal_content(keys, "a.md", Buffer.from("secret"));
    const remote = remote_path(keys, "a.md");
    const stranger = vault_keys(FIXED_VAULT, new_vault_key());
    expect(() => open_content(stranger, remote, body)).toThrow();
    const flipped = Buffer.from(body);
    flipped[flipped.length - 1]! ^= 1;
    expect(() => open_content(keys, remote, flipped)).toThrow("bad_content");
  });

  test("equal text gives an equal keyed hash, other keys give another", () => {
    const text = Buffer.from("same");
    expect(content_mac(keys, text)).toBe(content_mac(keys, Buffer.from("same")));
    expect(content_mac(vault_keys(FIXED_VAULT, new_vault_key()), text)).not.toBe(content_mac(keys, text));
  });

  test("password and recovery locks open only with their secret and their own settings", async () => {
    const vault_key = new_vault_key();
    const salt = randomBytes(16);
    const params = { memory_kib: 1024, iterations: 1, parallelism: 1 };
    const lock_params = { alg: "argon2id", salt: salt.toString("base64url"), m: 1024, t: 1, p: 1 };
    const kek = await password_kek("correct horse battery", salt, params);
    const wrapped = wrap_key(kek, FIXED_VAULT, "password", lock_params, vault_key);
    expect(unwrap_key(kek, FIXED_VAULT, "password", lock_params, wrapped).equals(vault_key)).toBe(true);
    const wrong = await password_kek("correct horse batterY", salt, params);
    expect(() => unwrap_key(wrong, FIXED_VAULT, "password", lock_params, wrapped)).toThrow("wrong_secret");
    expect(() => unwrap_key(kek, FIXED_VAULT, "recovery", lock_params, wrapped)).toThrow("wrong_secret");
    expect(() => unwrap_key(kek, FIXED_VAULT, "password", { ...lock_params, m: 2048 }, wrapped)).toThrow("wrong_secret");

    const recovery = randomBytes(32);
    const typed = format_recovery(recovery).toLowerCase();
    expect(unbase32(typed).equals(recovery)).toBe(true);
    const sealed = wrap_key(recovery_kek(recovery), FIXED_VAULT, "recovery", { v: 1 }, vault_key);
    expect(unwrap_key(recovery_kek(unbase32(typed)), FIXED_VAULT, "recovery", { v: 1 }, sealed).equals(vault_key)).toBe(true);
  });

  test("a device approval reaches only the device whose code was checked", () => {
    const vault_key = new_vault_key();
    const asking = new_request();
    const approver = new_request_keys();
    expect(commitment_of(asking.keys.public_key, asking.nonce)).toBe(asking.commitment);
    const code = approval_code(FIXED_VAULT, "req-1", asking.keys.public_key, approver.public_key, asking.nonce);
    expect(code).toMatch(/^\d{6}$/);
    const wrapped = wrap_for_request(FIXED_VAULT, "req-1", approver, asking.keys.public_key, vault_key);
    expect(unwrap_from_request(FIXED_VAULT, "req-1", asking.keys, approver.public_key, wrapped).equals(vault_key)).toBe(true);

    const intruder = new_request_keys();
    const forged = wrap_for_request(FIXED_VAULT, "req-1", intruder, asking.keys.public_key, new_vault_key());
    expect(() => unwrap_from_request(FIXED_VAULT, "req-1", asking.keys, approver.public_key, forged)).toThrow("bad_approval");
    expect(() => unwrap_from_request(FIXED_VAULT, "req-2", asking.keys, approver.public_key, wrapped)).toThrow("bad_approval");

    const swapped = new_request();
    expect(commitment_of(swapped.keys.public_key, asking.nonce)).not.toBe(asking.commitment);
    expect(approval_code(FIXED_VAULT, "req-1", swapped.keys.public_key, approver.public_key, asking.nonce)).not.toBe(code);
  });

  test("base32 round trips", () => {
    const bytes = randomBytes(40);
    expect(unbase32(base32(bytes)).equals(bytes)).toBe(true);
  });
});
