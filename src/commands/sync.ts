import { resolve } from "node:path";
import { bool_flag, flag, type Args } from "../args.js";
import { device_name } from "../device.js";
import { CliError } from "../errors.js";
import { emit, is_json_mode } from "../output.js";
import { bold, cyan, dim, fail, green, out, red } from "../ui.js";
import { open_linked } from "../vault/connect.js";
import { run_sync, type SyncEvent, type SyncReport } from "../vault/engine.js";
import type { Action } from "../vault/plan.js";
import { find_root, read_marker, type DeviceSettings } from "../vault/state.js";
import { watch_folder } from "../vault/watch.js";

function settings_from(args: Args): Partial<DeviceSettings> {
  const settings: Partial<DeviceSettings> = {};
  const conflicts = flag(args, "conflicts");
  if (conflicts !== undefined) {
    if (conflicts !== "merge" && conflicts !== "file") {
      throw new CliError("--conflicts is merge or file.", "invalid_arguments");
    }
    settings.conflicts = conflicts;
  }
  const obsidian = flag(args, "obsidian");
  if (obsidian !== undefined || bool_flag(args, "obsidian")) {
    if (obsidian !== undefined && obsidian !== "on" && obsidian !== "off") {
      throw new CliError("--obsidian is on or off.", "invalid_arguments");
    }
    settings.obsidian = obsidian !== "off";
  }
  const plugins = flag(args, "obsidian-plugins");
  if (plugins !== undefined || bool_flag(args, "obsidian-plugins")) {
    if (plugins !== undefined && plugins !== "on" && plugins !== "off") {
      throw new CliError("--obsidian-plugins is on or off.", "invalid_arguments");
    }
    settings.obsidian_plugins = plugins !== "off";
  }
  return settings;
}

async function root_of(args: Args): Promise<string> {
  const raw = args.positional[0];
  if (raw !== undefined) {
    const folder = resolve(raw);
    if ((await read_marker(folder)) === null) {
      throw new CliError(
        `${folder} has no .nemu/vault.json, so it is not a linked vault folder. Nothing was synced. If it lives on a drive, check that the drive is mounted.`,
        "not_linked",
      );
    }
    return folder;
  }
  const found = await find_root(process.cwd());
  if (found === null) {
    throw new CliError(
      "This folder is not linked to a vault. Run nemu vault link <folder> first, or pass the folder to nemu sync.",
      "not_linked",
    );
  }
  return found;
}

function print_event(event: SyncEvent): void {
  switch (event.kind) {
    case "pulled":
      out(`  ${cyan("↓")} ${event.path}`);
      return;
    case "pushed":
      out(`  ${green("↑")} ${event.path}`);
      return;
    case "restored":
      out(`  ${green("↑")} ${event.path} ${dim("(restored, edited here after it was deleted elsewhere)")}`);
      return;
    case "merged":
      out(`  ${green("⇄")} ${event.path} ${dim("(merged edits from both sides)")}`);
      return;
    case "deleted_local":
      out(`  ${red("−")} ${event.path} ${dim("(deleted elsewhere)")}`);
      return;
    case "deleted_remote":
      out(`  ${red("−")} ${event.path} ${dim("(deleted here, removed from the vault; history keeps it)")}`);
      return;
    case "moved":
      out(`  ${cyan("→")} ${event.from} ${dim("to")} ${event.to}`);
      return;
    case "conflict":
      out(`  ${red("!")} ${event.path} ${dim("conflict: your version is kept as")} ${event.copy}`);
      return;
    case "skipped":
      out(dim(`  · ${event.path}: ${event.reason}`));
      return;
    case "notice":
      out(dim(`  ${event.message}`));
      return;
  }
}

