#!/usr/bin/env node

import { parse_args, bool_flag, type Args } from "./args.js";
import { set_json_mode, is_json_mode, emit } from "./output.js";
import { login } from "./commands/login.js";
import { logout } from "./commands/logout.js";
import { whoami } from "./commands/whoami.js";
import { members, workspaces } from "./commands/workspaces.js";
import {
  mappings,
  models,
  prompts,
  providers,
  workflows,
} from "./commands/resources.js";
import {
  health,
  indexes,
  metrics,
  quotas,
  raw_api,
  scopes,
  user,
  version_info,
} from "./commands/account.js";
import { token } from "./commands/token.js";
import { status } from "./commands/status.js";
import { uninstall } from "./commands/uninstall.js";
import { setup } from "./commands/setup.js";
import { mcp } from "./commands/mcp.js";
import { hook } from "./commands/hook.js";
import { context } from "./commands/context.js";
import { config_command } from "./commands/settings.js";
import { client_command } from "./commands/client.js";
import { send_report } from "./report.js";
import { maybe_offer_update, update_command } from "./update.js";
import { migrate_after_update } from "./migrations.js";
import { repair } from "./commands/repair.js";
import { vault } from "./commands/vault.js";
import { sync } from "./commands/sync.js";
import { CliError } from "./errors.js";
import { VERSION } from "./version.js";
import { bold, dim, fail, out } from "./ui.js";

const UNREPORTED = new Set(["hook", "mcp", "token"]);

type Handler = (args: Args) => Promise<number> | number;

const COMMANDS: Record<string, Handler> = {
  login,
  logout: () => logout(),
  whoami: () => whoami(),
  workspaces,
  ws: workspaces,
  members,
  providers,
  models,
  prompts,
  mappings,
  workflows,
  indexes,
  quotas,
  metrics,
  user: () => user(),
  account: () => user(),
  health: () => health(),
  "api-version": () => version_info(),
  scopes: () => scopes(),
  api: raw_api,
  token,
  status,
  uninstall,
  setup,
  claude: client_command("claude"),
  codex: client_command("codex"),
  mcp,
  hook,
  context,
  config: config_command,
  update: update_command,
  repair,
  vault,
  sync,
};

