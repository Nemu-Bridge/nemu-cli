# Changelog

## 1.9.0

`nemu sync` sends a file larger than one request, up to your plan's largest file (100 MB on paid
plans), in parts, and a failed upload is cancelled so no parts are left behind. Earlier versions
skip such files. The source is public at
[Nemu-Bridge/nemu-cli](https://github.com/Nemu-Bridge/nemu-cli), and the npm page links to it.

## 1.8.0

`nemu status` now asks Nemu about this computer instead of only reading local files. It shows a
device the server no longer knows or has revoked, with `nemu login --force` as the fix, and shows an
expired sign in as expired rather than ok. `nemu login` reports when registering this computer for
Context fails instead of finishing silently without a device.

`nemu setup claude` now installs Nemu as a Claude Code plugin when your Claude Code supports plugins.
The plugin carries the MCP server, so nothing else changes about how the tools work, and adds two
commands: `/remember` saves something durable to the project's memory, updating a note that already
covers it, and `/inspo` reads an inspiration folder's board in a vault, follows each reference's use,
and asks for more when the folder is thin. An older Claude Code gets the MCP server as before.
`nemu uninstall claude` removes the plugin too.

## 1.7.0

Private vaults. `nemu vault link <folder> --create --private` makes a vault whose key only your
devices hold: you choose a vault password, and a recovery key is shown once and saved to a file in
your home folder. `nemu sync` then seals every name and text before it leaves this computer, so Nemu
stores only data it cannot read.

On another computer, `nemu vault unlock` opens it with the password, the recovery key, or approval
from a device that already has it open (`nemu vault approve` there, after comparing a six digit
code). The key is kept in the macOS Keychain, protected by Windows for your account, or in a file only
your account can read on Linux. `nemu vault forget` locks it on this computer again, and
`nemu vault status` says whether it is open. In scripts, `NEMU_VAULT_PASSWORD` and
`NEMU_VAULT_RECOVERY` stand in for typing.

## 1.6.2

`.obsidian/plugins/` no longer syncs when a device turns on `--obsidian`, because plugins are code
Obsidian runs, and a plugin added on one synced device would otherwise run on every other one. Turn
it on for one device with `nemu sync --obsidian-plugins on`; the CLI says what that means when you
do. Turning it off stops syncing plugins and deletes nothing, here or in the vault. Themes, settings
and hotkeys keep syncing with `--obsidian` as before. `nemu vault status` shows the setting.

## 1.6.1

When `nemu sync` merges a note automatically, it now records the merge in the vault's merge log,
with this computer's text from before the merge, so the console can restore either side with one
click. A merge log that cannot be reached never fails the sync; the run reports it as a notice.

`-w <workspace>` works. It was read as a switch, so the workspace after it was dropped and the
command ran in your first workspace; `--workspace` was not affected. `-o` and `-d` had the same
problem and are fixed too.

`nemu vault link` on a folder that is no longer linked, such as a drive folder that was emptied and
linked again, now starts fresh and downloads the vault, instead of treating every missing file as
deleted and stopping at the mass-delete guard.

Sync never writes `.claude/`, `.codex/`, `.cursor/`, `.vscode/`, `.idea/`, `.husky/`,
`.github/workflows/` or `.git/hooks/`, in either direction, because files there can run code when
you open the folder in an editor or an agent. A folder inside the vault that is a symbolic link to
somewhere else is never written through.

## 1.6.0

`nemu sync` keeps a folder, such as an Obsidian vault, in step with a Context vault.
`nemu vault link <folder>` links it once (`--vault <name|id>` picks the vault, `--create` makes
one) and writes `.nemu/vault.json`, without which sync refuses to run, so an unmounted drive never
looks like a folder whose notes were deleted. `nemu sync --watch` keeps syncing until stopped.
`nemu vault list`, `status` and `unlink` round it off.

Each run reads the vault's changes since the last run, or lists every file when the device has been
away longer than the change history, and compares files by content, never by modification time.
Markdown changed on both sides is merged line by line when the edits do not overlap, treating CRLF
and LF as equal and keeping your file's line endings. Otherwise the vault's version keeps the name
and yours is saved beside it as `Note (conflict, <device>, <date> <time>).md`; no note ever gets
conflict markers. `--conflicts=file` always writes the conflict file instead. An edit wins over a
delete, a rename is sent as a move so the note keeps its history, and two renames onto one name
give the second ` (2)`.

A run that would delete more than 10 files, every file, or at least 3 files and more than 10% of
the vault stops and deletes nothing until you pass `--allow-deletes`. `.nemu/lock` keeps two syncs
off one folder and is taken over when its process is gone. Downloads are written to a temporary file
and renamed; uploads wait until a file has been unchanged for 2 seconds and reads the same twice.
Symbolic links, files above the plan's size, case clashes and names Windows cannot hold are skipped
and listed. Out of storage stops uploads and keeps downloading; a revoked device or key stops sync
and never deletes a local file. `.git/`, `node_modules/`, `.trash/`, `.DS_Store`, `._*` and
`.obsidian/workspace*.json` are never synced, the rest of `.obsidian/` is opt in per device, and
`.nemuignore` adds patterns.

## 1.5.0

`nemu login key` signs in with a workspace API key, the same `sk_` key that calls the gateway. It
asks for the key, or reads `NEMU_API_KEY`, and shows the workspace and access the key has. Context
and vault commands use the unified routes under `/api/v1`, and work in the workspace you choose, so
members share the workspace's Context. Earlier versions call routes that no longer exist and need
this update.

## 1.4.0

`nemu setup opencode` adds the Nemu MCP server to OpenCode's global config,
`~/.config/opencode/opencode.json` (or `opencode.jsonc` when that is the file you have), as a local
server that runs `nemu mcp --client opencode`. Like the other editors, only the `nemu` entry is
written, the previous file is kept with a `.nemu-backup` suffix, `nemu uninstall opencode` removes
it, `nemu status` lists it and `nemu mcp config opencode` prints it.

The Stop hook no longer shows up as "Stop hook error" after every few edits. Claude Code shows any
Stop request that way, so the reminder to save a handoff now arrives quietly after the third edit,
as context the agent reads and you do not see. Stop asks at most once per session, and only when the
work is still unsaved. Saving with `memory_write` resets the count. Only files inside the project
count, so an agent's scratchpad or a temp folder no longer triggers a request, and the reminder no
longer tells the agent to hide it from you.

On Windows, `git`, editors and every other command the CLI starts are now found on `PATH` only.
Before, the current folder was searched first, so a `git.cmd` inside a cloned repository ran in
place of the real git.

`nemu setup`, `nemu uninstall` and the update repair keep the permissions of
`~/.claude/settings.json` and `~/.codex/hooks.json`. A file you locked to `0600` used to come back
readable by every user on the machine. Files the CLI creates from nothing are now `0600`.

`nemu login` opens the sign-in page only when it is on the same server the CLI talks to, over https
(or http on localhost), and on Windows it opens it without going through `cmd`. It now opens the
page without the code filled in, matching the device page, so you type the code shown in the
terminal.

## 1.3.2

After an update, the CLI checks once whether what setup installed still matches what this version
needs: the Nemu hooks for Claude Code and Codex, and the nemu entry in each editor. Only Nemu's own
entries that actually differ are rewritten, with every other hook and setting left as it was, and
nothing is printed when everything already matches. This runs on the first command after an
update, right after `nemu update` installs a new version, and quietly at the start of a session.
`nemu repair` runs the same check any time. Each check is a small migration in
`src/migrations.ts`, so a future release that changes setup adds one there.

Commands are started with cross-spawn instead of a shell on Windows, which removes Node's
DEP0190 deprecation warning and escapes arguments properly.

## 1.3.1

Fixes "hook failed, exited with code 1" for Codex on Windows. Codex starts hooks through a Windows
shell that cannot launch a command whose program path is quoted, and setup wrote the path to
`nemu.cmd` in quotes. The Codex hooks now name the program unquoted (or as `nemu.cmd` when its
path has spaces). `nemu codex` repairs hooks written by an earlier version before it starts Codex,
`nemu setup codex --hooks` does the same, and `nemu status` says when a repair is needed. Claude
Code runs hooks through Git Bash on Windows and is unchanged.

## 1.3.0

`nemu setup cursor`, `nemu setup vscode`, `nemu setup gemini`, `nemu setup windsurf` and
`nemu setup zed` add the Nemu MCP server to that editor's own config. Only the `nemu` entry is
written: every other server, setting, comment and the file's indentation stay exactly as they
were, the previous file is kept next to it with a `.nemu-backup` suffix, a file that cannot be
parsed is left alone, and a different server already called `nemu` is never overwritten. VS Code
uses its own `code --add-mcp` when it is on the PATH. `nemu uninstall <editor>` removes only
that entry, and `nemu status` lists the editors it finds. Hooks remain Claude Code and Codex
only.

## 1.2.0

The CLI tells you when a newer version is out: "There is a new version available (1.2.0 -> 1.3.0).
Do you want to upgrade?" Saying yes installs it with npm. It asks at most once a day, waits at most
1.5 seconds for the registry, and stays silent in hooks, the MCP bridge, `--json` output, scripts
and CI. `nemu update` checks right away; `nemu update --yes` installs without asking. Set
`NEMU_NO_UPDATE_CHECK=1` to turn the check off.

## 1.1.0

Nemu Context for coding agents. `nemu setup claude` (aliases `cc`, `claude-code`) and
`nemu setup codex` connect the client through its own `mcp add` command and optionally install hooks
that load project notes at session start and ask for a handoff before stopping. `nemu claude` and
`nemu codex` set up if needed and start the client.

`nemu mcp` is a stdio MCP bridge for any client, using the login and refreshing it; `nemu mcp config`
prints config for Cursor, Gemini CLI, VS Code, Windsurf, Zed and remote HTTP clients.

`nemu claude load memories` imports Claude Code's saved memories. `load sessions` hands your recent
sessions to your own agent to summarise. `nemu context` shows, searches and exports notes.

Login now registers this computer as a device. Token refresh takes a lock, so several sessions
refreshing at once no longer sign each other out. `nemu status`, `nemu uninstall`, `nemu token`.

Failures after login send a scrubbed report and print an `NMU-` reference for support. Every file,
response and hook input is validated.

## 1.0.0

First real release. `login` signs in with the device grant, so nothing is pasted
into the terminal and the package carries no secret.

Commands for everything the management API exposes: workspaces, members,
budgets, providers, models, prompts, mappings, indexes, quotas, metrics and
workflows. `nemu api` calls any endpoint directly for the things that have no
command of their own.

Every command takes `--json` and exits non zero on failure, so a script or an
agent can drive it without scraping tables.

Destructive commands need `--yes`. There is no interactive prompt anywhere.

## 0.1.0

Unpublished. login, logout and whoami only.
