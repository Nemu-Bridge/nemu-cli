import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { argon2id } from "hash-wasm";

export const PRIVATE_PREFIX = "private/";
const CONTENT_MAGIC = Buffer.from("NPV1", "ascii");
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

export interface PasswordParams {
  memory_kib: number;
  iterations: number;
  parallelism: number;
}

export const PASSWORD_PARAMS: PasswordParams = { memory_kib: 65536, iterations: 3, parallelism: 1 };
export const PASSWORD_LIMITS = {
  min_memory_kib: 65536,
  max_memory_kib: 1048576,
  min_iterations: 3,
  max_iterations: 10,
  max_parallelism: 4,
} as const;

export class PrivateCryptoError extends Error {
  constructor(message: string, readonly code: string) {
    super(`${message} [${code}]`);
    this.name = "PrivateCryptoError";
  }
}

export interface VaultKeys {
  vault_id: string;
  content: Buffer;
  path: Buffer;
  mac: Buffer;
}

function subkey(vault_key: Buffer, name: string): Buffer {
  return Buffer.from(hkdfSync("sha256", vault_key, Buffer.alloc(0), `nemu-private|${name}|v1`, KEY_BYTES));
}

export function new_vault_key(): Buffer {
  return randomBytes(KEY_BYTES);
}

export function vault_keys(vault_id: string, vault_key: Buffer): VaultKeys {
  if (vault_key.length !== KEY_BYTES) throw new PrivateCryptoError("A vault key is 32 bytes", "bad_vault_key");
  return {
    vault_id,
    content: subkey(vault_key, "content"),
    path: subkey(vault_key, "path"),
    mac: subkey(vault_key, "mac"),
  };
}

