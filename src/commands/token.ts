import { fresh_credentials } from "../auth/token.js";
import { bool_flag, type Args } from "../args.js";
import { emit, is_json_mode } from "../output.js";

export async function token(args: Args): Promise<number> {
  const credentials = await fresh_credentials();
  if (is_json_mode()) {
    emit({ access_token: credentials.access_token, expires_at: credentials.expires_at });
    return 0;
  }
  if (bool_flag(args, "header")) {
    process.stdout.write(
      `${JSON.stringify({ Authorization: `Bearer ${credentials.access_token}` })}\n`,
    );
    return 0;
  }
  process.stdout.write(`${credentials.access_token}\n`);
  return 0;
}
