import { randomBytes, randomUUID } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { device_name } from "../device.js";
import { CliError } from "../errors.js";
import { emit, is_json_mode } from "../output.js";
import { ask_secret, bold, confirm, dim, is_interactive, out, spinner, success } from "../ui.js";
import { create_vault, LockApi, type RemoteVault, type Transport } from "../vault/api.js";
import {
  PrivateCryptoError,
  approval_code,
  commitment_of,
  format_recovery,
  new_request,
  new_request_keys,
  new_vault_key,
  unbase32,
  unwrap_from_request,
  wrap_for_request,
} from "../vault/private/crypto.js";
import { forget_vault_key, load_vault_key, save_vault_key } from "../vault/private/keystore.js";
import { open_password_lock, open_recovery_lock, password_lock, recovery_lock } from "../vault/private/locks.js";
import { password_problem } from "../vault/private/strength.js";

const PASSWORD_ENV = "NEMU_VAULT_PASSWORD";
const RECOVERY_ENV = "NEMU_VAULT_RECOVERY";
const POLL_MS = 2000;

async function new_password(vault_name: string): Promise<string> {
  const from_env = process.env[PASSWORD_ENV];
  if (from_env !== undefined) {
    const problem = password_problem(from_env, [vault_name]);
    if (problem !== null) throw new CliError(problem, "weak_password");
    return from_env;
  }
  if (!is_interactive()) {
    throw new CliError(`Set ${PASSWORD_ENV}, or run this in a terminal to choose the vault password.`, "password_required");
  }
  out(dim("  Choose a vault password. It is not your Nemu password, and Nemu never sees it."));
  for (;;) {
    const first = await ask_secret("Vault password:");
    const problem = password_problem(first, [vault_name]);
    if (problem !== null) {
      out(`  ${problem}`);
      continue;
    }
    const again = await ask_secret("Type it again:");
    if (again === first) return first;
    out("  Those two did not match. Try again.");
  }
}

