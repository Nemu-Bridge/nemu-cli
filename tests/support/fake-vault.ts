import { createHash, randomUUID } from "node:crypto";
import type { Transport, TransportOptions } from "../../src/vault/api.js";

interface FakeVersion {
  version: number;
  path: string;
  sealed_path?: string;
  hash: string;
  content: Buffer;
  deleted: boolean;
  client: string | null;
}

export interface FakeMerge {
  path: string;
  merged_version: number;
  remote_version: number;
  content: string;
  client: string;
}

interface FakeNote {
  id: string;
  path: string;
  sealed_path?: string;
  key: string;
  version: number;
  hash: string;
  content: Buffer;
  deleted: boolean;
  revision: number;
  versions: FakeVersion[];
}

function key_of(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

function hash_of(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export class FakeVault {
  readonly id = randomUUID();
  mode: "standard" | "private" = "standard";
  revision = 0;
  pruned_revision = 0;
  max_file_bytes = 4 * 1024 * 1024;
  max_upload_file_bytes: number | null = null;
  readonly uploads = new Map<
    string,
    { path: string; size: number; base_version: number | null; sealed_path?: string; content_hash?: string; parts: Map<number, Buffer> }
  >();
  storage_full = false;
  refuse: { status: number; code: string } | null = null;
  requests = 0;
  readonly notes = new Map<string, FakeNote>();

  private present(note: FakeNote) {
    return {
      id: note.id,
      path: note.path,
      ...(note.sealed_path === undefined ? {} : { sealed_path: note.sealed_path }),
      kind: /\.md$/i.test(note.path) ? "markdown" : "file",
      version: note.version,
      hash: note.hash,
      size: note.content.length,
      revision: note.revision,
      deleted: note.deleted,
    };
  }

  private by_key(key: string): FakeNote | undefined {
    for (const note of this.notes.values()) if (note.key === key) return note;
    return undefined;
  }

  private commit(note: FakeNote, change: Partial<FakeNote>, client: string | null): FakeNote {
    this.revision += 1;
    Object.assign(note, change, { revision: this.revision, version: note.version + 1 });
    note.versions.push({
      version: note.version,
      path: note.path,
      sealed_path: note.sealed_path,
      hash: note.hash,
      content: note.content,
      deleted: note.deleted,
      client,
    });
    return note;
  }

  write(
    path: string,
    content: Buffer,
    client: string | null = "test",
    sealed?: { sealed_path: string; hash: string },
  ): FakeNote {
    const existing = this.by_key(key_of(path));
    const note: FakeNote =
      existing ?? {
        id: randomUUID(),
        path,
        key: key_of(path),
        version: 0,
        hash: "",
        content: Buffer.alloc(0),
        deleted: false,
        revision: 0,
        versions: [],
      };
    if (existing === undefined) this.notes.set(note.id, note);
    return this.commit(
      note,
      {
        path: path.normalize("NFC"),
        content,
        hash: sealed?.hash ?? hash_of(content),
        sealed_path: sealed?.sealed_path,
        deleted: false,
      },
      client,
    );
  }

  live(): Map<string, string> {
    const files = new Map<string, string>();
    for (const note of this.notes.values()) {
      if (!note.deleted) files.set(note.path, note.content.toString("utf-8"));
    }
    return files;
  }

  transport: Transport = async (method: string, path: string, options: TransportOptions) => {
    this.requests += 1;
    if (this.refuse !== null) {
      return json(this.refuse.status, { error: "refused", code: this.refuse.code });
    }
    const query = options.query ?? {};
    const headers = options.headers ?? {};
    const base = `/api/v1/vaults/${this.id}`;
    const client = headers["x-nemu-client"] ?? null;
    const body = options.body === undefined ? Buffer.alloc(0) : Buffer.from(options.body);

    if (method === "GET" && path === base) {
      return json(200, {
        data: { id: this.id, name: "Test", mode: this.mode, revision: this.revision },
        workspace_id: "ws_test",
        limits: {
          max_file_bytes: this.max_file_bytes,
          max_storage_bytes: null,
          ...(this.max_upload_file_bytes === null
            ? {}
            : { max_upload_file_bytes: this.max_upload_file_bytes, part_bytes: this.max_file_bytes }),
        },
      });
    }
    if (method === "POST" && path === `${base}/uploads`) {
      const start = JSON.parse(body.toString("utf-8")) as {
        path: string;
        size: number;
        base_version: number | null;
        sealed_path?: string;
        content_hash?: string;
      };
      if (this.max_upload_file_bytes === null || start.size > this.max_upload_file_bytes) {
        return json(413, { error: "too large", code: "file_too_large" });
      }
      const upload_id = randomUUID();
      this.uploads.set(upload_id, { ...start, parts: new Map() });
      return json(201, {
        data: { upload_id, part_bytes: this.max_file_bytes, parts: Math.ceil(start.size / this.max_file_bytes) },
      });
    }
    const upload_match = path.startsWith(`${base}/uploads/`) ? path.slice(`${base}/uploads/`.length).split("/") : null;
    if (upload_match !== null) {
      const upload = this.uploads.get(upload_match[0] ?? "");
      if (upload === undefined) return json(404, { error: "unknown upload", code: "upload_not_found" });
      if (method === "PUT" && upload_match.length === 2) {
        upload.parts.set(Number(upload_match[1]), body);
        return json(200, { data: { received: upload.parts.size } });
      }
      if (method === "DELETE") {
        this.uploads.delete(upload_match[0] ?? "");
        return new Response(null, { status: 204 });
      }
      if (method === "POST") {
        this.uploads.delete(upload_match[0] ?? "");
        const joined = Buffer.concat(
          [...upload.parts.entries()].sort(([left], [right]) => left - right).map(([, part]) => part),
        );
        if (joined.length !== upload.size) return json(422, { error: "corrupt", code: "upload_corrupt" });
        const saved_limit = this.max_file_bytes;
        this.max_file_bytes = Number.MAX_SAFE_INTEGER;
        try {
          return await this.transport("PUT", `${base}/files`, {
            query: { path: upload.path },
            headers: {
              ...(client === null ? {} : { "x-nemu-client": client }),
              ...(upload.base_version === null ? { "if-none-match": "*" } : { "if-match": `"${upload.base_version}"` }),
              ...(upload.sealed_path === undefined || upload.content_hash === undefined
                ? {}
                : { "x-nemu-sealed-path": upload.sealed_path, "x-nemu-content-mac": upload.content_hash }),
            },
            body: joined,
          });
        } finally {
          this.max_file_bytes = saved_limit;
        }
      }
    }
    if (method === "GET" && path === `${base}/notes`) {
      const trash = query.trash === "true";
      return json(200, {
        vault: { id: this.id, name: "Test", revision: this.revision },
        data: [...this.notes.values()].filter((note) => note.deleted === trash).map((note) => this.present(note)),
      });
    }
    if (method === "GET" && path === `${base}/changes`) {
      const since = Number(query.since ?? 0);
      if (since < this.pruned_revision) return json(410, { error: "resync", code: "resync_required" });
      const changed = [...this.notes.values()]
        .filter((note) => note.revision > since)
        .sort((left, right) => left.revision - right.revision);
      return json(200, { data: changed.map((note) => this.present(note)), revision: this.revision, has_more: false });
    }
    if (path === `${base}/files`) {
      const file_path = String(query.path ?? "").normalize("NFC");
      const existing = this.by_key(key_of(file_path));
      if (method === "GET") {
        if (existing === undefined || existing.deleted) return json(404, { error: "Note not found", code: "not_found" });
        return new Response(new Uint8Array(existing.content), {
          status: 200,
          headers: {
            "x-nemu-note-id": existing.id,
            "x-nemu-version": String(existing.version),
            "x-nemu-hash": existing.hash,
          },
        });
      }
      if (method === "PUT") {
        if (this.refuse_write !== null) return json(this.refuse_write.status, { error: "full", code: this.refuse_write.code });
        if (body.length > this.max_file_bytes) return json(413, { error: "too large", code: "file_too_large" });
        const is_new = headers["if-none-match"] === "*";
        const match = Number((headers["if-match"] ?? "").replace(/"/g, ""));
        const ok = is_new
          ? existing === undefined || existing.deleted
          : existing !== undefined && existing.version === match;
        if (!ok) {
          return json(409, { error: "conflict", code: "conflict", current: existing === undefined ? null : this.present(existing) });
        }
        const sealed_path = headers["x-nemu-sealed-path"];
        const mac = headers["x-nemu-content-mac"];
        if ((this.mode === "private") !== (sealed_path !== undefined && mac !== undefined)) {
          return json(400, { error: "wrong mode", code: this.mode === "private" ? "private_vault" : "not_private" });
        }
        const incoming_hash = mac ?? hash_of(body);
        if (
          existing !== undefined &&
          !existing.deleted &&
          existing.hash === incoming_hash &&
          existing.path === file_path &&
          existing.sealed_path === sealed_path
        ) {
          return json(200, { data: this.present(existing), changed: false });
        }
        const note = this.write(
          file_path,
          body,
          client,
          sealed_path === undefined || mac === undefined ? undefined : { sealed_path, hash: mac },
        );
        return json(note.version === 1 ? 201 : 200, { data: this.present(note), changed: true });
      }
      if (method === "DELETE") {
        if (existing === undefined || existing.deleted) {
          return json(404, { error: "Note not found", code: "not_found", current: existing === undefined ? null : this.present(existing) });
        }
        if (existing.version !== Number(query.version)) {
          return json(409, { error: "conflict", code: "conflict", current: this.present(existing) });
        }
        this.commit(existing, { deleted: true }, client);
        return json(200, { data: this.present(existing) });
      }
    }
    if (method === "POST" && path === `${base}/files/move`) {
      const input = JSON.parse(body.toString("utf-8")) as {
        from: string;
        to: string;
        base_version: number;
        sealed_path?: string;
        content_hash?: string;
        content?: string;
      };
      if (this.mode === "private" && (input.sealed_path === undefined || input.content === undefined)) {
        return json(400, { error: "sealed move needed", code: "private_vault" });
      }
      const note = this.by_key(key_of(input.from));
      if (note === undefined || note.deleted) return json(404, { error: "Note not found", code: "not_found" });
      if (note.version !== input.base_version) {
        return json(409, { error: "conflict", code: "conflict", current: this.present(note) });
      }
      if (note.path === input.to && this.mode !== "private") return json(200, { data: this.present(note) });
      const occupant = this.by_key(key_of(input.to));
      if (occupant !== undefined && occupant.id !== note.id) {
        if (!occupant.deleted) {
          return json(409, { error: "taken", code: "path_taken", current: this.present(occupant) });
        }
        occupant.key = `\u0000${occupant.id}`;
        this.commit(occupant, {}, client);
      }
      this.commit(
        note,
        {
          path: input.to.normalize("NFC"),
          key: key_of(input.to),
          ...(this.mode === "private"
            ? {
                sealed_path: input.sealed_path,
                hash: input.content_hash ?? "",
                content: Buffer.from(input.content ?? "", "base64url"),
              }
            : {}),
        },
        client,
      );
      return json(200, { data: this.present(note) });
    }
    if (method === "POST" && path === `${base}/merges`) {
      if (this.refuse_merges !== null) {
        return json(this.refuse_merges.status, { error: "merge log refused", code: this.refuse_merges.code });
      }
      const input = JSON.parse(body.toString("utf-8")) as FakeMerge;
      this.merges.push(input);
      return json(201, { data: { id: randomUUID(), path: input.path } });
    }
    if (method === "GET" && path === `${base}/history/version`) {
      const note = this.notes.get(String(query.note_id));
      const version = note?.versions.find((entry) => entry.version === Number(query.version));
      if (version === undefined) return json(404, { error: "Version not found", code: "not_found" });
      return new Response(new Uint8Array(version.content), { status: 200 });
    }
    if (method === "GET" && path === `${base}/history`) {
      const note = this.notes.get(String(query.note_id));
      if (note === undefined) return json(404, { error: "Note not found", code: "not_found" });
      return json(200, {
        data: [...note.versions].reverse().map((version) => ({
          version: version.version,
          path: version.path,
          ...(version.sealed_path === undefined ? {} : { sealed_path: version.sealed_path }),
          hash: version.hash,
          size: version.content.length,
          deleted: version.deleted,
          origin: "device",
          origin_id: null,
          client: version.client,
          created_at: new Date().toISOString(),
        })),
      });
    }
    return json(404, { error: `No route ${method} ${path}`, code: "not_found" });
  };

  refuse_write: { status: number; code: string } | null = null;
  refuse_merges: { status: number; code: string } | null = null;
  readonly merges: FakeMerge[] = [];
}