function describe(action: Action): string | null {
  switch (action.kind) {
    case "pull":
      return `download ${action.path}`;
    case "push":
      return `upload ${action.local.path}${action.reason === "new" ? " (new)" : ""}`;
    case "merge":
      return `merge ${action.remote.path}`;
    case "keep_both":
      return `keep both versions of ${action.remote.path}; yours becomes ${action.copy_path}`;
    case "delete_local":
      return `delete ${action.disk} here (deleted elsewhere)`;
    case "delete_remote":
      return action.counted ? `delete ${action.path} from the vault` : null;
    case "move_remote":
      return `move ${action.from} to ${action.to} in the vault`;
    case "rename_local":
      return `move ${action.from} to ${action.to} here`;
    case "adopt":
    case "forget":
      return null;
  }
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function summary(report: SyncReport): string {
  const parts = [
    report.pulled.length > 0 ? `${report.pulled.length} down` : "",
    report.pushed.length > 0 ? `${report.pushed.length} up` : "",
    report.merged.length > 0 ? `${report.merged.length} merged` : "",
    report.moved.length > 0 ? `${report.moved.length} moved` : "",
    report.deleted_local.length + report.deleted_remote.length > 0
      ? `${report.deleted_local.length + report.deleted_remote.length} deleted`
      : "",
    report.conflicts.length > 0 ? plural(report.conflicts.length, "conflict") : "",
  ].filter((part) => part.length > 0);
  return parts.length === 0 ? "Already in sync" : parts.join(", ");
}

function print_report(name: string, report: SyncReport): void {
  if (report.dry_run) {
    const lines = report.planned.map(describe).filter((line): line is string => line !== null);
    out(`  ${bold(name)} ${dim("dry run, nothing was changed")}`);
    if (lines.length === 0) out(dim("  Already in sync."));
    for (const line of lines) out(`  ${line}`);
    return;
  }
  if (report.waiting.length > 0) {
    out(dim(`  Still being written, synced on the next run: ${report.waiting.join(", ")}`));
  }
  if (report.blocked !== null) fail(`Uploads stopped: ${report.blocked.message} Downloads continued.`);
  out(`${green("✓")} ${bold(name)} ${summary(report)}`);
}

function json_report(report: SyncReport): Record<string, unknown> {
  const { planned, ...rest } = report;
  return {
    ok: true,
    ...rest,
    ...(report.dry_run ? { planned: planned.map(describe).filter((line) => line !== null) } : {}),
  };
}

export async function sync(args: Args): Promise<number> {
  const root = await root_of(args);
  const marker = (await read_marker(root))!;
  const linked = await open_linked(marker);
  const settings = settings_from(args);
  const json = is_json_mode();
  if (settings.obsidian_plugins === true && !json) {
    out(
      `  ${bold("Obsidian plugins will sync on this device.")} ${dim("Plugins are code Obsidian runs, so a plugin added on any synced device runs here too. Turn it off with --obsidian-plugins off.")}`,
    );
  }
  const once = (lock: boolean) =>
    run_sync({
      root,
      api: linked.api,
      state_path: linked.state_path,
      device: device_name(),
      dry_run: bool_flag(args, "dry-run"),
      allow_deletes: bool_flag(args, "allow-deletes"),
      settings,
      lock,
      on_event: json ? undefined : print_event,
    });

  if (!bool_flag(args, "watch") || bool_flag(args, "dry-run")) {
    const report = await once(true);
    if (json) emit(json_report(report));
    else print_report(marker.vault_name, report);
    return report.blocked === null ? 0 : 2;
  }

  if (!json) out(dim(`  Watching ${root}. Press Ctrl+C to stop.`));
  let exit = 0;
  await watch_folder({
    root,
    run: async () => {
      const report = await once(false);
      const quiet =
        report.pulled.length + report.pushed.length + report.merged.length + report.moved.length +
          report.deleted_local.length + report.deleted_remote.length + report.conflicts.length ===
        0;
      if (json) emit(json_report(report));
      else if (!quiet) print_report(marker.vault_name, report);
    },
    on_error: (error) => {
      const code = error instanceof CliError ? error.code : "unexpected";
      const message = error instanceof Error ? error.message : String(error);
      if (json) emit({ ok: false, error: message, code });
      else fail(message);
      if (code === "sync_stopped" || code === "not_linked" || code === "server_mismatch") {
        exit = 1;
        return "stop";
      }
      return "continue";
    },
  });
  return exit;
}
