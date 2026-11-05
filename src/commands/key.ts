import { z } from "zod";
import { API_VERSION, api_url, write_credentials } from "../config.js";
import { CliError } from "../errors.js";
import { VERSION } from "../version.js";
import { done, is_json_mode } from "../output.js";
import { ask_secret, bold, dim, is_interactive, out, success } from "../ui.js";

const KEY_PATTERN = /^sk_[a-z]{5}-[a-z]{5}\.[A-Za-z0-9]{40}$/;

const description_schema = z.object({
  data: z.object({
    kind: z.literal("key"),
    name: z.string(),
    workspace: z.object({ id: z.string(), name: z.string() }),
    expires_at: z.string().nullable(),
    scopes: z.array(z.string()),
    access: z.array(
      z.object({ scope: z.string(), label: z.string(), granted: z.boolean() }),
    ),
  }),
});

export type KeyDescription = z.infer<typeof description_schema>["data"];

async function read_stdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function read_key(): Promise<string> {
  const from_env = process.env.NEMU_API_KEY;
  if (from_env !== undefined && from_env.trim().length > 0) return from_env.trim();
  if (is_interactive()) return (await ask_secret("API key:")).trim();
  return (await read_stdin()).trim();
}

export async function describe_key(url: string, key: string): Promise<KeyDescription> {
  let response: Response;
  try {
    response = await fetch(`${url}/api/v1/key`, {
      headers: {
        authorization: `Bearer ${key}`,
        "nemu-api-version": API_VERSION,
        "user-agent": `nemu-cli/${VERSION}`,
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new CliError(`Could not reach ${url}.`, "network_failed");
  }
  if (response.status === 401 || response.status === 403) {
    throw new CliError(
      "This key is invalid, disabled, expired or not allowed from this address.",
      "key_rejected",
    );
  }
  const parsed = description_schema.safeParse(await response.json().catch(() => null));
  if (!response.ok || !parsed.success) {
    throw new CliError("Nemu could not describe this key.", "key_describe_failed", {
      status: response.status,
    });
  }
  return parsed.data.data;
}

export async function login_key(): Promise<number> {
  const url = api_url();
  const key = await read_key();
  if (!KEY_PATTERN.test(key)) {
    throw new CliError(
      "That is not a Nemu API key. Keys look like sk_xxxxx-xxxxx. followed by 40 letters and digits.",
      "invalid_key_format",
    );
  }
  const description = await describe_key(url, key);
  await write_credentials({
    kind: "key",
    access_token: key,
    expires_at: Number.MAX_SAFE_INTEGER,
    scope: description.scopes.join(" "),
    api_url: url,
    account: `key ${description.name}`,
    workspace: description.workspace,
  });

  if (is_json_mode()) {
    done("Signed in with an API key", {
      key: description.name,
      workspace: description.workspace,
      scopes: description.scopes,
      expires_at: description.expires_at,
    });
    return 0;
  }
  success(
    `Signed in with the key ${bold(description.name)} for the workspace ${bold(description.workspace.name)}`,
  );
  out();
  for (const row of description.access) {
    out(`  ${row.granted ? "yes" : " no"}  ${row.label}`);
  }
  out();
  if (description.expires_at !== null) {
    out(dim(`  The key expires on ${description.expires_at.slice(0, 10)}.`));
  }
  out(dim("  The key is stored only on this machine. nemu logout removes it."));
  return 0;
}
