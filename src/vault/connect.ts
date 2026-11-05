import { read_credentials, type StoredCredentials } from "../config.js";
import { device_name } from "../device.js";
import { CliError } from "../errors.js";
import { send } from "../http.js";
import { VERSION } from "../version.js";
import { VaultApi, type Transport, type VaultClient } from "./api.js";
import { vault_keys } from "./private/crypto.js";
import { PrivateVaultApi } from "./private/api.js";
import { load_vault_key } from "./private/keystore.js";
import { state_path_for, type Marker } from "./state.js";

export function cli_transport(workspace?: string | null): Transport {
  return async (method, path, options) => {
    const { response } = await send(method, path, {
      ...options,
      workspace: workspace ?? undefined,
    });
    return response;
  };
}

export function client_label(): string {
  return `nemu-sync/${VERSION} ${device_name()}`.replace(/[^\x20-\x7e]/g, "").slice(0, 64);
}

export async function signed_in(): Promise<StoredCredentials> {
  const credentials = await read_credentials();
  if (credentials === null) throw new CliError("Not signed in. Run nemu login.", "not_signed_in");
  return credentials;
}

export interface Linked {
  api: VaultClient;
  state_path: string;
  is_private: boolean;
}

export async function open_linked(marker: Marker): Promise<Linked> {
  const credentials = await signed_in();
  if (credentials.api_url !== marker.server) {
    throw new CliError(
      `This folder is linked to a vault on ${marker.server}, but you are signed in to ${credentials.api_url}. Nothing was synced.`,
      "server_mismatch",
    );
  }
  if (
    credentials.kind === "key" &&
    credentials.workspace !== undefined &&
    marker.workspace_id !== null &&
    credentials.workspace.id !== marker.workspace_id
  ) {
    throw new CliError(
      `This folder belongs to another workspace than the API key you signed in with (${credentials.workspace.name}). Nothing was synced.`,
      "workspace_mismatch",
    );
  }
  const api = new VaultApi(cli_transport(marker.workspace_id), marker.vault_id, client_label());
  const info = await api.info();
  const vault_key = await load_vault_key(marker.vault_id);
  const is_pinned_private = marker.mode === "private" || vault_key !== null;
  const says_private = info.data.mode === "private";
  if (is_pinned_private !== says_private && (marker.mode !== undefined || vault_key !== null)) {
    throw new CliError(
      `Nemu now reports "${marker.vault_name}" as ${says_private ? "private" : "not private"}, but it was ${is_pinned_private ? "private" : "not private"} when this folder was linked. A vault never changes this, so nothing was synced. Check the vault in the console.`,
      "vault_mode_changed",
    );
  }
  if (!says_private) {
    return { api, state_path: state_path_for(marker.vault_id), is_private: false };
  }
  if (vault_key === null) {
    throw new CliError(
      `"${marker.vault_name}" is a private vault and is locked on this computer. Run nemu vault unlock first. Nothing was synced.`,
      "vault_locked",
    );
  }
  return {
    api: new PrivateVaultApi(api, vault_keys(marker.vault_id, vault_key)),
    state_path: state_path_for(marker.vault_id),
    is_private: true,
  };
}
