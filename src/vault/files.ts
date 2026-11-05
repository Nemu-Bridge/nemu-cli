import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { check_path, normalize_path, path_key } from "./paths.js";
import { is_ignored, type IgnoreOptions } from "./ignore.js";

export interface LocalEntry {
  path: string;
  disk: string;
  hash: string;
  size: number;
}

export interface Skipped {
  path: string;
  reason: string;
}

export interface ScanResult {
  files: Map<string, LocalEntry>;
  skipped: Skipped[];
}

export type Hasher = (content: Uint8Array) => string;

export function hash_of(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function disk_path(root: string, relative: string): string {
  return join(root, ...relative.split("/"));
}

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export async function scan_folder(
  root: string,
  ignore: IgnoreOptions,
  max_file_bytes: number,
  preferred: (key: string) => string | undefined = () => undefined,
  hasher: Hasher = hash_of,
): Promise<ScanResult> {
  const files = new Map<string, LocalEntry>();
  const skipped: Skipped[] = [];
  const clashes = new Map<string, LocalEntry[]>();

  const walk = async (relative_folder: string): Promise<void> => {
    const absolute = relative_folder === "" ? root : disk_path(root, relative_folder);
    const entries = await readdir(absolute, { withFileTypes: true }).catch(() => []);
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const disk = relative_folder === "" ? entry.name : `${relative_folder}/${entry.name}`;
      const path = normalize_path(disk);
      if (entry.isSymbolicLink()) {
        if (!is_ignored(path, ignore)) skipped.push({ path, reason: "a symbolic link, never followed" });
        continue;
      }
      if (entry.isDirectory()) {
        if (relative_folder === "" && entry.name === ".nemu") continue;
        if (is_ignored(path, ignore, true)) continue;
        await walk(disk);
        continue;
      }
      if (!entry.isFile()) continue;
      if (is_ignored(path, ignore)) continue;
      const checked = check_path(path);
      if (!checked.ok) {
        skipped.push({ path, reason: `not synced: ${checked.error}` });
        continue;
      }
      const info = await lstat(disk_path(root, disk)).catch(() => null);
      if (info === null || !info.isFile()) continue;
      if (info.size > max_file_bytes) {
        skipped.push({
          path,
          reason: `${megabytes(info.size)}, above the ${megabytes(max_file_bytes)} your plan allows per file`,
        });
        continue;
      }
      const content = await readFile(disk_path(root, disk)).catch(() => null);
      if (content === null) continue;
      const local: LocalEntry = { path, disk, hash: hasher(content), size: content.length };
      const key = path_key(path);
      const group = clashes.get(key) ?? [];
      group.push(local);
      clashes.set(key, group);
    }
  };

  await walk("");

  for (const [key, group] of clashes) {
    if (group.length === 1) {
      files.set(key, group[0]!);
      continue;
    }
    const wanted = preferred(key);
    const keep = group.find((entry) => entry.path === wanted) ?? group[0]!;
    files.set(key, keep);
    for (const entry of group) {
      if (entry === keep) continue;
      skipped.push({
        path: entry.path,
        reason: `differs from "${keep.path}" only by case, which macOS and Windows cannot hold side by side`,
      });
    }
  }
  return { files, skipped };
}

export async function read_hash(root: string, disk: string, hasher: Hasher = hash_of): Promise<string | null> {
  const content = await readFile(disk_path(root, disk)).catch(() => null);
  return content === null ? null : hasher(content);
}

export async function read_if(
  root: string,
  disk: string,
  expected_hash: string,
  hasher: Hasher = hash_of,
): Promise<Buffer | null> {
  const content = await readFile(disk_path(root, disk)).catch(() => null);
  if (content === null || hasher(content) !== expected_hash) return null;
  return content;
}

async function nearest_real(path: string): Promise<string | null> {
  let current = path;
  while (true) {
    const resolved = await realpath(current).catch(() => null);
    if (resolved !== null) return resolved;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export async function stays_inside(root: string, target: string): Promise<boolean> {
  const [real_root, real_folder] = await Promise.all([realpath(root).catch(() => null), nearest_real(dirname(target))]);
  if (real_root === null || real_folder === null) return false;
  return real_folder === real_root || real_folder.startsWith(real_root.endsWith(sep) ? real_root : `${real_root}${sep}`);
}

export async function write_atomic_file(
  root: string,
  relative: string,
  content: Uint8Array,
  expected: { disk: string; hash: string } | null,
  hasher: Hasher = hash_of,
): Promise<boolean> {
  const target = disk_path(root, relative);
  if (!(await stays_inside(root, target))) return false;
  if (expected === null) {
    const exists = await lstat(target).then(
      () => true,
      () => false,
    );
    if (exists) return false;
  } else if ((await read_hash(root, expected.disk, hasher)) !== expected.hash) {
    return false;
  }
  await mkdir(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.${basename(target)}.${randomBytes(4).toString("hex")}.nemu.tmp`);
  try {
    await writeFile(temporary, content);
    if (expected !== null && expected.disk !== relative) {
      await unlink(disk_path(root, expected.disk)).catch(() => undefined);
    }
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return true;
}

export async function rename_local(root: string, from: string, to: string): Promise<boolean> {
  const source = disk_path(root, from);
  const target = disk_path(root, to);
  if (!(await stays_inside(root, source)) || !(await stays_inside(root, target))) return false;
  const same_key = path_key(normalize_path(from)) === path_key(normalize_path(to));
  if (!same_key) {
    const occupied = await lstat(target).then(
      () => true,
      () => false,
    );
    if (occupied) return false;
  }
  await mkdir(dirname(target), { recursive: true });
  try {
    await rename(source, target);
  } catch {
    return false;
  }
  await prune_folders(root, dirname(from));
  return true;
}

export async function delete_local(
  root: string,
  disk: string,
  expected_hash: string,
  hasher: Hasher = hash_of,
): Promise<boolean> {
  if (!(await stays_inside(root, disk_path(root, disk)))) return false;
  if ((await read_hash(root, disk, hasher)) !== expected_hash) return false;
  await unlink(disk_path(root, disk));
  await prune_folders(root, dirname(disk));
  return true;
}

async function prune_folders(root: string, relative_folder: string): Promise<void> {
  let current = relative_folder.split("\\").join("/");
  while (current !== "." && current !== "" && current !== "/") {
    try {
      await rmdir(disk_path(root, current));
    } catch {
      return;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
