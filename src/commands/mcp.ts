import { createInterface } from "node:readline";
import { z } from "zod";
import { flag, type Args } from "../args.js";
import { API_VERSION, read_settings } from "../config.js";
import { fresh_credentials } from "../auth/token.js";
import { CliError } from "../errors.js";
import { current_project } from "../context/project.js";
import { repository } from "../git.js";
import { VERSION } from "../version.js";
import { out } from "../ui.js";

const CLIENTS = ["claude-code", "codex", "cursor", "zed", "gemini", "vscode", "windsurf", "opencode", "mcp"] as const;
type ClientName = (typeof CLIENTS)[number];

const rpc_schema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});

type RpcMessage = z.infer<typeof rpc_schema>;

const BRANCH_TOOLS = new Set(["context_load", "memory_write"]);

function write_line(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function log(message: string): void {
  process.stderr.write(`[nemu mcp] ${message}\n`);
}

function rpc_failure(id: string | number | undefined, message: string, code = -32603): void {
  if (id === undefined) return;
  write_line({ jsonrpc: "2.0", id, error: { code, message } });
}

function client_from(args: Args): ClientName {
  const raw = (flag(args, "client") ?? process.env.NEMU_MCP_CLIENT ?? "mcp").toLowerCase();
  return (CLIENTS as readonly string[]).includes(raw) ? (raw as ClientName) : "mcp";
}

interface BridgeState {
  project_id: string | null;
  branch: string | undefined;
  resolving: Promise<void> | null;
}

function resolve_project(state: BridgeState): Promise<void> {
  if (state.resolving === null) state.resolving = open_for_cwd(state);
  return state.resolving;
}

async function open_for_cwd(state: BridgeState): Promise<void> {
  try {
    const project = await current_project(process.cwd());
    state.project_id = project.id;
    state.branch = project.repository.branch;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(`could not open the Context project for this folder: ${reason}`);
    const info = await repository(process.cwd()).catch(() => null);
    state.branch = info?.branch;
  }
}

function with_branch(message: RpcMessage, branch: string | undefined): RpcMessage {
  if (branch === undefined || message.method !== "tools/call") return message;
  const name = message.params?.name;
  const args = message.params?.arguments;
  if (typeof name !== "string" || !BRANCH_TOOLS.has(name)) return message;
  if (args === null || typeof args !== "object" || Array.isArray(args)) return message;
  if ("branch" in args) return message;
  return {
    ...message,
    params: { ...message.params, arguments: { ...args, branch } },
  };
}

async function forward(message: RpcMessage, state: BridgeState, client: ClientName): Promise<void> {
  if (message.method === "tools/call") await resolve_project(state);
  const settings = await read_settings();
  let credentials;
  try {
    credentials = await fresh_credentials();
  } catch (error) {
    if (message.method === "tools/call" && message.id !== undefined) {
      write_line({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: "Nemu is not signed in on this machine. Ask the user to run: nemu login" }],
          isError: true,
        },
      });
      return;
    }
    rpc_failure(message.id, error instanceof Error ? error.message : "Not signed in");
    return;
  }

  const headers: Record<string, string> = {
    authorization: `Bearer ${credentials.access_token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "nemu-api-version": API_VERSION,
    "user-agent": `nemu-cli/${VERSION}`,
    "x-nemu-client": client,
  };
  if (settings.device_id !== undefined && settings.device_api_url === credentials.api_url) {
    headers["x-nemu-device"] = settings.device_id;
  }
  if (state.project_id !== null) headers["x-nemu-project"] = state.project_id;

  let response: Response;
  try {
    response = await fetch(`${credentials.api_url}/api/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify(with_branch(message, state.branch)),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    rpc_failure(message.id, `Could not reach ${credentials.api_url}`);
    return;
  }
  if (response.status === 202) return;
  const body: unknown = await response.json().catch(() => null);
  if (body !== null && typeof body === "object" && "jsonrpc" in body) {
    write_line(body);
    return;
  }
  const error = z.object({ error: z.string(), reference: z.string().optional() }).safeParse(body);
  rpc_failure(
    message.id,
    error.success
      ? `${error.data.error}${error.data.reference !== undefined ? ` (reference ${error.data.reference})` : ""}`
      : `Nemu answered with status ${response.status}`,
  );
}

export async function mcp(args: Args): Promise<number> {
  if (args.positional[0] === "config") return mcp_config(args);

  const client = client_from(args);
  const state: BridgeState = { project_id: null, branch: undefined, resolving: null };
  const pending = new Set<Promise<void>>();
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      write_line({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    const parsed = rpc_schema.safeParse(raw);
    if (!parsed.success) {
      if (raw !== null && typeof raw === "object" && "result" in raw) continue;
      write_line({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
      continue;
    }
    const task = forward(parsed.data, state, client)
      .catch((error: unknown) => {
        rpc_failure(parsed.data.id, error instanceof CliError ? error.message : "Bridge error");
      })
      .finally(() => pending.delete(task));
    pending.add(task);
  }
  await Promise.all(pending);
  return 0;
}

const SNIPPETS: Record<string, { where: string; text: string }> = {
  claude: {
    where: "Run in a terminal",
    text: "claude mcp add --scope user nemu -- nemu mcp --client claude-code",
  },
  codex: {
    where: "~/.codex/config.toml",
    text: '[mcp_servers.nemu]\ncommand = "nemu"\nargs = ["mcp", "--client", "codex"]',
  },
  cursor: {
    where: "~/.cursor/mcp.json",
    text: JSON.stringify({ mcpServers: { nemu: { command: "nemu", args: ["mcp", "--client", "cursor"] } } }, null, 2),
  },
  gemini: {
    where: "~/.gemini/settings.json",
    text: JSON.stringify({ mcpServers: { nemu: { command: "nemu", args: ["mcp", "--client", "gemini"] } } }, null, 2),
  },
  vscode: {
    where: "VS Code user mcp.json (MCP: Open User Configuration), or .vscode/mcp.json in a project",
    text: JSON.stringify({ servers: { nemu: { type: "stdio", command: "nemu", args: ["mcp", "--client", "vscode"] } } }, null, 2),
  },
  windsurf: {
    where: "~/.codeium/windsurf/mcp_config.json",
    text: JSON.stringify({ mcpServers: { nemu: { command: "nemu", args: ["mcp", "--client", "windsurf"] } } }, null, 2),
  },
  zed: {
    where: "Zed settings.json",
    text: JSON.stringify({ context_servers: { nemu: { command: "nemu", args: ["mcp", "--client", "zed"] } } }, null, 2),
  },
  opencode: {
    where: "~/.config/opencode/opencode.json",
    text: JSON.stringify(
      { mcp: { nemu: { type: "local", command: ["nemu", "mcp", "--client", "opencode"], enabled: true } } },
      null,
      2,
    ),
  },
  remote: {
    where: "Any client that supports remote MCP over HTTP (create an API key with Context access on the Keys page first)",
    text: JSON.stringify(
      { url: "https://app.nemu.cc/api/mcp", headers: { Authorization: "Bearer <your API key>" } },
      null,
      2,
    ),
  },
};

function mcp_config(args: Args): number {
  const client = (args.positional[1] ?? "").toLowerCase();
  const snippet = SNIPPETS[client === "claude-code" || client === "cc" ? "claude" : client];
  if (snippet === undefined) {
    throw new CliError(
      `Pick a client: ${Object.keys(SNIPPETS).join(", ")}. Example: nemu mcp config cursor`,
      "invalid_client",
    );
  }
  out(`  ${snippet.where}`);
  out();
  out(snippet.text);
  out();
  return 0;
}
