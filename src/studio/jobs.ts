import { z } from "zod";

export const job_schema = z.object({
  id: z.string(),
  status: z.enum(["queued", "running", "done", "failed", "canceled"]),
  prompt: z.string(),
  preview_id: z.string(),
  preview_url: z.string(),
  model: z.string().nullable(),
  format: z.string(),
  progress: z.string().nullable(),
  error: z.string().nullable(),
  download_url: z.string().nullable(),
  triangles: z.number().nullable(),
  bytes: z.number().nullable(),
  is_cloud_rendered: z.boolean(),
  created_at: z.string(),
  finished_at: z.string().nullable(),
});

export type StudioJob = z.infer<typeof job_schema>;

export const TERMINAL = new Set(["done", "failed", "canceled"]);

export function jobs_of(data: Record<string, unknown>): StudioJob[] {
  const parsed = z.object({ jobs: z.array(job_schema) }).safeParse(data);
  return parsed.success ? parsed.data.jobs : [];
}

export function job_of(data: Record<string, unknown>): StudioJob | null {
  const parsed = z.object({ job: job_schema }).safeParse(data);
  return parsed.success ? parsed.data.job : null;
}

export function slug_of(prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "model";
}
