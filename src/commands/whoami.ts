import { is_expired, read_credentials } from "../config.js";
import { client } from "../session.js";
import { detail, is_json_mode } from "../output.js";
import { bold, dim, out } from "../ui.js";
import { describe_key } from "./key.js";

export async function whoami(): Promise<number> {
  const credentials = await read_credentials();
  if (credentials === null) {
    if (is_json_mode()) {
      detail({ signed_in: false });
      return 1;
    }
    out("Not signed in. Run nemu login.");
    return 1;
  }

  if (is_expired(credentials) && credentials.refresh_token === undefined) {
    out("Your session has expired. Run nemu login.");
    return 1;
  }

  if (credentials.kind === "key") {
    const key = await describe_key(credentials.api_url, credentials.access_token);
    if (is_json_mode()) {
      detail({
        signed_in: true,
        kind: "key",
        key: key.name,
        workspace: key.workspace,
        scopes: key.scopes,
        api_url: credentials.api_url,
      });
      return 0;
    }
    out(`${bold(`key ${key.name}`)} ${dim(`in ${key.workspace.name}`)}`);
    out(dim(`  ${credentials.api_url}`));
    out(dim(`  access ${key.scopes.join(", ") || "none"}`));
    return 0;
  }

  const nemu = await client();
  const account = await nemu.user.get();

  if (is_json_mode()) {
    detail({
      signed_in: true,
      username: account.username,
      email: account.email,
      api_url: credentials.api_url,
      scope: credentials.scope,
    });
    return 0;
  }

  out(bold(account.username ?? account.email ?? "unknown"));
  out(dim(`  ${credentials.api_url}`));
  out(dim(`  scope ${credentials.scope || "none"}`));
  return 0;
}
