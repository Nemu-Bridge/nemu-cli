import { readFile, writeFile, mkdir, rename, copyFile, access, chmod, stat } from "node:fs/promises";
import { dirname, win32 } from "node:path";
import { z } from "zod";
import { CliError } from "../errors.js";

export type HookClient = "claude-code" | "codex";
export type HookEvent = "start" | "tool" | "stop" | "compact" | "end";

interface HookSpec {
  event: string;
  hook: HookEvent;
  matcher?: string;
  timeout: number;
}

export const HOOK_SPECS: Record<HookClient, HookSpec[]> = {
  "claude-code": [
    { event: "SessionStart", hook: "start", matcher: "startup|resume|clear|compact", timeout: 20 },
    { event: "PostToolUse", hook: "tool", matcher: "Edit|Write|MultiEdit|NotebookEdit|mcp__nemu__memory_write", timeout: 5 },
    { event: "Stop", hook: "stop", timeout: 10 },
    { event: "PreCompact", hook: "compact", matcher: "manual|auto", timeout: 5 },
    { event: "SessionEnd", hook: "end", timeout: 3 },
  ],
  codex: [
    { event: "SessionStart", hook: "start", matcher: "^(startup|resume|clear|compact)$", timeout: 20 },
    { event: "PostToolUse", hook: "tool", timeout: 5 },
    { event: "Stop", hook: "stop", timeout: 10 },
    { event: "PreCompact", hook: "compact", timeout: 5 },
    { event: "SessionEnd", hook: "end", timeout: 3 },
  ],
};

const handler_schema = z
  .object({ type: z.string().optional(), command: z.string().optional() })
  .passthrough();

const group_schema = z
  .object({ matcher: z.string().optional(), hooks: z.array(handler_schema).optional() })
  .passthrough();

const config_schema = z
  .object({ hooks: z.record(z.string(), z.array(group_schema)).optional() })
  .passthrough();

type HookConfig = z.infer<typeof config_schema>;

