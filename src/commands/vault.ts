import { mkdir, readdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { bool_flag, flag, type Args } from "../args.js";
import { CliError } from "../errors.js";
import { emit, is_json_mode, table } from "../output.js";
import { bold, dim, out, success } from "../ui.js";
import { create_vault, list_vaults, VaultApi, type RemoteVault } from "../vault/api.js";
import { cli_transport, client_label, signed_in } from "../vault/connect.js";
import { is_conflict_copy } from "../vault/paths.js";
import {
  empty_state,
  find_root,
  marker_path,
  read_marker,
  read_state,
  remove_marker,
  remove_state,
  state_path_for,
  write_marker,
  write_state,
} from "../vault/state.js";
import { is_default_ignored } from "../vault/ignore.js";
import { load_vault_key } from "../vault/private/keystore.js";
import { approve_requests, create_private_vault, forget_key, unlock_vault } from "./private.js";

const USAGE =
  "Use: nemu vault list | link <folder> [--vault <name|id>] [--create [--private]] [--obsidian] | unlink [folder] | status [folder] | unlock [folder] [--password|--recovery|--approve] | approve [folder] | forget [folder]";

function size_of(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function list(args: Args): Promise<number> {
  await signed_in();
  const vaults = await list_vaults(cli_transport(flag(args, "workspace", "w")));
  table(
    vaults.map((vault) => ({
      id: vault.id,
      name: vault.name,
      notes: vault.notes ?? "",
      size: size_of(vault.stored_bytes),
    })),
    ["id", "name", "notes", "size"],
    "No vaults yet. Create one with nemu vault link <folder> --create.",
  );
  return 0;
}

function pick_vault(vaults: RemoteVault[], wanted: string | undefined): RemoteVault | null {
  if (wanted === undefined) return vaults.length === 1 ? vaults[0]! : null;
  return (
    vaults.find((vault) => vault.id === wanted) ??
    vaults.find((vault) => vault.name.toLowerCase() === wanted.toLowerCase()) ??
    null
  );
}

async function link(args: Args): Promise<number> {
  const raw = args.positional[1];
  if (raw === undefined) throw new CliError(USAGE, "invalid_arguments");
  const folder = resolve(raw);
  const credentials = await signed_in();
  const workspace = flag(args, "workspace", "w");
  const wanted = flag(args, "vault");
  const create = bool_flag(args, "create");
  const is_private = bool_flag(args, "private");
  if (is_private && !create) {
    throw new CliError("--private makes a new vault, so it goes with --create.", "invalid_arguments");
  }

  const enclosing = await find_root(dirname(folder));
  if (enclosing !== null && enclosing !== folder) {
    throw new CliError(`${folder} is inside ${enclosing}, which is already linked to a vault.`, "already_linked");
  }
  await mkdir(folder, { recursive: true });
  const existing = await read_marker(folder);

  const transport = cli_transport(workspace);
  const vaults = await list_vaults(transport);
  let vault = pick_vault(vaults, wanted);
  if (vault === null && create) {
    vault = is_private
      ? await create_private_vault(transport, wanted ?? basename(folder))
      : await create_vault(transport, wanted ?? basename(folder));
  }
  if (vault === null) {
    const names = vaults.map((entry) => `"${entry.name}"`).join(", ");
    throw new CliError(
      vaults.length === 0
        ? "This workspace has no vaults yet. Add --create to make one named after the folder."
        : wanted === undefined
          ? `Choose a vault with --vault <name|id>: ${names}. Or add --create for a new one.`
          : `No vault is called "${wanted}". Have: ${names}. Add --create to make it.`,
      "vault_not_found",
    );
  }
  if (existing !== null && existing.vault_id !== vault.id) {
    throw new CliError(
      `${folder} is already linked to the vault "${existing.vault_name}". Run nemu vault unlink ${folder} first.`,
      "already_linked",
    );
  }

  const state_path = state_path_for(vault.id);
  const previous = await read_state(state_path);
  if (previous !== null && previous.root !== folder && (await read_marker(previous.root))?.vault_id === vault.id) {
    throw new CliError(
      `The vault "${vault.name}" is already synced into ${previous.root} on this computer. Run nemu vault unlink ${previous.root} first.`,
      "already_linked",
    );
  }

  const info = await new VaultApi(transport, vault.id, client_label()).info();
  const workspace_id = info.workspace_id ?? credentials.workspace?.id ?? workspace ?? null;
  await write_marker(folder, {
    version: 1,
    vault_id: vault.id,
    vault_name: vault.name,
    workspace_id,
    server: credentials.api_url,
    linked_at: new Date().toISOString(),
    mode: info.data.mode === "private" ? "private" : "standard",
  });
  if (previous === null || previous.root !== folder || existing === null) {
    await write_state(
      state_path,
      empty_state(vault.id, folder, {
        conflicts: previous?.settings.conflicts,
        obsidian: bool_flag(args, "obsidian") || (previous?.settings.obsidian ?? false),
      }),
    );
  } else if (bool_flag(args, "obsidian")) {
    await write_state(state_path, { ...previous, settings: { ...previous.settings, obsidian: true }, full_next: true });
  }

  if (is_json_mode()) {
    emit({ ok: true, folder, vault: { id: vault.id, name: vault.name }, workspace_id, marker: marker_path(folder) });
    return 0;
  }
  success(`Linked ${folder} to the ${info.data.mode === "private" ? "private " : ""}vault ${bold(vault.name)}`);
  if (info.data.mode === "private" && (await load_vault_key(vault.id)) === null) {
    out(dim(`  It is locked on this computer. Run nemu vault unlock ${raw} first.`));
  }
  out(dim(`  Run nemu sync ${raw} to sync it, or nemu sync ${raw} --watch to keep it in sync.`));
  return 0;
}

async function locate(args: Args): Promise<string> {
  const raw = args.positional[1];
  if (raw !== undefined) return resolve(raw);
  const found = await find_root(process.cwd());
  if (found === null) throw new CliError("This folder is not linked to a vault.", "not_linked");
  return found;
}

async function unlink(args: Args): Promise<number> {
  const folder = await locate(args);
  const marker = await read_marker(folder);
  if (marker === null) throw new CliError(`${folder} is not linked to a vault.`, "not_linked");
  const state_path = state_path_for(marker.vault_id);
  const state = await read_state(state_path);
  if (state === null || state.root === folder) await remove_state(state_path);
  await remove_marker(folder);
  if (is_json_mode()) {
    emit({ ok: true, folder, vault_id: marker.vault_id });
    return 0;
  }
  success(`Unlinked ${folder} from "${marker.vault_name}". Your files are still there.`);
  return 0;
}

async function conflict_copies(root: string, relative = ""): Promise<string[]> {
  const found: string[] = [];
  const entries = await readdir(relative === "" ? root : `${root}/${relative}`, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (is_default_ignored(path, false)) continue;
    if (entry.isDirectory()) found.push(...(await conflict_copies(root, path)));
    else if (entry.isFile() && is_conflict_copy(path.normalize("NFC"))) found.push(path);
  }
  return found;
}

async function status(args: Args): Promise<number> {
  const folder = await locate(args);
  const marker = await read_marker(folder);
  if (marker === null) throw new CliError(`${folder} is not linked to a vault.`, "not_linked");
  const state = await read_state(state_path_for(marker.vault_id));
  const conflicts = await conflict_copies(folder);
  const marker_mode = await vault_mode(marker);
  const summary = {
    folder,
    vault: { id: marker.vault_id, name: marker.vault_name },
    server: marker.server,
    workspace_id: marker.workspace_id,
    tracked: state === null ? 0 : Object.keys(state.files).length,
    last_sync: state?.synced_at ?? null,
    conflicts_mode: state?.settings.conflicts ?? "merge",
    private: marker_mode === "private",
    unlocked: marker_mode === "private" ? (await load_vault_key(marker.vault_id)) !== null : null,
    obsidian_settings: state?.settings.obsidian ?? false,
    obsidian_plugins: state?.settings.obsidian_plugins ?? false,
    conflicts,
  };
  if (is_json_mode()) {
    emit(summary);
    return 0;
  }
  out(`  ${bold(marker.vault_name)} ${dim(marker.vault_id)}`);
  out(`  ${dim("folder   ")} ${folder}`);
  out(`  ${dim("files    ")} ${summary.tracked}`);
  if (summary.private) {
    out(`  ${dim("private  ")} ${summary.unlocked === true ? "open on this computer" : "locked on this computer (nemu vault unlock)"}`);
  }
  out(`  ${dim("last sync")} ${summary.last_sync ?? "never"}`);
  out(`  ${dim("conflicts")} ${summary.conflicts_mode === "merge" ? "merge when possible" : "always write a conflict file"}`);
  out(`  ${dim(".obsidian")} ${summary.obsidian_settings ? "synced" : "not synced on this device"}`);
  if (summary.obsidian_settings) {
    out(`  ${dim("plugins  ")} ${summary.obsidian_plugins ? "synced" : "not synced (plugins are code)"}`);
  }
  if (conflicts.length > 0) {
    out();
    out(`  ${bold(`${conflicts.length} open conflict${conflicts.length === 1 ? "" : "s"}`)} ${dim("(delete the copy you do not want)")}`);
    for (const path of conflicts) out(`    ${path}`);
  }
  return 0;
}

async function vault_mode(marker: { vault_id: string; workspace_id: string | null }): Promise<string> {
  try {
    await signed_in();
    const info = await new VaultApi(cli_transport(marker.workspace_id), marker.vault_id, client_label()).info();
    return info.data.mode ?? "standard";
  } catch {
    return "unknown";
  }
}

async function linked_marker(args: Args) {
  const folder = await locate(args);
  const marker = await read_marker(folder);
  if (marker === null) throw new CliError(`${folder} is not linked to a vault.`, "not_linked");
  await signed_in();
  return marker;
}

async function unlock(args: Args): Promise<number> {
  const marker = await linked_marker(args);
  await unlock_vault(cli_transport(marker.workspace_id), marker.vault_id, marker.vault_name, {
    password: bool_flag(args, "password"),
    recovery: bool_flag(args, "recovery"),
    approve: bool_flag(args, "approve"),
  });
  return 0;
}

async function approve(args: Args): Promise<number> {
  const marker = await linked_marker(args);
  await approve_requests(cli_transport(marker.workspace_id), marker.vault_id, marker.vault_name);
  return 0;
}

async function forget(args: Args): Promise<number> {
  const folder = await locate(args);
  const marker = await read_marker(folder);
  if (marker === null) throw new CliError(`${folder} is not linked to a vault.`, "not_linked");
  await forget_key(marker.vault_id, marker.vault_name);
  return 0;
}

export async function vault(args: Args): Promise<number> {
  const action = args.positional[0] ?? "list";
  if (action === "list") return list(args);
  if (action === "link") return link(args);
  if (action === "unlink") return unlink(args);
  if (action === "status" || action === "conflicts") return status(args);
  if (action === "unlock") return unlock(args);
  if (action === "approve") return approve(args);
  if (action === "forget") return forget(args);
  throw new CliError(USAGE, "invalid_arguments");
}
