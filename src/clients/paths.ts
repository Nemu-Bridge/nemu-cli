import { homedir } from "node:os";
import { join } from "node:path";

export function claude_dir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

export function claude_settings(): string {
  return join(claude_dir(), "settings.json");
}

export function codex_dir(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

export function codex_hooks(): string {
  return join(codex_dir(), "hooks.json");
}

export function encode_claude_folder(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, "-");
}
