import { join } from "node:path";
import { mkdir, rm, stat } from "node:fs/promises";
import { z } from "zod";
import {
  client_id,
  config_dir,
  read_credentials,
  write_credentials,
  type StoredCredentials,
} from "../config.js";
import { CliError } from "../errors.js";

const EXPIRY_SKEW_MS = 90_000;
const LOCK_WAIT_MS = 15_000;
const LOCK_STALE_MS = 30_000;

const token_response = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive().optional(),
  scope: z.string().optional(),
});

const token_error = z.object({
  error: z.string().optional(),
  error_description: z.string().optional(),
});

function lock_path(): string {
  return join(config_dir(), "refresh.lock");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquire_lock(): Promise<() => Promise<void>> {
  await mkdir(config_dir(), { recursive: true, mode: 0o700 });
  const path = lock_path();
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      await mkdir(path);
      return async () => {
        await rm(path, { recursive: true, force: true });
      };
    } catch {
      const info = await stat(path).catch(() => null);
      if (info !== null && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        await rm(path, { recursive: true, force: true });
        continue;
      }
      await sleep(150);
    }
  }
  throw new CliError(
    "Another Nemu process is refreshing the sign in. Try again in a moment.",
    "refresh_lock_timeout",
  );
}

function is_fresh(credentials: StoredCredentials): boolean {
  return Date.now() < credentials.expires_at - EXPIRY_SKEW_MS;
}

async function refresh(credentials: StoredCredentials): Promise<StoredCredentials> {
  if (credentials.refresh_token === undefined) {
    throw new CliError("Your sign in expired. Run nemu login.", "not_signed_in");
  }
  let response: Response;
  try {
    response = await fetch(`${credentials.api_url}/api/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: credentials.refresh_token,
        client_id: client_id(),
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new CliError(`Could not reach ${credentials.api_url}.`, "network_failed");
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = token_error.safeParse(body);
    const code = failure.success ? failure.data.error : undefined;
    if (code === "invalid_grant" || response.status === 400 || response.status === 401) {
      throw new CliError("Your sign in expired. Run nemu login.", "not_signed_in");
    }
    throw new CliError("Refreshing the sign in failed.", "refresh_failed", {
      status: response.status,
    });
  }
  const parsed = token_response.safeParse(body);
  if (!parsed.success) {
    throw new CliError("The sign in server sent an unexpected answer.", "refresh_invalid");
  }
  const next: StoredCredentials = {
    ...credentials,
    access_token: parsed.data.access_token,
    refresh_token: parsed.data.refresh_token ?? credentials.refresh_token,
    expires_at: Date.now() + (parsed.data.expires_in ?? 3600) * 1000,
    scope: parsed.data.scope ?? credentials.scope,
  };
  await write_credentials(next);
  return next;
}

export async function fresh_credentials(): Promise<StoredCredentials> {
  const current = await read_credentials();
  if (current === null) {
    throw new CliError("Not signed in. Run nemu login.", "not_signed_in");
  }
  if (current.kind === "key" || is_fresh(current)) return current;

  const release = await acquire_lock();
  try {
    const latest = await read_credentials();
    if (latest === null) {
      throw new CliError("Not signed in. Run nemu login.", "not_signed_in");
    }
    if (is_fresh(latest)) return latest;
    return await refresh(latest);
  } finally {
    await release();
  }
}