const OWN_COMMAND = /(?:^|[\\/"'\s])nemu(?:\.cmd|\.exe)?["']?\s+hook\s+(?:start|tool|stop|compact|end)\b/;

export function is_own_command(command: string | undefined): boolean {
  return command !== undefined && OWN_COMMAND.test(command);
}

function quote(path: string): string {
  return /[\s"'$`\\]/.test(path) ? `"${path.replace(/(["\\$`])/g, "\\$1")}"` : path;
}

const WINDOWS_UNSAFE = /[\s"'&|<>^%()!`]/;

function windows_program(nemu: string): string {
  return WINDOWS_UNSAFE.test(nemu) ? win32.basename(nemu) : nemu;
}

export function hook_command(
  nemu: string,
  hook: HookEvent,
  client: HookClient,
  platform: NodeJS.Platform = process.platform,
): string {
  const rest = `hook ${hook} --client ${client}`;
  if (client === "codex" && platform === "win32") return `${windows_program(nemu)} ${rest}`;
  return `${quote(nemu)} ${rest}`;
}

export function has_quoted_program(command: string | undefined): boolean {
  return command !== undefined && /^\s*["']/.test(command) && is_own_command(command);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function read_config(path: string): Promise<HookConfig> {
  if (!(await exists(path))) return {};
  const text = await readFile(path, "utf-8");
  if (text.trim().length === 0) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CliError(
      `${path} is not valid JSON, so Nemu will not touch it. Fix or remove it and run setup again.`,
      "config_unreadable",
    );
  }
  const parsed = config_schema.safeParse(raw);
  if (!parsed.success) {
    throw new CliError(
      `${path} has a "hooks" value Nemu does not recognise, so it was left alone.`,
      "config_unrecognised",
    );
  }
  return parsed.data;
}

async function write_config(path: string, config: HookConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const backup = `${path}.nemu-backup`;
  if ((await exists(path)) && !(await exists(backup))) await copyFile(path, backup);
  const mode = (await exists(path)) ? (await stat(path)).mode & 0o777 : 0o600;
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf-8", mode });
  await chmod(temporary, mode).catch(() => undefined);
  await rename(temporary, path);
}

function without_own(config: HookConfig): HookConfig {
  const hooks = config.hooks ?? {};
  const cleaned: Record<string, z.infer<typeof group_schema>[]> = {};
  for (const [event, groups] of Object.entries(hooks)) {
    const kept = groups
      .map((group) => ({
        ...group,
        hooks: (group.hooks ?? []).filter((handler) => !is_own_command(handler.command)),
      }))
      .filter((group) => group.hooks.length > 0);
    if (kept.length > 0) cleaned[event] = kept;
  }
  const { hooks: _previous, ...rest } = config;
  return Object.keys(cleaned).length > 0 ? { ...rest, hooks: cleaned } : rest;
}

export async function needs_repair(path: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (platform !== "win32") return false;
  const config = await read_config(path).catch(() => ({}) as HookConfig);
  return Object.values(config.hooks ?? {}).some((groups) =>
    groups.some((group) => (group.hooks ?? []).some((handler) => has_quoted_program(handler.command))),
  );
}

export async function install_hooks(
  path: string,
  nemu: string,
  client: HookClient,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const config = without_own(await read_config(path));
  const hooks = { ...(config.hooks ?? {}) };
  for (const spec of HOOK_SPECS[client]) {
    const group = {
      ...(spec.matcher !== undefined ? { matcher: spec.matcher } : {}),
      hooks: [{ type: "command", command: hook_command(nemu, spec.hook, client, platform), timeout: spec.timeout }],
    };
    hooks[spec.event] = [...(hooks[spec.event] ?? []), group];
  }
  await write_config(path, { ...config, hooks });
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function remove_hooks(path: string): Promise<boolean> {
  if (!(await exists(path))) return false;
  const config = await read_config(path);
  const cleaned = without_own(config);
  if (stable(cleaned) === stable(config)) return false;
  await write_config(path, cleaned);
  return true;
}

export async function installed_hooks(path: string): Promise<string[]> {
  const config = await read_config(path).catch(() => ({}) as HookConfig);
  return Object.entries(config.hooks ?? {})
    .filter(([, groups]) =>
      groups.some((group) => (group.hooks ?? []).some((handler) => is_own_command(handler.command))),
    )
    .map(([event]) => event);
}

function refreshed(
  config: HookConfig,
  nemu: string,
  client: HookClient,
  platform: NodeJS.Platform,
): HookConfig {
  const specs = HOOK_SPECS[client];
  const hooks: Record<string, z.infer<typeof group_schema>[]> = {};
  for (const [event, groups] of Object.entries(config.hooks ?? {})) {
    const spec = specs.find((candidate) => candidate.event === event);
    const kept = groups
      .map((group) => {
        const own = (group.hooks ?? []).filter((handler) => is_own_command(handler.command));
        if (own.length === 0) return group;
        if (spec === undefined) {
          return { ...group, hooks: (group.hooks ?? []).filter((handler) => !is_own_command(handler.command)) };
        }
        const handlers = (group.hooks ?? []).map((handler) =>
          is_own_command(handler.command)
            ? { ...handler, type: "command", command: hook_command(nemu, spec.hook, client, platform), timeout: spec.timeout }
            : handler,
        );
        const only_own = handlers.every((handler) => is_own_command(handler.command));
        const { matcher: _matcher, ...rest } = group;
        return only_own
          ? { ...(spec.matcher !== undefined ? { matcher: spec.matcher } : {}), ...rest, hooks: handlers }
          : { ...group, hooks: handlers };
      })
      .filter((group) => (group.hooks ?? []).length > 0);
    if (kept.length > 0) hooks[event] = kept;
  }
  const { hooks: _previous, ...rest } = config;
  return Object.keys(hooks).length > 0 ? { ...rest, hooks } : rest;
}

export async function hooks_outdated(
  path: string,
  nemu: string,
  client: HookClient,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if ((await installed_hooks(path)).length === 0) return false;
  const config = await read_config(path);
  return stable(refreshed(config, nemu, client, platform)) !== stable(config);
}

export async function refresh_hooks(
  path: string,
  nemu: string,
  client: HookClient,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (!(await hooks_outdated(path, nemu, client, platform))) return false;
  await write_config(path, refreshed(await read_config(path), nemu, client, platform));
  return true;
}

