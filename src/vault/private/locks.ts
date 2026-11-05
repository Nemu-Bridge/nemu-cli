import { randomBytes } from "node:crypto";
import type { NewLock } from "../api.js";
import {
  PASSWORD_LIMITS,
  PASSWORD_PARAMS,
  PrivateCryptoError,
  password_kek,
  recovery_kek,
  unwrap_key,
  wrap_key,
  type LockParams,
  type PasswordParams,
} from "./crypto.js";

export async function password_lock(vault_id: string, vault_key: Buffer, password: string): Promise<NewLock> {
  const salt = randomBytes(16);
  const kek = await password_kek(password, salt);
  const params: LockParams = {
    alg: "argon2id",
    salt: salt.toString("base64url"),
    m: PASSWORD_PARAMS.memory_kib,
    t: PASSWORD_PARAMS.iterations,
    p: PASSWORD_PARAMS.parallelism,
  };
  return {
    kind: "password",
    label: "Vault password",
    params,
    wrapped: wrap_key(kek, vault_id, "password", params, vault_key).toString("base64url"),
  };
}

export function recovery_lock(vault_id: string, vault_key: Buffer, recovery: Buffer): NewLock {
  const params: LockParams = { v: 1 };
  return {
    kind: "recovery",
    label: "Recovery key",
    params,
    wrapped: wrap_key(recovery_kek(recovery), vault_id, "recovery", params, vault_key).toString("base64url"),
  };
}

function within(value: string | number | undefined, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new PrivateCryptoError("The password lock has settings outside the safe range", "bad_lock");
  }
  return parsed;
}

export function password_settings(params: LockParams): { salt: Buffer; settings: PasswordParams } {
  if (params.alg !== "argon2id" || typeof params.salt !== "string") {
    throw new PrivateCryptoError("The password lock is damaged", "bad_lock");
  }
  const salt = Buffer.from(params.salt, "base64url");
  if (salt.length < 16) throw new PrivateCryptoError("The password lock is damaged", "bad_lock");
  return {
    salt,
    settings: {
      memory_kib: within(params.m, PASSWORD_LIMITS.min_memory_kib, PASSWORD_LIMITS.max_memory_kib),
      iterations: within(params.t, PASSWORD_LIMITS.min_iterations, PASSWORD_LIMITS.max_iterations),
      parallelism: within(params.p, 1, PASSWORD_LIMITS.max_parallelism),
    },
  };
}

export async function open_password_lock(
  vault_id: string,
  params: LockParams,
  wrapped: string,
  password: string,
): Promise<Buffer> {
  const { salt, settings } = password_settings(params);
  const kek = await password_kek(password, salt, settings);
  return unwrap_key(kek, vault_id, "password", params, Buffer.from(wrapped, "base64url"));
}

export function open_recovery_lock(vault_id: string, params: LockParams, wrapped: string, recovery: Buffer): Buffer {
  return unwrap_key(recovery_kek(recovery), vault_id, "recovery", params, Buffer.from(wrapped, "base64url"));
}
