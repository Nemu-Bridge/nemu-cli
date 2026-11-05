import { arch, platform, release } from "node:os";
import { z } from "zod";
import { API_VERSION, read_credentials, read_settings } from "./config.js";
import { fresh_credentials } from "./auth/token.js";
import { CliError, error_code } from "./errors.js";
import { redact, strip_home } from "./context/redact.js";
import { VERSION } from "./version.js";

const SKIPPED_CODES = new Set([
  "not_signed_in",
  "invalid_client",
  "invalid_arguments",
  "unknown_command",
  "cancelled",
]);

function command_label(command: string, positional: string[]): string {
  const words = [command, ...positional.slice(0, 2)]
    .map((word) => word.toLowerCase())
    .filter((word) => /^[a-z][a-z0-9-]{0,31}$/.test(word));
  return words.slice(0, 3).join(" ");
}

function os_label(): string {
  const version = release().replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40) || "unknown";
  const architecture = arch().replace(/[^a-z0-9_]/g, "").slice(0, 16) || "unknown";
  return `${platform().replace(/[^a-z0-9]/g, "")} ${version} ${architecture}`;
}

export interface ReportInput {
  command: string;
  positional: string[];
  flags: string[];
  error: unknown;
}

export async function send_report(input: ReportInput): Promise<string | null> {
  if (process.env.NEMU_NO_REPORTS === "1") return null;
  const code = error_code(input.error);
  if (SKIPPED_CODES.has(code)) return null;
  if (input.error instanceof CliError && input.error.status !== undefined && input.error.status < 500 && input.error.reference === undefined) {
    return null;
  }
  const settings = await read_settings();
  if (!settings.reports) return null;
  if ((await read_credentials()) === null) return null;

  const label = command_label(input.command, input.positional);
  if (label.length === 0) return null;
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  const stack = input.error instanceof Error ? input.error.stack : undefined;

  try {
    const credentials = await fresh_credentials();
    const response = await fetch(`${credentials.api_url}/api/v1/cli/reports`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credentials.access_token}`,
        "content-type": "application/json",
        "nemu-api-version": API_VERSION,
        "user-agent": `nemu-cli/${VERSION}`,
      },
      body: JSON.stringify({
        command: label,
        flags: input.flags.filter((name) => /^[a-z][a-z0-9-]{0,31}$/.test(name)).slice(0, 20),
        cli_version: VERSION,
        os: os_label(),
        node_version: process.version,
        error_code: /^[a-z0-9_]{1,64}$/.test(code) ? code : undefined,
        message: strip_home(redact(message)).slice(0, 2000) || "No message",
        stack: stack === undefined ? undefined : strip_home(redact(stack)).slice(0, 4000),
        server_reference:
          input.error instanceof CliError && input.error.reference !== undefined
            ? input.error.reference
            : undefined,
        device_id: settings.device_id,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const parsed = z.object({ reference: z.string() }).safeParse(await response.json().catch(() => null));
    return parsed.success ? parsed.data.reference : null;
  } catch {
    return null;
  }
}
