import { hash_of } from "./files.js";
import { z } from "zod";
import { CliError } from "../errors.js";

export interface TransportOptions {
  query?: Record<string, string | number | undefined>;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
  timeout_ms?: number;
}

export type Transport = (method: string, path: string, options: TransportOptions) => Promise<Response>;

const note_schema = z.object({
  id: z.string(),
  path: z.string(),
  kind: z.string(),
  version: z.number().int(),
  hash: z.string(),
  size: z.number(),
  revision: z.number(),
  deleted: z.boolean(),
  sealed_path: z.string().optional(),
});

export type RemoteNote = z.infer<typeof note_schema>;

const vault_schema = z.object({
  id: z.string(),
  name: z.string(),
  mode: z.enum(["standard", "private"]).optional(),
  revision: z.number(),
  notes: z.number().optional(),
  stored_bytes: z.number().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});

export type RemoteVault = z.infer<typeof vault_schema>;

const info_schema = z.object({
  data: vault_schema,
  workspace_id: z.string().optional(),
  limits: z
    .object({
      max_file_bytes: z.number(),
      max_storage_bytes: z.number().nullable(),
    })
    .optional(),
});

export type VaultInfo = z.infer<typeof info_schema>;

const version_schema = z.object({
  version: z.number().int(),
  path: z.string(),
  sealed_path: z.string().optional(),
  hash: z.string(),
  size: z.number(),
  deleted: z.boolean(),
  origin: z.string(),
  origin_id: z.string().nullable(),
  client: z.string().nullable(),
  created_at: z.string(),
});

export type RemoteVersion = z.infer<typeof version_schema>;

const failure_schema = z.object({
  error: z.string().optional(),
  code: z.string().optional(),
  reference: z.string().optional(),
  retry_after: z.number().optional(),
  current: note_schema.nullable().optional(),
});

export class RemoteError extends CliError {
  readonly current: RemoteNote | null | undefined;

  constructor(
    message: string,
    code: string,
    status: number,
    current: RemoteNote | null | undefined,
    reference: string | undefined,
  ) {
    super(message, code, { status, reference });
    this.name = "RemoteError";
    this.current = current;
  }
}

const MAX_WAIT_MS = 60_000;
const ATTEMPTS = 4;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function error_of(response: Response): Promise<RemoteError> {
  const parsed = failure_schema.safeParse(await response.json().catch(() => null));
  const body = parsed.success ? parsed.data : {};
  return new RemoteError(
    body.error ?? `Request failed with status ${response.status}`,
    body.code ?? `http_${response.status}`,
    response.status,
    body.current,
    body.reference ?? response.headers.get("x-nemu-reference") ?? undefined,
  );
}

function retry_delay(response: Response, attempt: number): number {
  const header = Number(response.headers.get("retry-after") ?? "");
  const seconds = Number.isFinite(header) && header > 0 ? header : 2 ** attempt;
  return Math.min(MAX_WAIT_MS, seconds * 1000);
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new CliError("Nemu sent an answer this CLI does not understand. Update nemu-cli.", "invalid_response");
  }
  return parsed.data;
}

export interface SealedWrite {
  sealed_path: string;
  content_hash: string;
}

export interface VaultClient {
  readonly vault_id: string;
  hash(content: Uint8Array): string;
  info(): Promise<VaultInfo>;
  notes(trash?: boolean): Promise<{ revision: number; notes: RemoteNote[] }>;
  changes(since: number): Promise<{ notes: RemoteNote[]; revision: number; has_more: boolean }>;
  read(path: string): Promise<{ content: Buffer; id: string; version: number; hash: string }>;
  write(path: string, content: Uint8Array, base_version: number | null): Promise<RemoteNote>;
  remove(path: string, version: number): Promise<RemoteNote>;
  move(from: string, to: string, base_version: number): Promise<RemoteNote>;
  record_merge(input: { path: string; merged_version: number; remote_version: number; local: Uint8Array }): Promise<void>;
  read_version(note_id: string, version: number): Promise<Buffer>;
  history(note_id: string, limit?: number): Promise<RemoteVersion[]>;
}

export class VaultApi implements VaultClient {
  constructor(
    private readonly transport: Transport,
    readonly vault_id: string,
    private readonly client_label: string,
  ) {}

