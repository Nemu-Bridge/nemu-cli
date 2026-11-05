import { mkdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { config_dir } from "../config.js";

export const MARKER_FOLDER = ".nemu";
export const MARKER_FILE = "vault.json";

const marker_schema = z.object({
  version: z.literal(1),
  vault_id: z.string().min(1),
  vault_name: z.string(),
  workspace_id: z.string().min(1).nullable(),
  server: z.string().url(),
  linked_at: z.string(),
  mode: z.enum(["standard", "private"]).optional(),
});

export type Marker = z.infer<typeof marker_schema>;

const base_schema = z.object({
  path: z.string(),
  note_id: z.string(),
  version: z.number().int(),
  hash: z.string(),
});

export type BaseEntry = z.infer<typeof base_schema>;

const settings_schema = z.object({
  conflicts: z.enum(["merge", "file"]).default("merge"),
  obsidian: z.boolean().default(false),
  obsidian_plugins: z.boolean().default(false),
});

export type DeviceSettings = z.infer<typeof settings_schema>;

const state_schema = z.object({
  version: z.literal(1),
  vault_id: z.string(),
  root: z.string(),
  cursor: z.number().int().nullable(),
  full_next: z.boolean().default(false),
  ignore_fingerprint: z.string().default(""),
  settings: settings_schema.default({ conflicts: "merge", obsidian: false, obsidian_plugins: false }),
  limits: z
    .object({
      max_file_bytes: z.number(),
      max_storage_bytes: z.number().nullable(),
      max_upload_file_bytes: z.number().optional(),
      part_bytes: z.number().optional(),
    })
    .nullable()
    .default(null),
  files: z.record(z.string(), base_schema),
  synced_at: z.string().nullable().default(null),
});

export type SyncState = z.infer<typeof state_schema>;

export function marker_path(root: string): string {
  return join(root, MARKER_FOLDER, MARKER_FILE);
}

export function lock_path(root: string): string {
  return join(root, MARKER_FOLDER, "lock");
}

export function state_folder(): string {
  return join(config_dir(), "vaults");
}

export function state_path_for(vault_id: string, folder = state_folder()): string {
  return join(folder, `${vault_id.replace(/[^\w-]/g, "")}.json`);
}

async function write_atomic(path: string, contents: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, contents, { encoding: "utf-8", mode });
  await rename(temporary, path);
}

async function read_json(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as unknown;
  } catch {
    return null;
  }
}

export async function read_marker(root: string): Promise<Marker | null> {
  const parsed = marker_schema.safeParse(await read_json(marker_path(root)));
  return parsed.success ? parsed.data : null;
}

export async function write_marker(root: string, marker: Marker): Promise<void> {
  await write_atomic(marker_path(root), `${JSON.stringify(marker, null, 2)}\n`, 0o644);
}

export async function remove_marker(root: string): Promise<void> {
  await rm(marker_path(root), { force: true });
  await rm(lock_path(root), { force: true });
  await rmdir(join(root, MARKER_FOLDER)).catch(() => undefined);
}

export async function find_root(start: string): Promise<string | null> {
  let current = resolve(start);
  for (;;) {
    if ((await read_marker(current)) !== null) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function empty_state(vault_id: string, root: string, settings?: Partial<DeviceSettings>): SyncState {
  return {
    version: 1,
    vault_id,
    root,
    cursor: null,
    full_next: true,
    ignore_fingerprint: "",
    settings: {
      conflicts: settings?.conflicts ?? "merge",
      obsidian: settings?.obsidian ?? false,
      obsidian_plugins: settings?.obsidian_plugins ?? false,
    },
    limits: null,
    files: {},
    synced_at: null,
  };
}

export async function read_state(path: string): Promise<SyncState | null> {
  const parsed = state_schema.safeParse(await read_json(path));
  return parsed.success ? parsed.data : null;
}

export async function write_state(path: string, state: SyncState): Promise<void> {
  await write_atomic(path, JSON.stringify(state), 0o600);
}

export async function remove_state(path: string): Promise<void> {
  await rm(path, { force: true });
}
