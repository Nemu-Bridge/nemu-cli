import { CliError } from "../errors.js";
import { run } from "../system.js";
import { mkdir } from "node:fs/promises";
import { claude_settings, codex_dir, codex_hooks } from "./paths.js";
import type { HookClient } from "./hooks.js";
import { has_plugin, install_plugin, remove_plugin, supports_plugins } from "./claude-plugin.js";

export const MCP_NAME = "nemu";

export interface ClientSpec {
  id: HookClient;
  label: string;
  binary: string;
  install_hint: string;
  hooks_path: () => string;
  after_setup: string[];
  add_mcp: (nemu: string) => Promise<void>;
  remove_mcp: () => Promise<boolean>;
  has_mcp: () => Promise<boolean>;
}

async function must(
  binary: string,
  args: string[],
  what: string,
): Promise<void> {
  const result = await run(binary, args);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().split("\n")[0] ?? "";
    throw new CliError(`${what} failed${detail.length > 0 ? `: ${detail}` : ""}`, "client_command_failed");
  }
}

export const CLIENTS: Record<HookClient, ClientSpec> = {
  "claude-code": {
    id: "claude-code",
    label: "Claude Code",
    binary: "claude",
    install_hint: "Install Claude Code first: https://code.claude.com/docs/en/setup",
    hooks_path: claude_settings,
    after_setup: ["Start Claude Code with: nemu claude (or just claude)"],
    add_mcp: async (nemu) => {
      await run("claude", ["mcp", "remove", "--scope", "user", MCP_NAME]);
      if (await supports_plugins()) {
        await install_plugin(nemu);
        return;
      }
      await must(
        "claude",
        ["mcp", "add", "--scope", "user", MCP_NAME, "--", nemu, "mcp", "--client", "claude-code"],
        "Registering the Nemu MCP server with Claude Code",
      );
    },
    remove_mcp: async () => {
      const plugin = await remove_plugin();
      const result = await run("claude", ["mcp", "remove", "--scope", "user", MCP_NAME]);
      return plugin || result.code === 0;
    },
    has_mcp: async () => {
      if (await has_plugin()) return true;
      const result = await run("claude", ["mcp", "get", MCP_NAME]);
      return result.code === 0 && /nemu/.test(result.stdout) && /\bmcp\b/.test(result.stdout);
    },
  },
  codex: {
    id: "codex",
    label: "Codex",
    binary: "codex",
    install_hint: "Install Codex first: npm i -g @openai/codex",
    hooks_path: codex_hooks,
    after_setup: [
      "Codex runs hooks only after you trust them: open Codex and run /hooks once.",
      "Start Codex with: nemu codex (or just codex)",
    ],
    add_mcp: async (nemu) => {
      await mkdir(codex_dir(), { recursive: true });
      await must(
        "codex",
        ["mcp", "add", MCP_NAME, "--", nemu, "mcp", "--client", "codex"],
        "Registering the Nemu MCP server with Codex",
      );
    },
    remove_mcp: async () => {
      const result = await run("codex", ["mcp", "remove", MCP_NAME]);
      return result.code === 0;
    },
    has_mcp: async () => {
      const result = await run("codex", ["mcp", "get", MCP_NAME]);
      return result.code === 0 && /\bmcp\b/.test(result.stdout);
    },
  },
};

export function client_from_name(name: string | undefined): ClientSpec {
  switch ((name ?? "").toLowerCase()) {
    case "claude":
    case "cc":
    case "claude-code":
    case "claudecode":
      return CLIENTS["claude-code"];
    case "codex":
      return CLIENTS.codex;
    default:
      throw new CliError(
        "Pick a client: claude (aliases cc, claude-code), codex, cursor, vscode, gemini, windsurf, zed or opencode. Others: nemu mcp config <client>",
        "invalid_client",
      );
  }
}

export async function client_installed(spec: ClientSpec): Promise<boolean> {
  const result = await run(spec.binary, ["--version"], { timeout_ms: 15_000 });
  return result.code === 0;
}
