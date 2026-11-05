import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { config_dir, read_credentials, write_private } from "../config.js";
import { repository, type RepositoryInfo } from "../git.js";
import { open_project, type Project } from "./api.js";

const CACHE_TTL_MS = 6 * 3_600_000;

const cache_schema = z.record(
  z.string(),
  z.object({ id: z.string(), name: z.string(), api_url: z.string(), saved_at: z.number() }),
);

function cache_path(): string {
  return join(config_dir(), "projects.json");
}

async function read_cache(): Promise<z.infer<typeof cache_schema>> {
  try {
    const parsed = cache_schema.safeParse(JSON.parse(await readFile(cache_path(), "utf-8")));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

function cache_key(info: RepositoryInfo): string {
  return info.root_commit !== undefined ? `commit:${info.root_commit}` : `path:${info.root}`;
}

export interface OpenedProject {
  id: string;
  name: string;
  repository: RepositoryInfo;
}

export async function current_project(cwd: string, use_cache = true): Promise<OpenedProject> {
  const info = await repository(cwd);
  const credentials = await read_credentials();
  const cache = await read_cache();
  const key = cache_key(info);
  const cached = cache[key];
  if (
    use_cache &&
    cached !== undefined &&
    credentials !== null &&
    cached.api_url === credentials.api_url &&
    Date.now() - cached.saved_at < CACHE_TTL_MS
  ) {
    return { id: cached.id, name: cached.name, repository: info };
  }

  const project: Project = await open_project({
    name: info.name.slice(0, 80),
    ...(info.root_commit !== undefined ? { root_commit: info.root_commit } : {}),
    ...(info.remote_url !== undefined ? { remote_url: info.remote_url.slice(0, 500) } : {}),
  });

  if (credentials !== null) {
    cache[key] = {
      id: project.id,
      name: project.name,
      api_url: credentials.api_url,
      saved_at: Date.now(),
    };
    await write_private(cache_path(), JSON.stringify(cache, null, 2)).catch(() => undefined);
  }
  return { id: project.id, name: project.name, repository: info };
}

export async function forget_cached_project(cwd: string): Promise<void> {
  const info = await repository(cwd);
  const cache = await read_cache();
  delete cache[cache_key(info)];
  await write_private(cache_path(), JSON.stringify(cache, null, 2)).catch(() => undefined);
}
