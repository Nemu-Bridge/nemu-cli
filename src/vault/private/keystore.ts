import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config_dir } from "../../config.js";
import { CliError } from "../../errors.js";

const SERVICE = "nemu-vault";
const KEY_FILE_MODE = 0o600;
const WINDOWS_PROTECT =
  "Add-Type -AssemblyName System.Security; $in = [Console]::In.ReadToEnd().Trim(); $bytes = [Convert]::FromBase64String($in); $out = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser'); [Console]::Out.Write([Convert]::ToBase64String($out))";
const WINDOWS_UNPROTECT =
  "Add-Type -AssemblyName System.Security; $in = [Console]::In.ReadToEnd().Trim(); $bytes = [Convert]::FromBase64String($in); $out = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, 'CurrentUser'); [Console]::Out.Write([Convert]::ToBase64String($out))";

export type KeyStoreKind = "keychain" | "dpapi" | "file";

interface Result {
  code: number;
  stdout: string;
}

function run(command: string, args: string[], input: string): Promise<Result> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", () => resolve({ code: 127, stdout: "" }));
    child.on("close", (code) => resolve({ code: code ?? 127, stdout: Buffer.concat(chunks).toString("utf8") }));
    child.stdin.end(input);
  });
}

function key_dir(): string {
  return join(config_dir(), "vault-keys");
}

const VAULT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function checked_id(vault_id: string): string {
  if (!VAULT_ID.test(vault_id)) throw new CliError("Not a vault id.", "invalid_vault_id");
  return vault_id;
}

function key_file(vault_id: string): string {
  return join(key_dir(), `${checked_id(vault_id)}.key`);
}

export function keystore_kind(): KeyStoreKind {
  if (process.env.NEMU_VAULT_KEYSTORE === "file") return "file";
  if (process.platform === "darwin") return "keychain";
  if (process.platform === "win32") return "dpapi";
  return "file";
}

async function write_key_file(vault_id: string, text: string): Promise<void> {
  await mkdir(key_dir(), { recursive: true, mode: 0o700 });
  await writeFile(key_file(vault_id), text, { mode: KEY_FILE_MODE });
  await chmod(key_file(vault_id), KEY_FILE_MODE).catch(() => undefined);
}

async function read_key_file(vault_id: string): Promise<string | null> {
  return readFile(key_file(vault_id), "utf8")
    .then((text) => text.trim())
    .catch(() => null);
}

export async function save_vault_key(vault_id: string, vault_key: Buffer): Promise<KeyStoreKind> {
  checked_id(vault_id);
  const kind = keystore_kind();
  const encoded = vault_key.toString("base64");
  if (kind === "keychain") {
    const added = await run(
      "/usr/bin/security",
      ["-i"],
      `add-generic-password -U -s ${SERVICE} -a ${vault_id} -w ${encoded}\n`,
    );
    if (added.code !== 0) throw new CliError("Could not save the vault key in the macOS Keychain.", "keystore_failed");
    return kind;
  }
  if (kind === "dpapi") {
    const sealed = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROTECT], encoded);
    if (sealed.code !== 0 || sealed.stdout.length === 0) {
      throw new CliError("Could not protect the vault key with Windows.", "keystore_failed");
    }
    await write_key_file(vault_id, `dpapi:${sealed.stdout.trim()}`);
    return kind;
  }
  await write_key_file(vault_id, `plain:${encoded}`);
  return kind;
}

export async function load_vault_key(vault_id: string): Promise<Buffer | null> {
  checked_id(vault_id);
  const kind = keystore_kind();
  if (kind === "keychain") {
    const found = await run("/usr/bin/security", ["find-generic-password", "-s", SERVICE, "-a", vault_id, "-w"], "");
    if (found.code !== 0) return null;
    const key = Buffer.from(found.stdout.trim(), "base64");
    return key.length === 32 ? key : null;
  }
  const stored = await read_key_file(vault_id);
  if (stored === null) return null;
  if (stored.startsWith("plain:")) {
    const key = Buffer.from(stored.slice("plain:".length), "base64");
    return key.length === 32 ? key : null;
  }
  if (stored.startsWith("dpapi:") && kind === "dpapi") {
    const opened = await run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_UNPROTECT],
      stored.slice("dpapi:".length),
    );
    if (opened.code !== 0) return null;
    const key = Buffer.from(opened.stdout.trim(), "base64");
    return key.length === 32 ? key : null;
  }
  return null;
}

export async function forget_vault_key(vault_id: string): Promise<void> {
  checked_id(vault_id);
  if (keystore_kind() === "keychain") {
    await run("/usr/bin/security", ["delete-generic-password", "-s", SERVICE, "-a", vault_id], "");
  }
  await rm(key_file(vault_id), { force: true });
}
