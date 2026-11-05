import { Nemu, NemuDevice, type Workspace } from "@nemu-ai/sdk";
import {
  api_url,
  client_id,
  write_credentials,
} from "./config.js";
import { fresh_credentials } from "./auth/token.js";
import { CliError } from "./errors.js";

export class NotSignedIn extends Error {
  constructor() {
    super("Not signed in. Run nemu login.");
    this.name = "NotSignedIn";
  }
}

export function device_client(url = api_url()): NemuDevice {
  return new NemuDevice({
    client_id: client_id(),
    base_url: `${url.replace(/\/+$/, "")}/api/v1`,
  });
}

export async function client(): Promise<Nemu> {
  let credentials;
  try {
    credentials = await fresh_credentials();
  } catch (error) {
    if (error instanceof CliError && error.code === "not_signed_in") throw new NotSignedIn();
    throw error;
  }

  const device = device_client(credentials.api_url);

  return device.from_tokens(
    {
      access_token: credentials.access_token,
      refresh_token: credentials.refresh_token,
      expires_at: credentials.expires_at,
      scope: credentials.scope,
    },
    (rotated) => {
      void write_credentials({
        ...credentials,
        access_token: rotated.access_token,
        refresh_token: rotated.refresh_token ?? credentials.refresh_token,
        expires_at: rotated.expires_at ?? Date.now() + 3_600_000,
      });
    },
  );
}

export async function resolve_workspace(
  nemu: Nemu,
  requested?: string,
): Promise<Workspace> {
  const workspaces = await nemu.workspaces.list();

  if (workspaces.length === 0) {
    throw new Error("This account has no workspaces.");
  }

  if (requested === undefined) {
    return workspaces[0]!;
  }

  const match = workspaces.find(
    (workspace) =>
      workspace.id === requested ||
      workspace.name.toLowerCase() === requested.toLowerCase(),
  );

  if (!match) {
    const names = workspaces.map((workspace) => workspace.name).join(", ");
    throw new Error(`No workspace matched "${requested}". Have: ${names}`);
  }
  return match;
}
