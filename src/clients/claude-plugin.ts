import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { config_dir } from "../config.js";
import { CliError } from "../errors.js";
import { run } from "../system.js";

export const PLUGIN_ID = "nemu@nemu";
const MARKETPLACE = "nemu";

function bundled_plugin(): string {
  return fileURLToPath(new URL("../../plugin", import.meta.url));
}

export function installed_plugin_dir(): string {
  return join(config_dir(), "claude-plugin");
}

export async function supports_plugins(): Promise<boolean> {
  const result = await run("claude", ["plugin", "--help"]);
  return result.code === 0 && /marketplace/.test(result.stdout);
}

async function stage_plugin(nemu: string): Promise<string> {
  const target = installed_plugin_dir();
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await cp(bundled_plugin(), target, {
    recursive: true,
    filter: (source) => !/(^|[\\/])\._[^\\/]*$/.test(source) && !source.endsWith(".DS_Store"),
  });
  const servers = {
    mcpServers: { nemu: { command: nemu, args: ["mcp", "--client", "claude-code"] } },
  };
  await writeFile(join(target, "nemu", ".mcp.json"), `${JSON.stringify(servers, null, 2)}\n`);
  return target;
}

async function must(args: string[], what: string): Promise<void> {
  const result = await run("claude", args);
  if (result.code === 0) return;
  const detail = (result.stderr || result.stdout).trim().split("\n").pop() ?? "";
  throw new CliError(`${what} failed${detail.length > 0 ? `: ${detail}` : ""}`, "client_command_failed");
}

export async function install_plugin(nemu: string): Promise<void> {
  const source = await stage_plugin(nemu);
  await run("claude", ["plugin", "uninstall", PLUGIN_ID]);
  await run("claude", ["plugin", "marketplace", "remove", MARKETPLACE]);
  await must(["plugin", "marketplace", "add", source], "Adding the Nemu plugin marketplace to Claude Code");
  await must(["plugin", "install", PLUGIN_ID, "--scope", "user"], "Installing the Nemu plugin in Claude Code");
}

export async function remove_plugin(): Promise<boolean> {
  const removed = await run("claude", ["plugin", "uninstall", PLUGIN_ID]);
  await run("claude", ["plugin", "marketplace", "remove", MARKETPLACE]);
  await rm(installed_plugin_dir(), { recursive: true, force: true });
  return removed.code === 0;
}

export async function has_plugin(): Promise<boolean> {
  const result = await run("claude", ["plugin", "list", "--json"]);
  if (result.code !== 0) return false;
  try {
    const listed: unknown = JSON.parse(result.stdout);
    return (
      Array.isArray(listed) &&
      listed.some(
        (entry: unknown) =>
          typeof entry === "object" &&
          entry !== null &&
          Reflect.get(entry, "id") === PLUGIN_ID &&
          Reflect.get(entry, "enabled") !== false,
      )
    );
  } catch {
    return false;
  }
}
