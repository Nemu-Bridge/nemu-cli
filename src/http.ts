import { z } from "zod";
import { API_VERSION, read_settings } from "./config.js";
import { fresh_credentials } from "./auth/token.js";
import { CliError } from "./errors.js";
import { VERSION } from "./version.js";

const error_body = z.object({
  error: z.string().optional(),
  code: z.string().optional(),
  reference: z.string().optional(),
});

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  device?: boolean;
  timeout_ms?: number;
}

export interface SendOptions {
  query?: Record<string, string | number | undefined>;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
  device?: boolean;
  workspace?: string;
  timeout_ms?: number;
}

export interface Sent {
  api_url: string;
  response: Response;
}

export async function send(method: string, path: string, options: SendOptions = {}): Promise<Sent> {
  const credentials = await fresh_credentials();
  const settings = await read_settings();
  const url = new URL(`${credentials.api_url}${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const headers: Record<string, string> = {
    authorization: `Bearer ${credentials.access_token}`,
    "nemu-api-version": API_VERSION,
    "user-agent": `nemu-cli/${VERSION}`,
    ...(options.headers ?? {}),
  };
  const is_key = credentials.kind === "key";
  if (
    !is_key &&
    options.device !== false &&
    settings.device_id !== undefined &&
    settings.device_api_url === credentials.api_url
  ) {
    headers["x-nemu-device"] = settings.device_id;
  }
  const workspace = options.workspace ?? settings.context_workspace;
  if (!is_key && workspace !== undefined) {
    headers["x-nemu-workspace"] = workspace;
  }

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: options.body,
      signal: AbortSignal.timeout(options.timeout_ms ?? 20_000),
    });
    return { api_url: credentials.api_url, response };
  } catch {
    throw new CliError(`Could not reach ${credentials.api_url}.`, "network_failed");
  }
}

export async function failure_of(response: Response): Promise<CliError> {
  const payload: unknown = await response.json().catch(() => null);
  const failure = error_body.safeParse(payload);
  const message = failure.success && failure.data.error !== undefined
    ? failure.data.error
    : `Request failed with status ${response.status}`;
  return new CliError(
    message,
    failure.success && failure.data.code !== undefined ? failure.data.code : `http_${response.status}`,
    {
      status: response.status,
      reference:
        (failure.success ? failure.data.reference : undefined) ??
        response.headers.get("x-nemu-reference") ??
        undefined,
    },
  );
}

export async function api<T>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  schema: z.ZodType<T>,
  options: RequestOptions = {},
): Promise<T> {
  const { response } = await send(method, path, {
    query: options.query,
    headers: options.body !== undefined ? { "content-type": "application/json" } : {},
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    device: options.device,
    timeout_ms: options.timeout_ms,
  });

  if (!response.ok) throw await failure_of(response);
  const payload: unknown = await response.json().catch(() => null);
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new CliError("Nemu sent an answer this CLI does not understand. Update nemu-cli.", "invalid_response");
  }
  return parsed.data;
}