const HELP = `
  ${bold("nemu")} ${dim(VERSION)}

  ${bold("Context for coding agents")}
    setup <claude|codex> [--hooks|--no-hooks] [--yes]
                                        Connect Claude Code (aliases cc, claude-code) or Codex
    setup <cursor|vscode|gemini|windsurf|zed|opencode>
                                        Add the Nemu MCP server to that editor's config
    claude [-- <claude args>]           Set up if needed, then start Claude Code
    codex [-- <codex args>]             Set up if needed, then start Codex
    claude load memories [--all] [--yes]
                                        Import Claude Code's saved memories
    claude load sessions [--limit n]    Have Claude read past sessions and save what matters
    codex load sessions [--limit n]     The same for Codex
    mcp                                 Run the MCP bridge (what clients start)
    mcp config <client>                 Print config for cursor, gemini, vscode, windsurf,
                                        zed, opencode, claude, codex or remote
    context [load]                      Show what an agent sees for this folder
    context search <words>              Search this project's saved notes
    context projects | export [--out f] List projects or export everything
    status                              Sign in, device, global install, client setup
    uninstall [client|all]              Remove what setup added
    token [--header]                    Print a fresh access token
    config get | set reports on|off     Error reports sent after a failure
    update [--yes]                      Check for a new version and install it
    repair                              Bring hooks and editor entries up to date

  ${bold("Vaults")}
    vault list                          Vaults in this workspace
    vault link <folder> [--vault <name|id>] [--create [--private]] [--obsidian]
                                        Link a folder to a vault (writes <folder>/.nemu/vault.json)
    vault unlink [folder]               Stop syncing a folder; its files stay
    vault status [folder]               Last sync, settings and open conflicts
    vault unlock [folder]               Open a private vault on this computer (password, recovery key, or approval)
    vault approve [folder]              Let another device open a private vault, after comparing its code
    vault forget [folder]               Lock a private vault on this computer again
    sync [folder] [--watch] [--dry-run] [--conflicts=merge|file] [--allow-deletes]
         [--obsidian on|off] [--obsidian-plugins on|off]
                                        Sync a linked folder with its vault

  ${bold("Account")}
    login [--force] [--no-browser]      Sign in with the device flow
    login key                           Sign in with a workspace API key (asked for, or NEMU_API_KEY)
    logout                              Delete the stored token
    whoami                              Show the signed in account
    user                                Full account record
    scopes                              Every scope and its actions

  ${bold("Workspaces")}
    workspaces list [--stats]
    workspaces get <id>
    workspaces create <name>
    workspaces rename <id> <name>
    workspaces delete <id> --yes
    workspaces budget [id]
    workspaces set-budget <id> <amount>

  ${bold("Members")}
    members list [-w <workspace>]
    members invite [--email a,b] [--max-uses n] [--expires-in-days n]
    members role <member-id> <ADMIN|MEMBER>
    members remove <member-id>

  ${bold("Providers")}
    providers list [--name] [--compatibility]
    providers get <id>
    providers create <name> --priority 1 [--base-url] [--api-key]
                            [--compatibility OPENAI_COMPATIBLE|ANTHROPIC|OPENAI_RESPONSES]
    providers update <id> [--name] [--priority] [--base-url] [--api-key] [--enabled]
    providers delete <id> --yes

  ${bold("Models")}
    models list [--provider <id>] [--type chat] [--name]
    models get <id>
    models create --name --display-name --provider <id> --type chat
                  --input-cost --output-cost --context-window
                  [--api-name] [--max-output] [--cache-read-cost] [--cache-write-cost]
    models update <id> [--display-name] [--input-cost] [--output-cost] [--enabled]
    models delete <id> --yes

  ${bold("Prompts")}
    prompts list [--name] [--type] [--environment]
    prompts get <id>
    prompts create --name --content [--type SYSTEM] [--model <id>] [--position n]
    prompts update <id> [--name] [--content] [--enabled]
    prompts delete <id> --yes

  ${bold("Mappings")}
    mappings list [--source] [--target]
    mappings get <id>
    mappings create --source <name> --target <model> [--priority n] [--pattern true]
    mappings update <id> [--source] [--target] [--priority] [--enabled]
    mappings delete <id> --yes

  ${bold("Read only")}
    workflows list | get <id>
    metrics list [--page n] [--limit n] [--key <id>] [--start <iso>] [--end <iso>]
    metrics get <request-id>
    indexes list | get <id> | create <url> [--max-pages n] | delete <id> --yes
    quotas list | get <id> | update <id> [--limit n] | delete <id> --yes
    health
    api-version

  ${bold("Escape hatch")}
    api <METHOD> <path> [--data '<json>']   Call any endpoint directly

  ${bold("Global")}
    --json              Machine readable output on every command
    -w, --workspace     Workspace id or name, defaults to the first
    --version, -v       Print the CLI version
    --help, -h          Print this message

  ${dim("Docs  https://docs.nemu.cc")}
`;

function usage(): void {
  out(HELP);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const args = parse_args(argv.slice(1));

  set_json_mode(bool_flag(args, "json"));

  if (command === undefined || command === "--help" || command === "-h") {
    usage();
    return 0;
  }

  if (command === "--version" || command === "-v") {
    if (is_json_mode()) {
      emit({ version: VERSION });
      return 0;
    }
    out(VERSION);
    return 0;
  }

  const handler = COMMANDS[command];
  if (handler === undefined) {
    fail(`Unknown command "${command}".`);
    usage();
    return 1;
  }

  if (bool_flag(args, "help", "h")) {
    usage();
    return 0;
  }

  await maybe_offer_update(command);
  const migrated = await migrate_after_update(command);
  if (migrated !== null && migrated.applied.length > 0 && !is_json_mode()) {
    out(dim(`  Updated your setup for nemu ${VERSION}:`));
    for (const line of migrated.applied) out(dim(`    ${line}`));
    out();
  }
  return await handler(args);
}

async function report_failure(error: unknown): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? "";
  const message = error instanceof Error ? error.message : String(error);
  const server_reference = error instanceof CliError ? error.reference : undefined;
  const parsed = parse_args(argv.slice(1));
  const reference = UNREPORTED.has(command) || COMMANDS[command] === undefined
    ? null
    : await send_report({
        command,
        positional: parsed.positional,
        flags: Object.keys(parsed.flags),
        error,
      });
  const shown = reference ?? server_reference ?? null;
  if (is_json_mode()) {
    emit({ ok: false, error: message, ...(error instanceof CliError ? { code: error.code } : {}), ...(shown !== null ? { reference: shown } : {}) });
    return;
  }
  fail(message);
  if (shown !== null) out(dim(`  Reference ${shown}. Quote it if you contact support@nemu.cc.`));
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch(async (error: unknown) => {
    process.exitCode = 1;
    await report_failure(error).catch(() => undefined);
  });
