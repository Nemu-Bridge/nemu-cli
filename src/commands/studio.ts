import { readFile, stat, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { z } from "zod";
import { bool_flag, flag, number_flag, require_positional, type Args } from "../args.js";
import { CliError } from "../errors.js";
import { emit, is_json_mode } from "../output.js";
import { bold, dim, open_browser, out, spinner, success } from "../ui.js";
import { call_studio_tool } from "../studio/tools.js";
import { job_of, jobs_of, slug_of, TERMINAL, type StudioJob } from "../studio/jobs.js";

const FORMATS = ["glb", "gltf", "obj", "stl", "usdz"];
const TARGETS = ["roblox", "unity", "unreal", "godot", "blender", "web", "print"];
const MAX_INSTRUCTIONS = 20_000;
const WAIT_SLICE_SECONDS = 45;

const HELP = `nemu studio: build 3D models with Nemu Studio from the terminal

  nemu studio create "<prompt>" [options]   Start a cloud job and wait for the file
      --model <name> | --model-id <id>      Chat model from your Nemu models (default: your first)
      --textures-model <name> | --textures-model-id <id>
                                            Image model for generated textures (optional)
      --textures-connector <name>           An MCP connector from Nemu chat that makes images,
                                            used for textures; its calls run without asking
      --count <1-4>                         Variations of the same brief
      --instructions <file>                 Extra direction read from a file
      --format glb|gltf|obj|stl|usdz        Export format (default glb)
      --target roblox|unity|unreal|godot|blender|web|print
      --budget <triangles>                  Triangle budget for the export
      --out <file or folder>                Where to save (default: current folder)
      --detach                              Return the job ids at once
  nemu studio jobs                          Your recent jobs
  nemu studio wait <job> [--out <path>]     Wait for a job and save its file
  nemu studio open <job id or preview id>   Watch a job or preview in the browser
  nemu studio export <preview> [--format glb] [--out <path>]
  nemu studio cancel <job>
  nemu studio texture <file or https url>   Turn an image into an image_id for kit.texture and kit.pbr`;

function choice(args: Args, name: string, allowed: string[]): string | undefined {
  const value = flag(args, name)?.toLowerCase();
  if (value === undefined) return undefined;
  if (!allowed.includes(value)) {
    throw new CliError(`--${name} must be one of ${allowed.join(", ")}`, "bad_flag");
  }
  return value;
}

async function instructions_of(args: Args): Promise<string | undefined> {
  const path = flag(args, "instructions");
  if (path === undefined) return undefined;
  let text: string;
  try {
    text = await readFile(resolve(path), "utf8");
  } catch {
    throw new CliError(`Could not read ${path}`, "bad_flag");
  }
  if (text.length > MAX_INSTRUCTIONS) {
    throw new CliError(`--instructions is longer than ${MAX_INSTRUCTIONS} characters`, "bad_flag");
  }
  return text;
}

async function target_path(out_flag: string | undefined, job: StudioJob, index: number, total: number): Promise<string> {
  const name = `${slug_of(job.prompt)}${total > 1 ? `-${index + 1}` : ""}.${job.format}`;
  if (out_flag === undefined) return resolve(name);
  const wanted = resolve(out_flag);
  try {
    if ((await stat(wanted)).isDirectory()) return join(wanted, name);
  } catch {
    if (out_flag.endsWith("/") || out_flag.endsWith("\\")) return join(wanted, name);
  }
  if (total > 1) return wanted.replace(/(\.[a-z]+)?$/, `-${index + 1}$1`);
  return wanted;
}

async function download(url: string, path: string): Promise<number> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  } catch {
    throw new CliError("The download failed. Run nemu studio wait again for a fresh link.", "download_failed");
  }
  if (!response.ok) {
    throw new CliError("The download link expired. Run nemu studio wait again for a fresh link.", "download_failed");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  await writeFile(path, bytes);
  return bytes.byteLength;
}

async function wait_for(job_id: string): Promise<StudioJob> {
  const progress = is_json_mode() ? null : spinner("Building");
  try {
    for (;;) {
      const reply = await call_studio_tool("studio_job_wait", { job_id, seconds: WAIT_SLICE_SECONDS });
      const job = job_of(reply.data);
      if (job === null) throw new CliError("Nemu sent an unreadable job.", "studio_failed");
      if (TERMINAL.has(job.status)) return job;
    }
  } finally {
    progress?.stop();
  }
}