async function save_recovery(vault_id: string, vault_name: string, recovery: Buffer): Promise<string> {
  const safe = vault_name.replace(/[^\w .-]/g, "").trim() || "vault";
  const text = [
    `Recovery key for the private vault "${vault_name}" (${vault_id})`,
    "",
    format_recovery(recovery),
    "",
    "This opens the vault if you lose every device, passkey and the vault password.",
    "Nemu cannot recover it for you. Keep it somewhere offline and delete this file.",
    "",
  ].join("\n");
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const suffix = attempt === 0 ? "" : ` (${attempt + 1})`;
    const path = join(homedir(), `Nemu recovery key - ${safe} - ${vault_id.slice(0, 8)}${suffix}.txt`);
    try {
      await writeFile(path, text, { mode: 0o600, flag: "wx" });
      await chmod(path, 0o600).catch(() => undefined);
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new CliError("Could not save the recovery key file. It is shown above: write it down.", "recovery_file_failed");
}

export async function create_private_vault(transport: Transport, name: string): Promise<RemoteVault> {
  const password = await new_password(name);
  const vault_id = randomUUID();
  const vault_key = new_vault_key();
  const recovery = randomBytes(32);
  const working = spinner("Sealing the vault key");
  const locks = [await password_lock(vault_id, vault_key, password), recovery_lock(vault_id, vault_key, recovery)];
  working.stop();
  const vault = await create_vault(transport, name, { id: vault_id, locks });
  if (vault.id !== vault_id) throw new CliError("Nemu did not keep the private vault's id.", "invalid_response");
  await save_vault_key(vault.id, vault_key);
  const recovery_path = await save_recovery(vault.id, name, recovery);
  if (!is_json_mode()) {
    out();
    out(`  ${bold("Recovery key")} ${format_recovery(recovery)}`);
    out(dim(`  Also saved to ${recovery_path}. Move it somewhere offline: it is the only way back if every other lock is lost.`));
  }
  return vault;
}

async function read_recovery(): Promise<Buffer> {
  const typed = process.env[RECOVERY_ENV] ?? (is_interactive() ? await ask_secret("Recovery key:") : "");
  const recovery = unbase32(typed);
  if (recovery.length !== 32) throw new CliError("That is not a recovery key.", "bad_recovery_key");
  return recovery;
}

async function wait_for<T>(deadline: number, step: () => Promise<T | null>): Promise<T> {
  while (Date.now() < deadline) {
    const found = await step();
    if (found !== null) return found;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new CliError("Nobody finished the approval in time. Start again.", "request_expired");
}

async function approved_key(locks: LockApi): Promise<Buffer> {
  if (!is_interactive()) {
    throw new CliError("Approval needs you to compare a code, so run nemu vault unlock --approve in a terminal.", "needs_terminal");
  }
  const request = new_request();
  const asked = await locks.ask(request.commitment, device_name().slice(0, 80) || "A computer");
  const deadline = Date.parse(asked.expires_at);
  if (is_json_mode()) emit({ waiting: true, request_id: asked.id, expires_at: asked.expires_at });
  else {
    out("  On a device where this vault is open, approve this computer:");
    out(dim("  in the console under the vault's Devices tab, or with nemu vault approve. This waits up to 10 minutes."));
  }
  const approver_key = await wait_for(deadline, async () => {
    const answer = await locks.answer_of(asked.id);
    if (answer.status === "denied") throw new CliError("The request was declined.", "request_denied");
    if (answer.status === "expired") throw new CliError("The request expired. Start again.", "request_expired");
    return answer.approver_key ?? null;
  });
  await locks.reveal(asked.id, request.keys.public_key, request.nonce);
  const code = approval_code(locks.vault_id, asked.id, request.keys.public_key, approver_key, request.nonce);
  out(`  This computer shows ${bold(code)}.`);
  if (!(await confirm(`Does the approving device show ${code} too?`, false))) {
    await locks.answer(asked.id, null).catch(() => undefined);
    throw new CliError("The codes did not match, so nothing was accepted. Start again.", "approval_mismatch");
  }
  out(dim("  Now approve it on the other device."));
  return wait_for(deadline, async () => {
    const answer = await locks.answer_of(asked.id);
    if (answer.status === "denied") throw new CliError("The request was declined.", "request_denied");
    if (answer.status === "expired") throw new CliError("The request expired. Start again.", "request_expired");
    if (answer.approver_key !== undefined && answer.approver_key !== approver_key) {
      throw new CliError("The approving device changed during the approval. Nothing was accepted.", "approval_tampered");
    }
    if (answer.wrapped === undefined) return null;
    try {
      return unwrap_from_request(locks.vault_id, asked.id, request.keys, approver_key, Buffer.from(answer.wrapped, "base64url"));
    } catch {
      throw new CliError("The approval did not come from the device whose code you checked. Nothing was accepted.", "approval_tampered");
    }
  });
}

type Method = "password" | "recovery" | "approve";

function method_from(flags: { password: boolean; recovery: boolean; approve: boolean }): Method | null {
  if (flags.password) return "password";
  if (flags.recovery) return "recovery";
  if (flags.approve) return "approve";
  if (process.env[PASSWORD_ENV] !== undefined) return "password";
  if (process.env[RECOVERY_ENV] !== undefined) return "recovery";
  return null;
}

export async function unlock_vault(
  transport: Transport,
  vault_id: string,
  vault_name: string,
  flags: { password: boolean; recovery: boolean; approve: boolean },
): Promise<void> {
  if ((await load_vault_key(vault_id)) !== null) {
    if (!is_json_mode()) success(`"${vault_name}" is already open on this computer.`);
    return;
  }
  const locks = new LockApi(transport, vault_id);
  const available = await locks.locks();
  const chosen =
    method_from(flags) ??
    (available.some((lock) => lock.kind === "password") && is_interactive()
      ? (await confirm("Unlock with the vault password?", true))
        ? "password"
        : (await confirm("Use the recovery key?", false))
          ? "recovery"
          : "approve"
      : "approve");

  let vault_key: Buffer;
  if (chosen === "approve") {
    vault_key = await approved_key(locks);
  } else {
    const lock = available.find((entry) => entry.kind === chosen);
    if (lock === undefined) throw new CliError(`This vault has no ${chosen} lock.`, "no_such_lock");
    const wrapped = await locks.wrapped(lock.id);
    try {
      vault_key =
        chosen === "password"
          ? await open_password_lock(
              vault_id,
              lock.params,
              wrapped,
              process.env[PASSWORD_ENV] ?? (await ask_secret("Vault password:")),
            )
          : open_recovery_lock(vault_id, lock.params, wrapped, await read_recovery());
    } catch (error) {
      if (error instanceof CliError) throw error;
      if (error instanceof PrivateCryptoError && error.code === "bad_lock") {
        throw new CliError(
          "This vault's password lock is damaged or was changed on the server, so it was not used. Unlock with the recovery key or another device.",
          "bad_lock",
        );
      }
      throw new CliError(
        chosen === "password" ? "That is not the vault password." : "That recovery key does not open this vault.",
        "wrong_secret",
      );
    }
  }
  const store = await save_vault_key(vault_id, vault_key);
  if (is_json_mode()) emit({ ok: true, vault_id, unlocked: true, keystore: store });
  else success(`"${vault_name}" is open on this computer. Its key is kept in ${store === "keychain" ? "the macOS Keychain" : store === "dpapi" ? "Windows, protected for your account" : "a file only your account can read"}.`);
}

export async function approve_requests(transport: Transport, vault_id: string, vault_name: string): Promise<void> {
  const vault_key = await load_vault_key(vault_id);
  if (vault_key === null) {
    throw new CliError(`"${vault_name}" is locked on this computer, so it cannot approve another one.`, "vault_locked");
  }
  if (!is_interactive()) {
    throw new CliError("Approving a device needs you to compare a code, so run this in a terminal.", "needs_terminal");
  }
  const locks = new LockApi(transport, vault_id);
  const pending = (await locks.requests()).filter((request) => request.approver_key === null);
  if (pending.length === 0) {
    out("  No device is waiting to open this vault.");
    return;
  }
  let approved = 0;
  for (const request of pending) {
    if (!(await confirm(`"${request.label}" asks to open this vault. Did you just ask for it?`, false))) {
      await locks.answer(request.id, null).catch(() => undefined);
      continue;
    }
    const approver = new_request_keys();
    await locks.offer(request.id, approver.public_key);
    const revealed = await wait_for(Date.parse(request.expires_at), async () => {
      const current = await locks.request(request.id);
      if (current === null) throw new CliError("The request is gone.", "request_expired");
      return current.public_key !== null && current.nonce !== null ? current : null;
    });
    if (commitment_of(revealed.public_key!, revealed.nonce!) !== request.commitment) {
      await locks.answer(request.id, null).catch(() => undefined);
      throw new CliError("The asking device's key changed after it asked. It was declined.", "approval_tampered");
    }
    const code = approval_code(vault_id, request.id, revealed.public_key!, approver.public_key, revealed.nonce!);
    if (!(await confirm(`Does "${request.label}" show ${code}?`, false))) {
      await locks.answer(request.id, null).catch(() => undefined);
      continue;
    }
    await locks.answer(
      request.id,
      wrap_for_request(vault_id, request.id, approver, revealed.public_key!, vault_key).toString("base64url"),
    );
    approved += 1;
  }
  success(`Approved ${approved} device${approved === 1 ? "" : "s"}.`);
}

export async function forget_key(vault_id: string, vault_name: string): Promise<void> {
  await forget_vault_key(vault_id);
  if (is_json_mode()) emit({ ok: true, vault_id, unlocked: false });
  else success(`"${vault_name}" is locked on this computer again. Your files are still there.`);
}
