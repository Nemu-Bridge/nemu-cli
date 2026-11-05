import { hostname } from "node:os";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { CliError } from "../errors.js";
import { lock_path } from "./state.js";

const lock_schema = z.object({
  pid: z.number().int(),
  host: z.string(),
  started_at: z.string(),
  token: z.string(),
});

export interface HeldLock {
  release: () => Promise<void>;
}

function parse_lock(raw: string | null) {
  if (raw === null) return lock_schema.safeParse(null);
  try {
    return lock_schema.safeParse(JSON.parse(raw));
  } catch {
    return lock_schema.safeParse(null);
  }
}

function is_alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function try_create(path: string, contents: string): Promise<boolean> {
  try {
    const handle = await open(path, "wx", 0o644);
    try {
      await handle.writeFile(contents, "utf-8");
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

export async function acquire_lock(root: string, token: string): Promise<HeldLock> {
  const path = lock_path(root);
  await mkdir(dirname(path), { recursive: true });
  const contents = JSON.stringify({
    pid: process.pid,
    host: hostname(),
    started_at: new Date().toISOString(),
    token,
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await try_create(path, contents)) {
      return {
        release: async () => {
          const current = parse_lock(await readFile(path, "utf-8").catch(() => null));
          if (current.success && current.data.token === token) await rm(path, { force: true });
        },
      };
    }
    const raw = await readFile(path, "utf-8").catch(() => null);
    const existing = parse_lock(raw);
    if (!existing.success) {
      const info = await stat(path).catch(() => null);
      if (info !== null && Date.now() - info.mtimeMs < 5_000) {
        throw new CliError("Another nemu sync is starting on this folder.", "sync_locked");
      }
      await rm(path, { force: true });
      continue;
    }
    const stale = existing.data.host === hostname() && !is_alive(existing.data.pid);
    if (!stale) {
      throw new CliError(
        `Another nemu sync (process ${existing.data.pid} on ${existing.data.host}) is running on this folder. If it is not, delete ${path}.`,
        "sync_locked",
      );
    }
    await rm(path, { force: true });
  }
  throw new CliError(`Could not take the sync lock at ${path}.`, "sync_locked");
}