async function collect(jobs: StudioJob[], args: Args): Promise<number> {
  const finished: StudioJob[] = [];
  for (const job of jobs) finished.push(await wait_for(job.id));
  const saved: Array<{ job: StudioJob; path: string | null; bytes: number }> = [];
  for (const [index, job] of finished.entries()) {
    if (job.status !== "done" || job.download_url === null) {
      saved.push({ job, path: null, bytes: 0 });
      continue;
    }
    const path = await target_path(flag(args, "out"), job, index, finished.length);
    saved.push({ job, path, bytes: await download(job.download_url, path) });
  }
  if (is_json_mode()) {
    emit({ ok: saved.every((entry) => entry.path !== null), jobs: saved.map((entry) => ({ ...entry.job, path: entry.path })) });
    return saved.every((entry) => entry.path !== null) ? 0 : 1;
  }
  for (const entry of saved) {
    if (entry.path === null) {
      out(`  ${entry.job.status === "canceled" ? "Canceled" : "Failed"}: ${entry.job.prompt.slice(0, 60)}${entry.job.error === null ? "" : `: ${entry.job.error}`}`);
      continue;
    }
    success(
      `Saved ${entry.path} (${Math.round(entry.bytes / 1024)} KB${entry.job.triangles === null ? "" : `, ${entry.job.triangles} triangles`})`,
    );
  }
  return saved.every((entry) => entry.path !== null) ? 0 : 1;
}

function job_line(job: StudioJob): string {
  const state = job.status === "running" && job.progress !== null ? `running, ${job.progress}` : job.status;
  return `${job.id}  ${state}  ${job.prompt.slice(0, 50)}${job.model === null ? "" : dim(`  ${job.model}`)}`;
}

async function create(args: Args): Promise<number> {
  const prompt = require_positional(args, 1, "prompt");
  const count = number_flag(args, "count") ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > 4) throw new CliError("--count must be 1 to 4", "bad_flag");
  const budget = number_flag(args, "budget");
  const reply = await call_studio_tool("studio_job_start", {
    prompt,
    instructions: await instructions_of(args),
    model: flag(args, "model"),
    model_id: flag(args, "model-id"),
    textures_model: flag(args, "textures-model"),
    textures_model_id: flag(args, "textures-model-id"),
    textures_connector: flag(args, "textures-connector"),
    format: choice(args, "format", FORMATS) ?? "glb",
    target: choice(args, "target", TARGETS),
    budget,
    count,
    should_notify: false,
  });
  const jobs = jobs_of(reply.data);
  const first = jobs[0];
  if (first === undefined) throw new CliError("No job was started.", "studio_failed");
  if (bool_flag(args, "detach")) {
    if (is_json_mode()) {
      emit({ ok: true, jobs });
      return 0;
    }
    for (const job of jobs) out(`  ${job.id}  ${dim(job.preview_url)}`);
    out(dim(`  Collect with: ${bold(`nemu studio wait ${first.id}`)}`));
    return 0;
  }
  if (!is_json_mode()) {
    out(`  Started ${jobs.length} job${jobs.length === 1 ? "" : "s"} on ${first.model ?? "your model"}. Watch it: ${first.preview_url}`);
  }
  return collect(jobs, args);
}

const TEXTURE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

const slot_schema = z.object({ slot_id: z.string(), upload_url: z.string(), max_bytes: z.number() });
const saved_schema = z.object({ image_id: z.string(), width: z.number(), height: z.number() });

