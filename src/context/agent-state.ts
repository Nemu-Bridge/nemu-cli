import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { config_dir, write_private } from "../config.js";

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._:/@()+-]{0,79}$/;

const agent_state_schema = z.object({
  model: z.string().regex(MODEL_PATTERN).optional(),
  session_id: z.string().min(1).max(200).optional(),
  updated_at: z.number(),
});

export type AgentState = z.infer<typeof agent_state_schema>;

function state_file(client: string, cwd: string): string {
  const folder = createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 16);
  return join(config_dir(), "agents", `${client.replace(/[^a-z0-9-]/g, "_")}-${folder}.json`);
}

export function clean_model(raw: unknown): string | undefined {
  if (typeof raw === "string") return MODEL_PATTERN.test(raw.trim()) ? raw.trim() : undefined;
  if (raw !== null && typeof raw === "object") {
    const id = Reflect.get(raw, "id") ?? Reflect.get(raw, "display_name");
    return clean_model(id);
  }
  return undefined;
}

export async function save_agent_state(
  client: string,
  cwd: string,
  state: Omit<AgentState, "updated_at">,
): Promise<void> {
  await mkdir(join(config_dir(), "agents"), { recursive: true, mode: 0o700 });
  await write_private(state_file(client, cwd), JSON.stringify({ ...state, updated_at: Date.now() }));
}

export async function read_agent_state(client: string, cwd: string): Promise<AgentState | null> {
  try {
    const parsed = agent_state_schema.safeParse(JSON.parse(await readFile(state_file(client, cwd), "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
