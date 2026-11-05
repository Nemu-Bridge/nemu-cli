import { z } from "zod";
import { api } from "../http.js";

const date = z.string().min(1);

export const project_schema = z.object({
  id: z.string(),
  kind: z.string(),
  name: z.string(),
  root_commit: z.string().nullable(),
  remote_url: z.string().nullable(),
  linked_computer_project_id: z.string().nullable(),
  created_at: date,
  updated_at: date,
  last_used_at: date.nullable(),
  entry_count: z.number().optional(),
});

export const entry_schema = z.object({
  id: z.string(),
  project_id: z.string(),
  name: z.string(),
  tag: z.string(),
  subject: z.string(),
  body: z.string(),
  state: z.string(),
  refs: z.array(z.string()),
  branch: z.string().nullable(),
  commit: z.string().nullable(),
  origin: z.object({ kind: z.string(), id: z.string().nullable() }),
  client: z.string().nullable(),
  pinned: z.boolean(),
  stale: z.boolean(),
  created_at: date,
  updated_at: date,
});

const load_schema = z.object({
  project: z.object({ id: z.string(), name: z.string() }),
  branch: z.string().nullable(),
  handoff: entry_schema.nullable().optional(),
  pinned: z.array(entry_schema).optional(),
  index: z
    .array(
      z.object({
        name: z.string(),
        stale: z.boolean(),
        refs: z.array(z.string()).optional(),
        commit: z.string().nullable().optional(),
      }),
    )
    .optional(),
  truncated: z.boolean(),
  text: z.string(),
});

export type LoadResult = z.infer<typeof load_schema>;

const device_schema = z.object({
  id: z.string().regex(/^dev_[a-z2-7]{12}$/),
  name: z.string(),
});

export type Project = z.infer<typeof project_schema>;
export type Entry = z.infer<typeof entry_schema>;

export interface ProjectIdentity {
  name: string;
  root_commit?: string;
  remote_url?: string;
}

export interface EntryInput {
  name: string;
  subject: string;
  body: string;
  refs?: string[];
  state?: "current" | "superseded";
  branch?: string;
  commit?: string;
  pinned?: boolean;
  client?: string;
}

export async function open_project(identity: ProjectIdentity): Promise<Project> {
  const result = await api(
    "POST",
    "/api/v1/projects",
    z.object({ data: project_schema }),
    { body: identity },
  );
  return result.data;
}

export async function list_projects(): Promise<Project[]> {
  const result = await api("GET", "/api/v1/projects", z.object({ data: z.array(project_schema) }));
  return result.data;
}

export async function load_project(project_id: string, branch?: string) {
  const result = await api(
    "GET",
    `/api/v1/projects/${encodeURIComponent(project_id)}/load`,
    z.object({ data: load_schema }),
    { query: { branch } },
  );
  return result.data;
}

export async function search_project(project_id: string, query: string, limit = 10): Promise<Entry[]> {
  const result = await api(
    "GET",
    `/api/v1/projects/${encodeURIComponent(project_id)}/search`,
    z.object({ data: z.array(entry_schema) }),
    { query: { q: query, limit } },
  );
  return result.data;
}

export async function write_batch(project_id: string, entries: EntryInput[]) {
  const result = await api(
    "POST",
    `/api/v1/projects/${encodeURIComponent(project_id)}/entries/batch`,
    z.object({
      data: z.array(
        z.object({
          name: z.string(),
          status: z.enum(["created", "updated", "skipped"]),
          reason: z.string().optional(),
          redacted: z.boolean().optional(),
        }),
      ),
    }),
    { body: { entries } },
  );
  return result.data;
}

export async function register_device(input: {
  name: string;
  platform: string;
  client_version: string;
}) {
  const result = await api(
    "POST",
    "/api/v1/devices",
    z.object({ data: device_schema }),
    { body: input, device: false },
  );
  return result.data;
}

export async function mark_stale(project_id: string, stale: string[], fresh: string[]) {
  if (stale.length === 0 && fresh.length === 0) return;
  await api(
    "POST",
    `/api/v1/projects/${encodeURIComponent(project_id)}/stale`,
    z.object({ marked: z.number(), cleared: z.number() }),
    { body: { stale: stale.slice(0, 400), fresh: fresh.slice(0, 400) } },
  );
}

export async function list_devices() {
  const result = await api(
    "GET",
    "/api/v1/devices",
    z.object({
      data: z.array(
        z.object({ id: z.string(), name: z.string(), revoked_at: z.string().nullable() }),
      ),
    }),
    { device: false },
  );
  return result.data;
}

export async function export_all(): Promise<unknown> {
  const result = await api("GET", "/api/v1/projects/export", z.object({ data: z.unknown() }));
  return result.data;
}
