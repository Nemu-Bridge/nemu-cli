# nemu-cli

Command line access to Nemu. The package is `nemu-cli` and the command it installs is `nemu`,
because `nemu` itself was taken on npm in 2016.

```bash
bunx nemu-cli login
```

Or install it once and drop the package name:

```bash
bun add -g nemu-cli
nemu login
```

## Signing in

`nemu login` uses the OAuth device authorization grant, so nothing is typed into the terminal and no
secret is baked into this package.

```
$ nemu login

  Open  https://app.nemu.cc/device
  Code  BDXW-KRTQ

  Waiting for approval...
✓ Logged in as hiraeeth
  Token saved to ~/.nemu/auth.json
```

The browser opens on its own. Pass `--no-browser` when there is no browser to open, which is the case
over SSH and inside a container, and open the printed link from any other device. The code expires
after 15 minutes. `--force` signs in again when a session already exists.

## Commands

Every command takes `--json`, which is what you want when something other than a person is reading
the output. Failures exit non zero and print `{"ok": false, "error": "..."}` under `--json`.

Anything workspace scoped takes `-w` or `--workspace`, by id or by name. Left off, it uses your first
workspace.

### Account

| Command | Does |
| --- | --- |
| `nemu login` | Sign in on this machine |
| `nemu logout` | Delete the stored token |
| `nemu whoami` | Show the signed in account |
| `nemu user` | Full account record |
| `nemu scopes` | Every scope and the actions it covers |
| `nemu health` | Service health |
| `nemu api-version` | Supported API versions |

### Workspaces and members

```bash
nemu workspaces list
nemu workspaces get <id>
nemu workspaces create "My workspace"
nemu workspaces rename <id> "New name"
nemu workspaces delete <id> --yes
nemu workspaces budget
nemu workspaces set-budget <id> 50

nemu members list
nemu members invite --email a@b.com,c@d.com --max-uses 5 --expires-in-days 30
nemu members role <member-id> ADMIN
nemu members remove <member-id>
```

### Providers and models

```bash
nemu providers list
nemu providers create myprovider --priority 1 \
  --base-url https://api.openai.com/v1 \
  --api-key sk-... \
  --compatibility OPENAI_COMPATIBLE
nemu providers update <id> --priority 5 --enabled false
nemu providers delete <id> --yes

nemu models list --provider <provider-id> --type chat
nemu models create --name gpt-5 --display-name "GPT 5" \
  --provider <provider-id> --type chat \
  --input-cost 0.00001 --output-cost 0.00003 --context-window 128000
nemu models update <id> --output-cost 0.00004
nemu models delete <id> --yes
```

`--compatibility` is `OPENAI_COMPATIBLE`, `ANTHROPIC` or `OPENAI_RESPONSES`. Model `--type` is
`chat`, `embedding`, `moderation`, `vision`, `audio` or `image`.

### Prompts and mappings

```bash
nemu prompts create --name house-style --content "Answer plainly."
nemu prompts list --type SYSTEM
nemu prompts update <id> --content "Answer very plainly."
nemu prompts delete <id> --yes

nemu mappings create --source "gpt-4*" --target myprovider/gpt-5 --priority 10
nemu mappings list
nemu mappings delete <id> --yes
```

### Reading

```bash
nemu metrics list --limit 20 --start 2026-09-01T00:00:00Z
nemu metrics get <request-id>
nemu quotas list
nemu quotas update <id> --limit 5000
nemu indexes create https://example.com --max-pages 20
nemu workflows list
```

### Anything else

```bash
nemu api GET api/v1/workspaces
nemu api POST api/v1/providers --data '{"name":"x","priority":1}'
```

`api` signs the request with your token and prints the raw JSON, so an endpoint with no dedicated
command is still one line away.

## Context for coding agents

Nemu Context keeps notes about a project (decisions, gotchas, conventions, and a handoff saying where
work stopped) and gives them back to whichever agent opens the project next, on any machine. Your own
agent reads and writes them; Nemu never calls a model.