  private async call(method: string, path: string, options: TransportOptions = {}): Promise<Response> {
    for (let attempt = 1; ; attempt += 1) {
      const response = await this.transport(method, path, options);
      if (response.status !== 429 || attempt >= ATTEMPTS) {
        if (!response.ok) throw await error_of(response);
        return response;
      }
      await response.body?.cancel().catch(() => undefined);
      await wait(retry_delay(response, attempt));
    }
  }

  hash(content: Uint8Array): string {
    return hash_of(content);
  }

  private base(): string {
    return `/api/v1/vaults/${encodeURIComponent(this.vault_id)}`;
  }

  async info(): Promise<VaultInfo> {
    const response = await this.call("GET", this.base());
    return parse(info_schema, await response.json());
  }

  async notes(trash = false): Promise<{ revision: number; notes: RemoteNote[] }> {
    const response = await this.call("GET", `${this.base()}/notes`, {
      query: trash ? { trash: "true" } : {},
    });
    const body = parse(
      z.object({ vault: vault_schema, data: z.array(note_schema) }),
      await response.json(),
    );
    return { revision: body.vault.revision, notes: body.data };
  }

  async changes(since: number): Promise<{ notes: RemoteNote[]; revision: number; has_more: boolean }> {
    const response = await this.call("GET", `${this.base()}/changes`, {
      query: { since },
    });
    const body = parse(
      z.object({ data: z.array(note_schema), revision: z.number(), has_more: z.boolean() }),
      await response.json(),
    );
    return { notes: body.data, revision: body.revision, has_more: body.has_more };
  }

  async read(path: string): Promise<{ content: Buffer; id: string; version: number; hash: string }> {
    const response = await this.call("GET", `${this.base()}/files`, {
      query: { path },
      timeout_ms: 120_000,
    });
    const content = Buffer.from(await response.arrayBuffer());
    const id = response.headers.get("x-nemu-note-id");
    const version = Number(response.headers.get("x-nemu-version"));
    const hash = response.headers.get("x-nemu-hash");
    if (id === null || hash === null || !Number.isInteger(version)) {
      throw new CliError("Nemu sent a file without its version. Update nemu-cli.", "invalid_response");
    }
    return { content, id, version, hash };
  }

  async write(
    path: string,
    content: Uint8Array,
    base_version: number | null,
    sealed?: SealedWrite,
  ): Promise<RemoteNote> {
    const response = await this.call("PUT", `${this.base()}/files`, {
      query: { path },
      headers: {
        "content-type": "application/octet-stream",
        "x-nemu-client": this.client_label,
        ...(base_version === null ? { "if-none-match": "*" } : { "if-match": `"${base_version}"` }),
        ...(sealed === undefined
          ? {}
          : { "x-nemu-sealed-path": sealed.sealed_path, "x-nemu-content-mac": sealed.content_hash }),
      },
      body: content,
      timeout_ms: 120_000,
    });
    return parse(z.object({ data: note_schema }), await response.json()).data;
  }

  async remove(path: string, version: number): Promise<RemoteNote> {
    const response = await this.call("DELETE", `${this.base()}/files`, {
      query: { path, version },
      headers: { "x-nemu-client": this.client_label },
    });
    return parse(z.object({ data: note_schema }), await response.json()).data;
  }

  async move(
    from: string,
    to: string,
    base_version: number,
    sealed?: SealedWrite & { content: Uint8Array },
  ): Promise<RemoteNote> {
    const response = await this.call("POST", `${this.base()}/files/move`, {
      headers: { "content-type": "application/json", "x-nemu-client": this.client_label },
      body: JSON.stringify({
        from,
        to,
        base_version,
        ...(sealed === undefined
          ? {}
          : {
              sealed_path: sealed.sealed_path,
              content_hash: sealed.content_hash,
              content: Buffer.from(sealed.content).toString("base64url"),
            }),
      }),
    });
    return parse(z.object({ data: note_schema }), await response.json()).data;
  }

  async record_merge(input: {
    path: string;
    merged_version: number;
    remote_version: number;
    local: Uint8Array;
  }): Promise<void> {
    await this.call("POST", `${this.base()}/merges`, {
      headers: { "content-type": "application/json", "x-nemu-client": this.client_label },
      body: JSON.stringify({
        path: input.path,
        merged_version: input.merged_version,
        remote_version: input.remote_version,
        content: Buffer.from(input.local).toString("base64"),
        client: this.client_label,
      }),
      timeout_ms: 120_000,
    });
  }

  async read_version(note_id: string, version: number): Promise<Buffer> {
    const response = await this.call("GET", `${this.base()}/history/version`, {
      query: { note_id, version },
      timeout_ms: 120_000,
    });
    return Buffer.from(await response.arrayBuffer());
  }