async function upload_texture(path: string, prompt: string | undefined): Promise<Record<string, unknown>> {
  const content_type = TEXTURE_TYPES[extname(path).toLowerCase()];
  if (content_type === undefined) throw new CliError("A texture must be a .png, .jpg or .webp file.", "bad_file");
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(resolve(path)));
  } catch {
    throw new CliError(`Could not read ${path}`, "bad_file");
  }
  const opened = await call_studio_tool("studio_texture", { upload: true, content_type });
  const slot = slot_schema.safeParse(opened.data);
  if (!slot.success) throw new CliError("Nemu sent an unreadable upload slot.", "studio_failed");
  if (bytes.byteLength > slot.data.max_bytes) {
    throw new CliError(`The image is larger than ${Math.round(slot.data.max_bytes / 1024 / 1024)} MB.`, "bad_file");
  }
  let response: Response;
  try {
    response = await fetch(slot.data.upload_url, {
      method: "PUT",
      headers: { "content-type": content_type },
      body: bytes,
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new CliError("The upload failed. Try again.", "upload_failed");
  }
  if (!response.ok) throw new CliError(`The upload was refused (${response.status}).`, "upload_failed");
  const saved = await call_studio_tool("studio_texture", { slot_id: slot.data.slot_id, prompt });
  return saved.data;
}

async function texture(args: Args): Promise<number> {
  const source = require_positional(args, 1, "file or url");
  const prompt = flag(args, "prompt");
  const data = /^https?:\/\//i.test(source)
    ? (await call_studio_tool("studio_texture", { url: source, prompt })).data
    : await upload_texture(source, prompt);
  const saved = saved_schema.safeParse(data);
  if (!saved.success) throw new CliError("Nemu sent an unreadable answer.", "studio_failed");
  if (is_json_mode()) {
    emit({ ok: true, ...saved.data });
    return 0;
  }
  success(`image_id ${saved.data.image_id} (${saved.data.width}x${saved.data.height})`);
  out(dim(`  Use it in a scene with kit.texture("${saved.data.image_id}") or kit.pbr("${saved.data.image_id}")`));
  return 0;
}

const CHAT_ORIGIN = "https://chat.nemu.cc";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

function viewer_origin(url: string): string {
  const parsed = new URL(url);
  return LOCAL_HOSTS.has(parsed.hostname) ? parsed.origin : CHAT_ORIGIN;
}

function preview_id_of(value: string): string {
  if (!/^[0-9a-f-]{36}$/.test(value)) throw new CliError("Expected a job or preview id.", "bad_id");
  return value;
}

export async function studio(args: Args): Promise<number> {
  const action = args.positional[0];
  if (action === undefined || action === "help" || bool_flag(args, "help", "h")) {
    out(HELP);
    return 0;
  }
  if (action === "create") return create(args);
  if (action === "texture") return texture(args);
  if (action === "jobs") {
    const reply = await call_studio_tool("studio_job_status", {});
    const jobs = jobs_of(reply.data);
    if (is_json_mode()) {
      emit({ ok: true, jobs });
      return 0;
    }
    if (jobs.length === 0) out("  No Studio jobs yet.");
    for (const job of jobs) out(`  ${job_line(job)}`);
    return 0;
  }
  if (action === "wait") {
    const job_id = preview_id_of(require_positional(args, 1, "job id"));
    const reply = await call_studio_tool("studio_job_status", { job_id });
    const job = job_of(reply.data);
    if (job === null) throw new CliError("No such job.", "studio_failed");
    return collect([job], args);
  }
  if (action === "cancel") {
    const job_id = preview_id_of(require_positional(args, 1, "job id"));
    await call_studio_tool("studio_job_cancel", { job_id });
    success("Stopped");
    return 0;
  }
  if (action === "open") {
    const id = preview_id_of(require_positional(args, 1, "job or preview id"));
    const job = await call_studio_tool("studio_job_status", { job_id: id })
      .then((reply) => job_of(reply.data))
      .catch(() => null);
    const reply = await call_studio_tool("studio_open", { preview_id: job?.preview_id ?? id });
    const url = typeof reply.data.url === "string" ? reply.data.url : null;
    if (url === null) throw new CliError("No such job or preview.", "studio_failed");
    if (!open_browser(url, viewer_origin(url))) out(`  Open ${url}`);
    return 0;
  }
  if (action === "export") {
    const preview_id = preview_id_of(require_positional(args, 1, "preview id"));
    const format = choice(args, "format", FORMATS) ?? "glb";
    const reply = await call_studio_tool("studio_export", { preview_id, format });
    const url = typeof reply.data.url === "string" ? reply.data.url : null;
    if (url === null) throw new CliError(reply.text, "studio_failed");
    const path = resolve(flag(args, "out") ?? `${preview_id.slice(0, 8)}.${format}`);
    const bytes = await download(url, path);
    if (is_json_mode()) {
      emit({ ok: true, path, bytes });
      return 0;
    }
    success(`Saved ${path} (${Math.round(bytes / 1024)} KB)`);
    return 0;
  }
  throw new CliError(`Unknown studio command ${action}. Run nemu studio help.`, "bad_command");
}
