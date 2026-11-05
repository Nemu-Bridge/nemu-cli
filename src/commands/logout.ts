import { clear_credentials, read_credentials } from "../config.js";
import { bold, dim, out, success } from "../ui.js";

export async function logout(): Promise<number> {
  const existing = await read_credentials();
  if (existing === null) {
    out("You are not signed in.");
    return 0;
  }

  const removed = await clear_credentials();
  if (!removed) {
    out("You are not signed in.");
    return 0;
  }

  const who = existing.account;
  success(`Signed out${who !== undefined ? ` of ${bold(who)}` : ""}`);
  out(dim("  The stored token has been deleted from this machine."));
  out(dim("  Revoke it for good in your account settings."));
  return 0;
}
