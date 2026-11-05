import { z } from "zod";
import { read_settings, update_settings } from "./config.js";
import { run, which } from "./system.js";
import { confirm, dim, fail, is_interactive, out, spinner, success } from "./ui.js";
import { emit, is_json_mode } from "./output.js";
import { bool_flag, type Args } from "./args.js";
import { VERSION } from "./version.js";

const PACKAGE = "nemu-cli";
const PACKAGE_BINARY = "nemu";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 1500;
const QUIET_COMMANDS = new Set(["hook", "mcp", "token", "update"]);

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

const registry_schema = z.object({ version: z.string().regex(SEMVER) });

function registry_url(): string {
  const base = (process.env.NEMU_REGISTRY_URL ?? "https://registry.npmjs.org").replace(/\/+$/, "");
  return `${base}/${PACKAGE}/latest`;
}

export function is_newer(candidate: string, current: string): boolean {
  const next = SEMVER.exec(candidate);
  const now = SEMVER.exec(current);
  if (next === null || now === null) return false;
  for (let i = 1; i <= 3; i += 1) {
    const difference = Number(next[i]) - Number(now[i]);
    if (difference !== 0) return difference > 0;
  }
  if (next[4] === undefined && now[4] !== undefined) return true;
  return false;
}

export async function fetch_latest(): Promise<string | null> {
  try {
    const response = await fetch(registry_url(), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const parsed = registry_schema.safeParse(await response.json());
    return parsed.success ? parsed.data.version : null;
  } catch {
    return null;
  }
}

export async function latest_version(force: boolean, now = Date.now()): Promise<string | null> {
  const settings = await read_settings();
  const fresh =
    settings.update_checked_at !== undefined && now - settings.update_checked_at < CHECK_INTERVAL_MS;
  if (!force && fresh && settings.update_latest !== undefined) return settings.update_latest;
  const latest = await fetch_latest();
  await update_settings({
    update_checked_at: now,
    ...(latest !== null ? { update_latest: latest } : {}),
  }).catch(() => undefined);
  return latest ?? (fresh ? (settings.update_latest ?? null) : null);
}

function is_ephemeral_run(): boolean {
  const script = (process.argv[1] ?? "").replaceAll("\\", "/");
  return script.includes("/_npx/") || script.includes("/.bun/install/cache/");
}

function should_check(command: string): boolean {
  if (QUIET_COMMANDS.has(command)) return false;
  if (is_json_mode() || !is_interactive()) return false;
  if (process.env.CI !== undefined || process.env.NEMU_NO_UPDATE_CHECK === "1") return false;
  return !is_ephemeral_run();
}

async function install(version: string): Promise<boolean> {
  const command = `npm i -g ${PACKAGE}@${version}`;
  if ((await which("npm")) === null) {
    fail(`npm was not found. Update by hand: ${command}`);
    return false;
  }
  const progress = spinner(`Installing ${PACKAGE} ${version}`);
  const result = await run("npm", ["install", "-g", `${PACKAGE}@${version}`], { timeout_ms: 180_000 });
  progress.stop();
  if (result.code !== 0) {
    fail(`The update did not install. Run it yourself: ${command}`);
    return false;
  }
  success(`Updated to ${version}.`);
  const repaired = await run(PACKAGE_BINARY, ["repair"], { timeout_ms: 60_000 });
  const lines = repaired.stdout.trimEnd();
  if (repaired.code === 0 && lines.length > 0 && !lines.includes("up to date")) out(lines);
  return true;
}

async function offer(latest: string, now: number): Promise<boolean> {
  out(`  There is a new version available (${VERSION} -> ${latest}).`);
  const accepted = await confirm("Do you want to upgrade?", true);
  if (!accepted) {
    await update_settings({ update_declined_version: latest, update_declined_at: now }).catch(
      () => undefined,
    );
    out(dim(`  Later: nemu update`));
    return false;
  }
  return install(latest);
}

export async function maybe_offer_update(command: string, now = Date.now()): Promise<void> {
  try {
    if (!should_check(command)) return;
    const latest = await latest_version(false, now);
    if (latest === null || !is_newer(latest, VERSION)) return;
    const settings = await read_settings();
    const declined_recently =
      settings.update_declined_version === latest &&
      settings.update_declined_at !== undefined &&
      now - settings.update_declined_at < CHECK_INTERVAL_MS;
    if (declined_recently) return;
    if (await offer(latest, now)) out();
  } catch {
    return;
  }
}

export async function update_command(args: Args): Promise<number> {
  const latest = await latest_version(true);
  if (latest === null) {
    fail("Could not reach the npm registry. Try again, or run: npm i -g nemu-cli@latest");
    return 1;
  }
  const available = is_newer(latest, VERSION);
  if (is_json_mode()) {
    emit({ current: VERSION, latest, update_available: available });
    return 0;
  }
  if (!available) {
    out(`  nemu ${VERSION} is the latest version.`);
    return 0;
  }
  if (bool_flag(args, "yes", "y")) return (await install(latest)) ? 0 : 1;
  if (!is_interactive()) {
    out(`  There is a new version available (${VERSION} -> ${latest}). Run: npm i -g ${PACKAGE}@${latest}`);
    return 0;
  }
  await offer(latest, Date.now());
  return 0;
}