  async history(note_id: string, limit = 200): Promise<RemoteVersion[]> {
    const response = await this.call("GET", `${this.base()}/history`, {
      query: { note_id, limit },
    });
    return parse(z.object({ data: z.array(version_schema) }), await response.json()).data;
  }
}

const lock_schema = z.object({
  id: z.string(),
  kind: z.string(),
  label: z.string(),
  params: z.record(z.string(), z.union([z.string(), z.number()])),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
});

export type RemoteLock = z.infer<typeof lock_schema>;

const key_request_schema = z.object({
  id: z.string(),
  label: z.string(),
  commitment: z.string(),
  approver_key: z.string().nullable(),
  public_key: z.string().nullable(),
  nonce: z.string().nullable(),
  created_at: z.string(),
  expires_at: z.string(),
});

export type RemoteKeyRequest = z.infer<typeof key_request_schema>;

export class LockApi {
  constructor(
    private readonly transport: Transport,
    readonly vault_id: string,
  ) {}

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await this.transport(method, `/api/v1/vaults/${encodeURIComponent(this.vault_id)}${path}`, {
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    if (!response.ok) throw await error_of(response);
    return response.json();
  }

  async locks(): Promise<RemoteLock[]> {
    return parse(z.object({ data: z.array(lock_schema) }), await this.call("GET", "/locks")).data;
  }

  async wrapped(lock_id: string): Promise<string> {
    return parse(
      z.object({ data: z.object({ wrapped: z.string() }) }),
      await this.call("GET", `/locks/${encodeURIComponent(lock_id)}`),
    ).data.wrapped;
  }

  async add(lock: NewLock): Promise<string> {
    return parse(z.object({ data: z.object({ id: z.string() }) }), await this.call("POST", "/locks", lock)).data.id;
  }

  async remove(lock_id: string): Promise<void> {
    await this.call("DELETE", `/locks/${encodeURIComponent(lock_id)}`);
  }

  async requests(): Promise<RemoteKeyRequest[]> {
    return parse(z.object({ data: z.array(key_request_schema) }), await this.call("GET", "/requests")).data;
  }

  async ask(commitment: string, label: string): Promise<{ id: string; expires_at: string }> {
    return parse(
      z.object({ data: z.object({ id: z.string(), expires_at: z.string() }) }),
      await this.call("POST", "/requests", { commitment, label }),
    ).data;
  }

  async answer_of(request_id: string): Promise<{ status: string; approver_key?: string; wrapped?: string }> {
    return parse(
      z.object({
        data: z.object({
          status: z.string(),
          approver_key: z.string().optional(),
          wrapped: z.string().optional(),
        }),
      }),
      await this.call("GET", `/requests/${encodeURIComponent(request_id)}`),
    ).data;
  }

  async reveal(request_id: string, public_key: string, nonce: string): Promise<void> {
    await this.call("POST", `/requests/${encodeURIComponent(request_id)}/reveal`, { public_key, nonce });
  }

  async offer(request_id: string, approver_key: string): Promise<void> {
    await this.call("POST", `/requests/${encodeURIComponent(request_id)}/offer`, { approver_key });
  }

  async request(request_id: string): Promise<RemoteKeyRequest | null> {
    return (await this.requests()).find((entry) => entry.id === request_id) ?? null;
  }

  async answer(request_id: string, wrapped: string | null): Promise<void> {
    await this.call("POST", `/requests/${encodeURIComponent(request_id)}`, { wrapped });
  }
}

export async function list_vaults(transport: Transport): Promise<RemoteVault[]> {
  const response = await transport("GET", "/api/v1/vaults", {});
  if (!response.ok) throw await error_of(response);
  return parse(z.object({ data: z.array(vault_schema) }), await response.json()).data;
}

export interface NewLock {
  kind: "password" | "recovery" | "passkey";
  label: string;
  params: Record<string, string | number>;
  wrapped: string;
}

export async function create_vault(
  transport: Transport,
  name: string,
  privacy?: { id: string; locks: NewLock[] },
): Promise<RemoteVault> {
  const response = await transport("POST", "/api/v1/vaults", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      privacy === undefined ? { name } : { name, id: privacy.id, mode: "private", locks: privacy.locks },
    ),
  });
  if (!response.ok) throw await error_of(response);
  return parse(z.object({ data: vault_schema }), await response.json()).data;
}
