import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile, rm, chmod, rename } from "node:fs/promises";
import { z } from "zod";

export const DEFAULT_API_URL = "https://app.nemu.cc";
export const DEFAULT_CLIENT_ID = "nemu_cli";
export const API_VERSION = "2026-07-14";

const credentials_schema = z.object({
  kind: z.enum(["oauth", "key"]).default("oauth"),
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_at: z.number(),
  scope: z.string(),
  api_url: z.string().url(),
  account: z.string().optional(),
  workspace: z
    .object({ id: z.string().min(1), name: z.string() })
    .optional(),
});

export type StoredCredentials = z.input<typeof credentials_schema>;

const settings_schema = z.object({
  device_id: z
    .string()
    .regex(/^dev_[a-z2-7]{12}$/)
    .optional(),
  device_api_url: z.string().url().optional(),
  reports: z.boolean().default(true),
  update_checked_at: z.number().optional(),
  update_latest: z.string().max(64).optional(),
  update_declined_version: z.string().max(64).optional(),
  update_declined_at: z.number().optional(),
  setup_version: z.string().max(64).optional(),
  context_workspace: z.string().min(1).max(64).optional(),
});

export type StoredSettings = z.infer<typeof settings_schema>;

export function api_url(): string {
  return (process.env.NEMU_API_URL ?? DEFAULT_API_URL).replace(/\/+$/, "");
}

export function client_id(): string {
  return process.env.NEMU_CLIENT_ID ?? DEFAULT_CLIENT_ID;
}

export function config_dir(): string {
  return process.env.NEMU_CONFIG_DIR ?? join(homedir(), ".nemu");
}

function credentials_path(): string {
  return join(config_dir(), "auth.json");
}

function settings_path(): string {
  return join(config_dir(), "settings.json");
}

export async function write_private(path: string, contents: string): Promise<void> {
  await mkdir(config_dir(), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, contents, { encoding: "utf-8", mode: 0o600 });
  await chmod(temporary, 0o600).catch(() => undefined);
  await rename(temporary, path);
}

async function read_json(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as unknown;
  } catch {
    return null;
  }
}

export async function read_credentials(): Promise<StoredCredentials | null> {
  const parsed = credentials_schema.safeParse(await read_json(credentials_path()));
  return parsed.success ? parsed.data : null;
}

export async function write_credentials(
  credentials: StoredCredentials,
): Promise<string> {
  const path = credentials_path();
  await write_private(path, JSON.stringify(credentials, null, 2));
  return path;
}

export async function clear_credentials(): Promise<boolean> {
  try {
    await rm(credentials_path());
    return true;
  } catch {
    return false;
  }
}

export async function read_settings(): Promise<StoredSettings> {
  const parsed = settings_schema.safeParse((await read_json(settings_path())) ?? {});
  return parsed.success ? parsed.data : { reports: true };
}

export async function update_settings(
  change: Partial<StoredSettings>,
): Promise<StoredSettings> {
  const next = { ...(await read_settings()), ...change };
  await write_private(settings_path(), JSON.stringify(next, null, 2));
  return next;
}

export function is_expired(credentials: StoredCredentials): boolean {
  return Date.now() >= credentials.expires_at;
}

export function has_scope(credentials: StoredCredentials, scope: string): boolean {
  return credentials.scope.split(/\s+/).includes(scope);
}