export function base32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function unbase32(text: string): Buffer {
  const clean = text.toLowerCase().replace(/[\s-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const character of clean) {
    const index = BASE32.indexOf(character);
    if (index === -1) throw new PrivateCryptoError("That is not a recovery key", "bad_recovery_key");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function seal(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}

function open(key: Buffer, sealed: Buffer, aad: string, code: string): Buffer {
  if (sealed.length < NONCE_BYTES + TAG_BYTES) throw new PrivateCryptoError("Sealed data is too short", code);
  const nonce = sealed.subarray(0, NONCE_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  const body = sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new PrivateCryptoError("Sealed data did not open: wrong key or changed bytes", code);
  }
}

export function path_id(keys: VaultKeys, path: string): string {
  const digest = createHmac("sha256", keys.mac).update(`path\u0000${path.normalize("NFC").toLowerCase()}`, "utf8").digest();
  return base32(digest).slice(0, 52);
}

export function remote_path(keys: VaultKeys, path: string): string {
  return `${PRIVATE_PREFIX}${path_id(keys, path)}`;
}

export function id_of_remote(remote: string): string {
  if (!remote.startsWith(PRIVATE_PREFIX)) throw new PrivateCryptoError("Not a private note path", "bad_remote_path");
  return remote.slice(PRIVATE_PREFIX.length);
}

export function seal_path(keys: VaultKeys, path: string): string {
  const normalized = path.normalize("NFC");
  return seal(keys.path, Buffer.from(normalized, "utf8"), `path|${keys.vault_id}|${path_id(keys, normalized)}`).toString("base64url");
}

export function open_path(keys: VaultKeys, remote: string, sealed_path: string): string {
  const id = id_of_remote(remote);
  const path = open(keys.path, Buffer.from(sealed_path, "base64url"), `path|${keys.vault_id}|${id}`, "bad_sealed_path").toString("utf8");
  if (path_id(keys, path) !== id) throw new PrivateCryptoError("A sealed name does not belong to its note", "bad_sealed_path");
  return path;
}

export function seal_content(keys: VaultKeys, path: string, content: Uint8Array): Buffer {
  const sealed = seal(keys.content, Buffer.from(content), `content|${keys.vault_id}|${path_id(keys, path)}`);
  return Buffer.concat([CONTENT_MAGIC, sealed]);
}

export function open_content(keys: VaultKeys, remote: string, sealed: Uint8Array): Buffer {
  const bytes = Buffer.from(sealed);
  if (!bytes.subarray(0, CONTENT_MAGIC.length).equals(CONTENT_MAGIC)) {
    throw new PrivateCryptoError("This is not a private note", "bad_content");
  }
  return open(keys.content, bytes.subarray(CONTENT_MAGIC.length), `content|${keys.vault_id}|${id_of_remote(remote)}`, "bad_content");
}

export function content_mac(keys: VaultKeys, content: Uint8Array): string {
  return createHmac("sha256", keys.mac).update("content\u0000", "utf8").update(content).digest("hex");
}

export type LockParams = Record<string, string | number>;

export function lock_aad(vault_id: string, kind: string, params: LockParams): string {
  const canonical = Object.keys(params)
    .sort()
    .map((key) => {
      const value = String(params[key]);
      return `${key.length}:${key}=${value.length}:${value}`;
    })
    .join("|");
  return `lock|v2|${vault_id}|${kind}|${canonical}`;
}

export function wrap_key(kek: Buffer, vault_id: string, kind: string, params: LockParams, vault_key: Buffer): Buffer {
  return seal(kek, vault_key, lock_aad(vault_id, kind, params));
}

export function unwrap_key(
  kek: Buffer,
  vault_id: string,
  kind: string,
  params: LockParams,
  wrapped: Buffer,
): Buffer {
  return open(kek, wrapped, lock_aad(vault_id, kind, params), "wrong_secret");
}

export async function password_kek(
  password: string,
  salt: Buffer,
  params: PasswordParams = PASSWORD_PARAMS,
): Promise<Buffer> {
  const hash = await argon2id({
    password: password.normalize("NFC"),
    salt,
    parallelism: params.parallelism,
    iterations: params.iterations,
    memorySize: params.memory_kib,
    hashLength: KEY_BYTES,
    outputType: "binary",
  });
  return Buffer.from(hash);
}

export function recovery_kek(recovery: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", recovery, Buffer.alloc(0), "nemu-private|recovery|v1", KEY_BYTES));
}

export function format_recovery(recovery: Buffer): string {
  return (base32(recovery).toUpperCase().match(/.{1,4}/g) ?? []).join("-");
}

export interface RequestKeys {
  public_key: string;
  private_key: KeyObject;
}

export interface NewRequest {
  keys: RequestKeys;
  nonce: string;
  commitment: string;
}

export function new_request_keys(): RequestKeys {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const jwk = publicKey.export({ format: "jwk" });
  if (typeof jwk.x !== "string") throw new PrivateCryptoError("Could not make a key pair", "keypair_failed");
  return { public_key: jwk.x, private_key: privateKey };
}

export function commitment_of(public_key: string, nonce: string): string {
  return createHash("sha256")
    .update("nemu-approve-commit|v1|", "utf8")
    .update(Buffer.from(public_key, "base64url"))
    .update(Buffer.from(nonce, "base64url"))
    .digest("hex");
}

export function new_request(): NewRequest {
  const keys = new_request_keys();
  const nonce = randomBytes(16).toString("base64url");
  return { keys, nonce, commitment: commitment_of(keys.public_key, nonce) };
}

export function approval_code(
  vault_id: string,
  request_id: string,
  requester_key: string,
  approver_key: string,
  nonce: string,
): string {
  const digest = createHash("sha256")
    .update(`nemu-approve-code|v1|${vault_id}|${request_id}|`, "utf8")
    .update(Buffer.from(requester_key, "base64url"))
    .update(Buffer.from(approver_key, "base64url"))
    .update(Buffer.from(nonce, "base64url"))
    .digest();
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, "0");
}

function x25519_public(raw: string): KeyObject {
  return createPublicKey({ key: { kty: "OKP", crv: "X25519", x: raw }, format: "jwk" });
}

function approval_kek(own: KeyObject, other: string, requester_key: string, approver_key: string): Buffer {
  const shared = diffieHellman({ privateKey: own, publicKey: x25519_public(other) });
  const salt = Buffer.concat([Buffer.from(requester_key, "base64url"), Buffer.from(approver_key, "base64url")]);
  return Buffer.from(hkdfSync("sha256", shared, salt, "nemu-private|approve|v2", KEY_BYTES));
}

export function wrap_for_request(
  vault_id: string,
  request_id: string,
  approver: RequestKeys,
  requester_key: string,
  vault_key: Buffer,
): Buffer {
  const kek = approval_kek(approver.private_key, requester_key, requester_key, approver.public_key);
  return seal(kek, vault_key, `approve|${vault_id}|${request_id}`);
}

export function unwrap_from_request(
  vault_id: string,
  request_id: string,
  requester: RequestKeys,
  approver_key: string,
  wrapped: Buffer,
): Buffer {
  const kek = approval_kek(requester.private_key, approver_key, requester.public_key, approver_key);
  return open(kek, wrapped, `approve|${vault_id}|${request_id}`, "bad_approval");
}
