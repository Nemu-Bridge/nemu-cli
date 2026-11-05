import { CLIENTS } from "./clients/registry.js";
import { EDITORS, editor_outdated, refresh_editor } from "./clients/editors.js";
import { hooks_outdated, refresh_hooks } from "./clients/hooks.js";
import { read_settings, update_settings, config_dir } from "./config.js";
import { resolve_nemu_binary } from "./commands/setup.js";
import { VERSION } from "./version.js";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface Migration {
  id: string;
  label: string;
  needed: (nemu: string) => Promise<boolean>;
  apply: (nemu: string) => Promise<boolean>;
}

export interface MigrationReport {
  applied: string[];
  failed: string[];
}

const QUIET_COMMANDS = new Set(["hook", "mcp", "token", "uninstall", "repair", "update"]);

export const MIGRATIONS: Migration[] = [
  ...Object.values(CLIENTS).map((spec) => ({
    id: `hooks:${spec.id}`,
    label: `${spec.label}: updated the Nemu hooks`,
    needed: (nemu: string) => hooks_outdated(spec.hooks_path(), nemu, spec.id),
    apply: (nemu: string) => refresh_hooks(spec.hooks_path(), nemu, spec.id),
  })),
  ...Object.values(EDITORS).map((editor) => ({
    id: `mcp:${editor.id}`,
    label: `${editor.label}: updated the nemu server entry`,
    needed: (nemu: string) => editor_outdated(editor, nemu),
    apply: (nemu: string) => refresh_editor(editor, nemu),
  })),
];

async function log_failure(id: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await mkdir(config_dir(), { recursive: true }).catch(() => undefined);
  await appendFile(
    join(config_dir(), "hooks.log"),
    `${new Date().toISOString()} migration ${id} ${message.replace(/\s+/g, " ").slice(0, 300)}\n`,
  ).catch(() => undefined);
}

export async function run_migrations(migrations: Migration[] = MIGRATIONS): Promise<MigrationReport> {
  const report: MigrationReport = { applied: [], failed: [] };
  const nemu = await resolve_nemu_binary(false).catch(() => null);
  if (nemu === null) return report;
  for (const migration of migrations) {
    try {
      if (!(await migration.needed(nemu))) continue;
      if (await migration.apply(nemu)) report.applied.push(migration.label);
    } catch (error) {
      report.failed.push(migration.label);
      await log_failure(migration.id, error);
    }
  }
  return report;
}

export function migrations_due(command: string, setup_version: string | undefined): boolean {
  return !QUIET_COMMANDS.has(command) && setup_version !== VERSION;
}

export async function migrate_after_update(command: string): Promise<MigrationReport | null> {
  try {
    const settings = await read_settings();
    if (!migrations_due(command, settings.setup_version)) return null;
    if (process.env.NEMU_BIN === undefined && !is_global_run()) return null;
    const report = await run_migrations();
    if (report.failed.length === 0) await update_settings({ setup_version: VERSION });
    return report;
  } catch {
    return null;
  }
}

function is_global_run(): boolean {
  const script = (process.argv[1] ?? "").replaceAll("\\", "/");
  return !script.includes("/_npx/") && !script.includes("/.bun/install/cache/");
}