```bash
npm i -g nemu-cli        # clients start nemu on every session, so install it globally
nemu login
nemu setup claude        # or: nemu setup codex   (aliases: cc, claude-code)
```

Setup registers a `nemu` MCP server with the client through the client's own command
(`claude mcp add --scope user`, `codex mcp add`) and asks whether to install hooks. Hooks load the
project's notes when a session starts and, after a few edits inside the project, remind the agent to
save a handoff when it finishes. If the work is still unsaved when the agent stops, the Stop hook asks
once per session (Claude Code shows that one request as "Stop hook error"). Codex runs
hooks only after you trust them once with `/hooks`. Pass `--hooks`, `--no-hooks` or `--yes` to skip
the question.

Editors work the same way without hooks: `nemu setup cursor`, `vscode`, `gemini`, `windsurf`, `zed`
or `opencode` writes only the `nemu` entry into that editor's config (`~/.cursor/mcp.json`, VS Code's
user `mcp.json` through `code --add-mcp`, `~/.gemini/settings.json`,
`~/.codeium/windsurf/mcp_config.json`, Zed's `settings.json`, OpenCode's
`~/.config/opencode/opencode.json` or `opencode.jsonc`). Everything else in the file,
comments included, stays as it was, the previous file is kept with a `.nemu-backup` suffix, and a
file that cannot be parsed is never touched.

| Command | Does |
| --- | --- |
| `nemu claude [-- args]` | Set up if needed, then start Claude Code with the args after `--` |
| `nemu codex [-- args]` | The same for Codex |
| `nemu claude load memories [--all] [--yes]` | Import Claude Code's saved memories for this project (or all) |
| `nemu claude load sessions [--limit n]` | Open Claude with your recent sessions and let it save what matters |
| `nemu codex load sessions [--limit n]` | The same for Codex |
| `nemu mcp` | The stdio MCP bridge clients start; it uses your login and refreshes it |
| `nemu mcp config <client>` | Config for `cursor`, `gemini`, `vscode`, `windsurf`, `zed`, `opencode`, `claude`, `codex`, `remote` |
| `nemu context` | What an agent sees for this folder |
| `nemu context search <words>` | Search this project's notes |
| `nemu context projects` / `export --out file` | List projects, or export everything as JSON |
| `nemu status` | Sign in, this device, global install, and each client's setup |
| `nemu uninstall [client\|all]` | Remove exactly what setup added, for any client or editor |
| `nemu repair` | Bring the Nemu hooks and editor entries up to date for this version; also runs by itself once after each update |
| `nemu update [--yes]` | Check for a newer version and install it. The CLI also asks by itself, at most once a day; `NEMU_NO_UPDATE_CHECK=1` turns that off |
| `nemu token [--header]` | Print a fresh access token |

A project is recognised by its first git commit, so the same repository shares notes on every machine
you sign in from. Session transcripts never leave your machine: `load sessions` hands them to your
own agent, which decides what to save. Secrets are removed before anything is saved, on your machine
and again on the server, and saved notes are always given to agents as data, never as instructions.

Each computer you sign in from is registered as a device. Revoke one in the console under Context to
stop it reading or writing; what it already saved stays.

## Syncing a folder with a vault

A vault is an Obsidian compatible folder of Markdown notes kept in your workspace's Context.
`nemu sync` keeps a folder on this computer in step with one.

```bash
nemu vault link ~/Notes --vault "Notes"   # or --create for a new vault named after the folder
nemu sync ~/Notes                         # one run
nemu sync ~/Notes --watch                 # keep syncing until Ctrl C
```

| Command | Does |
| --- | --- |
| `nemu vault list` | Vaults in the workspace |
| `nemu vault link <folder> [--vault <name\|id>] [--create] [--obsidian]` | Link a folder; writes `<folder>/.nemu/vault.json` |
| `nemu sync [folder] [--watch] [--dry-run] [--conflicts=merge\|file] [--allow-deletes]` | Sync a linked folder (the current one, or the nearest parent that is linked) |
| `nemu vault status [folder]` | Last sync, device settings and open conflict copies |
| `nemu vault unlink [folder]` | Stop syncing; the files stay |

