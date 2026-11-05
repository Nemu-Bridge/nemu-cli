import { NemuDeviceError, type Nemu } from "@nemu-ai/sdk";
import {
  api_url,
  is_expired,
  read_credentials,
  write_credentials,
} from "../config.js";
import { device_client } from "../session.js";
import { login_key } from "./key.js";
import { verify_device } from "../device.js";
import { bool_flag, type Args } from "../args.js";
import { done, is_json_mode } from "../output.js";
import {
  bold,
  cyan,
  dim,
  open_browser,
  out,
  red,
  spinner,
  success,
} from "../ui.js";

async function account_name(nemu: Nemu): Promise<string | null> {
  try {
    const account = await nemu.user.get();
    return account.username ?? account.email ?? null;
  } catch {
    return null;
  }
}

export async function login(args: Args): Promise<number> {
  if (args.positional[0] === "key") return login_key();
  const url = api_url();
  const force = bool_flag(args, "force", "f");
  const no_browser = bool_flag(args, "no-browser");

  const existing = await read_credentials();
  if (existing !== null && !is_expired(existing) && !force) {
    const who = existing.account ?? "an existing session";
    if (is_json_mode()) {
      done("Already signed in", { account: existing.account });
      return 0;
    }
    out(`Already signed in as ${bold(who)}.`);
    out(dim("Run nemu login --force to sign in again."));
    return 0;
  }

  const device = device_client(url);
  const authorization = await device.request_code();

  if (is_json_mode()) {
    out(
      JSON.stringify(
        {
          verification_uri: authorization.verification_uri,
          user_code: authorization.user_code,
          expires_in: authorization.expires_in,
        },
        null,
        2,
      ),
    );
  } else {
    out();
    out(`  Open  ${cyan(authorization.verification_uri)}`);
    out(`  Code  ${bold(authorization.user_code)}`);
    out();
    if (!no_browser) {
      const is_opened = open_browser(authorization.verification_uri, api_url());
      out(
        dim(
          is_opened
            ? "  Opening your browser. Use the link above if it does not."
            : "  The sign-in link is not on your Nemu server, so it was not opened.",
        ),
      );
      out();
    }
  }

  const wait = is_json_mode()
    ? { stop: () => {} }
    : spinner("Waiting for approval...");

  let nemu;
  try {
    nemu = await device.poll(authorization);
  } catch (error) {
    wait.stop();
    throw error instanceof NemuDeviceError
      ? new Error(error.message)
      : new Error("Sign in failed.");
  }
  wait.stop();

  const tokens = nemu.tokens;
  if (tokens === undefined) throw new Error("No token was issued.");

  const account = await account_name(nemu);

  const path = await write_credentials({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: tokens.expires_at ?? Date.now() + 3_600_000,
    scope: tokens.scope ?? "",
    api_url: url,
    account: account ?? undefined,
  });

  const scope_list = (tokens.scope ?? "").split(/\s+/);
  let device_id: string | null = null;
  let device_error: string | null = null;
  if (scope_list.includes("context:write")) {
    try {
      device_id = await verify_device();
    } catch (error) {
      device_error = error instanceof Error ? error.message : "Unexpected error.";
    }
  }

  if (is_json_mode()) {
    done("Logged in", { account, path, device_id, device_error });
    return 0;
  }

  success(`Logged in${account !== null ? ` as ${bold(account)}` : ""}`);
  out(dim(`  Token saved to ${path}`));
  if (device_id !== null) out(dim(`  This computer is registered as ${device_id}`));
  if (device_error !== null) {
    out(`  ${red("This computer could not be registered for Context:")} ${device_error}`);
    out(dim("  Context will refuse this computer until it is. Run nemu login --force to try again."));
  }
  return 0;
}
