import { z } from "zod";
import { API_VERSION } from "../config.js";
import { fresh_credentials } from "../auth/token.js";
import { CliError } from "../errors.js";
import { VERSION } from "../version.js";

const reply_schema = z.object({
  result: z
    .object({
      content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
      structuredContent: z.record(z.string(), z.unknown()).optional(),
      isError: z.boolean().optional(),
    })
    .optional(),
  error: z.object({ message: z.string() }).optional(),
});

export interface ToolReply {
  text: string;
  data: Record<string, unknown>;
}

const TOOL_TIMEOUT_MS = 120_000;

export async function call_studio_tool(name: string, args: Record<string, unknown>): Promise<ToolReply> {
  const credentials = await fresh_credentials();
  let response: Response;
  try {
    response = await fetch(`${credentials.api_url}/api/mcp?toolkits=studio`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credentials.access_token}`,
        "content-type": "application/json",
        accept: "application/json",
        "nemu-api-version": API_VERSION,
        "user-agent": `nemu-cli/${VERSION}`,
        "x-nemu-client": "cli",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
    });
  } catch {
    throw new CliError(`Could not reach ${credentials.api_url}`, "network");
  }
  if (response.status === 401) throw new CliError("Your sign in expired. Run nemu login.", "not_signed_in");
  if (!response.ok) throw new CliError(`Nemu answered ${response.status}.`, "studio_failed");
  const parsed = reply_schema.safeParse(await response.json());
  if (!parsed.success) throw new CliError("Nemu sent an unreadable answer.", "studio_failed");
  if (parsed.data.error !== undefined) throw new CliError(parsed.data.error.message, "studio_failed");
  const result = parsed.data.result;
  if (result === undefined) throw new CliError("Nemu sent an empty answer.", "studio_failed");
  const text = result.content
    .map((part) => part.text ?? "")
    .filter((part) => part.length > 0)
    .join("\n");
  if (result.isError === true) throw new CliError(text, "studio_failed");
  return { text, data: result.structuredContent ?? {} };
}