Files are compared by content, never by modification time. A note changed on both sides is merged
line by line when the edits do not overlap; otherwise the vault's version keeps the name and yours
is saved beside it as `Note (conflict, <device>, <date> <time>).md`. Conflict markers are never
written into a note. `--conflicts=file` always writes the conflict file instead of merging, and is
remembered for this device. An edit wins over a delete, and a rename keeps the note's history.

Sync refuses to run without `.nemu/vault.json`, so an unmounted drive never reads as "everything was
deleted". A run that would delete more than 10 files, every file, or at least 3 files and more than
10% of the vault stops and deletes nothing; pass `--allow-deletes` if you meant it. Symbolic links,
files above the plan's size, case clashes and names Windows cannot hold are skipped and listed.
`.git/`, `node_modules/`, `.trash/`, `.DS_Store`, `._*` and `.obsidian/workspace*.json` are never
synced, the rest of `.obsidian/` only with `--obsidian`, and a `.nemuignore` file adds patterns.
What each folder last agreed with its vault is kept in `~/.nemu/vaults/<vault id>.json`.

`tests/sim/simulate.ts` runs several fake devices with random edits, moves, deletes, crashes and
duplicated requests against a development platform and checks that they converge without losing a
byte. It does nothing unless `NEMU_SIM_API_URL`, `NEMU_SIM_API_KEY` and `NEMU_SIM_ROOT` are set, so
`bun test` stays offline.

## Error references

After you sign in, a command that fails sends a small report and prints a reference like
`NMU-7F3K-2Q9D` to quote if you contact support@nemu.cc. A report holds the command and flag names
(never their values), the CLI, OS and Node versions, and the error with secrets and your home folder
removed. Turn it off with `nemu config set reports off` or `NEMU_NO_REPORTS=1`.

## Deleting

Every destructive command needs `--yes`. Without it the CLI refuses and tells you what it was about
to remove. Setup and imports ask before changing anything when run in a terminal, and never ask when
run from a script.

Some things the CLI deliberately cannot do. It never asks for `workspaces:delete` or `keys:write`, so
it cannot delete a workspace you reached through it or mint a gateway key. Workflows and metrics are
read only through the API. Quota rules can be read, changed and removed but not created.

## Where the token lives

`~/.nemu/auth.json`. On Linux and macOS it is written `0600`, readable only by you. Windows has no
equivalent mode, so it inherits the permissions of your user profile directory.

`nemu logout` deletes the file from this machine. It does not revoke anything on the server, so if the
machine is not yours, revoke the grant in your account settings as well.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `NEMU_API_URL` | `https://app.nemu.cc` | Point the CLI at another console |
| `NEMU_CLIENT_ID` | `nemu_cli` | Use a different OAuth client |
| `NEMU_CONFIG_DIR` | `~/.nemu` | Store the token somewhere else |
| `NEMU_NO_REPORTS` | unset | `1` turns off error reports |
| `NEMU_BIN` | unset | Command setup writes into client configs instead of the global `nemu` |
| `CLAUDE_CONFIG_DIR`, `CODEX_HOME` | client defaults | Honoured when setup writes hooks |
| `NO_COLOR` | unset | Turn off colour |

## If something fails

`This build is not a recognised client` means the console you are pointed at does not know
`nemu_cli`. Check `NEMU_API_URL`.

`The code expired before it was approved` means more than 15 minutes passed. Run `nemu login` again.

`The request was rejected in the browser` means Reject was pressed. Nothing was authorized.

On Git Bash for Windows, a path beginning with `/` is rewritten into a Windows path before the CLI
sees it, so `nemu api GET /api/v1/user` fails. Drop the leading slash and use `api/v1/user`.

## Licence

MIT
