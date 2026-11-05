import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { CliError } from "../errors.js";
import { run, which } from "../system.js";
import { MCP_NAME } from "./registry.js";
import { read_entry, remove_entry, same_json, set_entry, type EntryResult } from "./jsonc.js";

export type EditorId = "cursor" | "vscode" | "gemini" | "windsurf" | "zed" | "opencode";

export interface EditorSpec {
  id: EditorId;
  label: string;
  config_path: () => string;
  keys: () => string[];
  detect: () => Promise<boolean>;
  expected: (nemu: string) => unknown;
  add: (nemu: string) => Promise<EntryResult>;
  after_setup: string[];
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function home(): string {
  const value = process.env.HOME;
  return process.platform !== "win32" && value !== undefined && value.length > 0 ? value : homedir();
}

function config_home(): string {
  return process.env.XDG_CONFIG_HOME ?? join(home(), ".config");
}

function app_data(): string {
  return process.env.APPDATA ?? join(home(), "AppData", "Roaming");
}

function on_mac(): boolean {
  return process.platform === "darwin";
}

function on_windows(): boolean {
  return process.platform === "win32";
}

function vscode_user_dir(): string {
  if (on_windows()) return join(app_data(), "Code", "User");
  if (on_mac()) return join(home(), "Library", "Application Support", "Code", "User");
  return join(config_home(), "Code", "User");
}

function opencode_dir(): string {
  return join(config_home(), "opencode");
}

function opencode_config(): string {
  const jsonc = join(opencode_dir(), "opencode.jsonc");
  return existsSync(jsonc) ? jsonc : join(opencode_dir(), "opencode.json");
}

function zed_dir(): string {
  return on_windows() ? join(app_data(), "Zed") : join(config_home(), "zed");
}

async function any_present(binaries: string[], paths: string[]): Promise<boolean> {
  for (const binary of binaries) if ((await which(binary)) !== null) return true;
  for (const path of paths) if (await exists(path)) return true;
  return false;
}

function bridge(nemu: string, client: string) {
  return { command: nemu, args: ["mcp", "--client", client] };
}

export function is_nemu_entry(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as { command?: unknown; args?: unknown };
  const [command, first] = Array.isArray(entry.command)
    ? [entry.command[0], entry.command[1]]
    : [entry.command, Array.isArray(entry.args) ? entry.args[0] : undefined];
  if (typeof command !== "string") return false;
  const program = basename(command.replaceAll("\\", "/")).replace(/\.(cmd|exe|ps1)$/i, "");
  return program === "nemu" && first === "mcp";
}

async function guard_foreign(path: string, keys: string[]): Promise<unknown> {
  const existing = await read_entry(path, keys);
  if (existing !== undefined && !is_nemu_entry(existing)) {
    throw new CliError(
      `${path} already has a different server named "${MCP_NAME}", so nothing was changed. Rename or remove it, then run setup again.`,
      "config_conflict",
    );
  }
  return existing;
}

function file_editor(
  id: EditorId,
  label: string,
  config_path: () => string,
  keys: () => string[],
  detect: () => Promise<boolean>,
  value: (nemu: string) => unknown,
  after_setup: string[],
): EditorSpec {
  return {
    id,
    label,
    config_path,
    keys,
    detect,
    expected: value,
    add: async (nemu) => {
      await guard_foreign(config_path(), keys());
      return set_entry(config_path(), keys(), value(nemu));
    },
    after_setup,
  };
}

export const EDITORS: Record<EditorId, EditorSpec> = {
  cursor: file_editor(
    "cursor",
    "Cursor",
    () => join(home(), ".cursor", "mcp.json"),
    () => ["mcpServers", MCP_NAME],
    () =>
      any_present(["cursor"], [
        join(home(), ".cursor"),
        ...(on_mac() ? ["/Applications/Cursor.app"] : []),
      ]),
    (nemu) => bridge(nemu, "cursor"),
    ["Restart Cursor, or open Cursor Settings, MCP, to see the nemu server."],
  ),
  vscode: {
    id: "vscode",
    label: "VS Code",
    config_path: () => join(vscode_user_dir(), "mcp.json"),
    keys: () => ["servers", MCP_NAME],
    detect: () => any_present(["code"], [vscode_user_dir()]),
    expected: (nemu) => ({ type: "stdio", ...bridge(nemu, "vscode") }),
    add: async (nemu) => {
      const entry = { type: "stdio", ...bridge(nemu, "vscode") };
      const path = join(vscode_user_dir(), "mcp.json");
      const before = await guard_foreign(path, ["servers", MCP_NAME]);
      if (same_json(before, entry)) return { change: "unchanged", backup: null };
      if ((await which("code")) !== null) {
        const result = await run("code", ["--add-mcp", JSON.stringify({ name: MCP_NAME, ...entry })], {
          timeout_ms: 60_000,
        });
        if (result.code === 0) return { change: before === undefined ? "added" : "updated", backup: null };
      }
      return set_entry(path, ["servers", MCP_NAME], entry);
    },
    after_setup: [
      "In VS Code, run MCP: List Servers and start nemu. VS Code asks you to trust it the first time.",
    ],
  },
  gemini: file_editor(
    "gemini",
    "Gemini CLI",
    () => join(home(), ".gemini", "settings.json"),
    () => ["mcpServers", MCP_NAME],
    () => any_present(["gemini"], [join(home(), ".gemini")]),
    (nemu) => bridge(nemu, "gemini"),
    ["Start Gemini CLI and run /mcp to see the nemu server."],
  ),
  windsurf: file_editor(
    "windsurf",
    "Windsurf",
    () => join(home(), ".codeium", "windsurf", "mcp_config.json"),
    () => ["mcpServers", MCP_NAME],
    () =>
      any_present(["windsurf"], [
        join(home(), ".codeium", "windsurf"),
        ...(on_mac() ? ["/Applications/Windsurf.app"] : []),
      ]),
    (nemu) => bridge(nemu, "windsurf"),
    ["Restart Windsurf, or refresh the MCP servers in Cascade."],
  ),
  zed: file_editor(
    "zed",
    "Zed",
    () => join(zed_dir(), "settings.json"),
    () => ["context_servers", MCP_NAME],
    () =>
      any_present(["zed"], [zed_dir(), ...(on_mac() ? ["/Applications/Zed.app"] : [])]),
    (nemu) => ({ ...bridge(nemu, "zed"), env: {} }),
    ["Zed picks the server up by itself. Open the Agent panel settings to check it is running."],
  ),
  opencode: file_editor(
    "opencode",
    "OpenCode",
    opencode_config,
    () => ["mcp", MCP_NAME],
    () => any_present(["opencode"], [opencode_dir(), join(home(), ".opencode")]),
    (nemu) => ({ type: "local", command: [nemu, "mcp", "--client", "opencode"], enabled: true }),
    ["Start OpenCode and run opencode mcp list to see the nemu server."],
  ),
};

const ALIASES: Record<string, EditorId> = {
  cursor: "cursor",
  vscode: "vscode",
  "vs-code": "vscode",
  code: "vscode",
  gemini: "gemini",
  "gemini-cli": "gemini",
  windsurf: "windsurf",
  zed: "zed",
  opencode: "opencode",
  "open-code": "opencode",
};

export function editor_from_name(name: string | undefined): EditorSpec | null {
  const id = ALIASES[(name ?? "").toLowerCase()];
  return id === undefined ? null : EDITORS[id];
}

export async function editor_has_nemu(spec: EditorSpec): Promise<boolean> {
  return is_nemu_entry(await read_entry(spec.config_path(), spec.keys()));
}

export async function remove_from_editor(spec: EditorSpec): Promise<boolean> {
  return (await remove_entry(spec.config_path(), spec.keys(), is_nemu_entry)) === "removed";
}

export async function require_editor(spec: EditorSpec): Promise<void> {
  if (!(await spec.detect())) {
    throw new CliError(
      `${spec.label} was not found on this computer. Install it first, or print the config with: nemu mcp config ${spec.id}`,
      "client_missing",
    );
  }
}

export async function editor_outdated(spec: EditorSpec, nemu: string): Promise<boolean> {
  const current = await read_entry(spec.config_path(), spec.keys());
  if (!is_nemu_entry(current)) return false;
  return !same_json(current, spec.expected(nemu));
}

export async function refresh_editor(spec: EditorSpec, nemu: string): Promise<boolean> {
  if (!(await editor_outdated(spec, nemu))) return false;
  const result = await set_entry(spec.config_path(), spec.keys(), spec.expected(nemu));
  return result.change !== "unchanged";
}

