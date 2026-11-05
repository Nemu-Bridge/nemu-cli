import {
  ALL_SCOPES,
  SCOPE_ACTIONS,
  type QuotaPeriod,
  type QuotaRuleType,
} from "@nemu-ai/sdk";
import {
  bool_flag,
  flag,
  number_flag,
  require_positional,
  type Args,
} from "../args.js";
import { client } from "../session.js";
import { detail, done, emit, is_json_mode, table } from "../output.js";
import { api_url, API_VERSION } from "../config.js";
import { out } from "../ui.js";

export async function user(): Promise<number> {
  const nemu = await client();
  const account = await nemu.user.get();
  detail({ ...account }, "Account");
  return 0;
}

export async function health(): Promise<number> {
  const nemu = await client();
  const status = await nemu.health.check();
  detail({ ...status }, "Health");
  return 0;
}

export async function version_info(): Promise<number> {
  const nemu = await client();
  const info = await nemu.version();
  detail({ ...info }, "API version");
  return 0;
}

export function scopes(): number {
  if (is_json_mode()) {
    emit({ scopes: ALL_SCOPES, resources: SCOPE_ACTIONS });
    return 0;
  }
  table(
    Object.entries(SCOPE_ACTIONS).map(([resource, actions]) => ({
      resource,
      actions: (actions as readonly string[]).join(" "),
    })),
    ["resource", "actions"],
  );
  return 0;
}

export async function indexes(args: Args): Promise<number> {
  const action = args.positional[0] ?? "list";
  const nemu = await client();

  if (action === "list") {
    const rows = await nemu.indexes.list();
    table(
      rows.map((row) => ({ ...row })),
      ["id", "base_url", "title", "page_count", "status", "created_at"],
      "No indexes.",
    );
    return 0;
  }

  if (action === "get") {
    const index = await nemu.indexes.get(
      require_positional(args, 1, "index id"),
    );
    detail({ ...index }, index.title ?? index.base_url);
    return 0;
  }

  if (action === "create") {
    const url = flag(args, "url") ?? require_positional(args, 1, "url");
    const created = await nemu.indexes.create({
      url,
      title: flag(args, "title"),
      max_pages: number_flag(args, "max-pages"),
    });
    done(`Indexing ${url}`, { ...created });
    return 0;
  }

  if (action === "delete") {
    const id = require_positional(args, 1, "index id");
    if (!bool_flag(args, "yes", "y")) {
      throw new Error("Pass --yes to confirm deleting an index.");
    }
    await nemu.indexes.delete(id);
    done(`Deleted index ${id}`);
    return 0;
  }

  throw new Error(`Unknown indexes action "${action}".`);
}

export async function quotas(args: Args): Promise<number> {
  const action = args.positional[0] ?? "list";
  const nemu = await client();

  if (action === "list") {
    const rows = await nemu.quotas.list();
    table(
      rows.map((row) => ({ ...row })),
      ["id", "name", "type", "limit", "period", "model_id", "enabled"],
      "No quota rules.",
    );
    return 0;
  }

  if (action === "get") {
    const quota = await nemu.quotas.get(require_positional(args, 1, "quota id"));
    detail({ ...quota }, quota.name);
    return 0;
  }

  if (action === "update") {
    const id = require_positional(args, 1, "quota id");
    if (id.startsWith("system_")) {
      throw new Error(
        "System quotas come from your plan and cannot be edited here.",
      );
    }
    const quota = await nemu.quotas.get(id);
    const period = flag(args, "period");
    if (quota.model_id === null) {
      throw new Error("This quota rule has no model and cannot be updated.");
    }
    await quota.update({
      name: flag(args, "name") ?? quota.name,
      type: quota.type as QuotaRuleType,
      model_id: flag(args, "model", "model-id") ?? quota.model_id,
      limit: number_flag(args, "limit") ?? quota.limit,
      ...(period !== undefined ? { period: period as QuotaPeriod } : {}),
      ...(args.flags.enabled !== undefined
        ? { enabled: args.flags.enabled !== "false" }
        : {}),
    });
    done(`Updated quota ${quota.id}`, { ...quota });
    return 0;
  }

  if (action === "delete") {
    const quota = await nemu.quotas.get(require_positional(args, 1, "quota id"));
    if (!bool_flag(args, "yes", "y")) {
      throw new Error("Pass --yes to confirm deleting a quota rule.");
    }
    await quota.delete();
    done(`Deleted quota ${quota.id}`);
    return 0;
  }

  throw new Error(
    `Unknown quotas action "${action}". The API cannot create quota rules, only read, update and delete them.`,
  );
}

export async function metrics(args: Args): Promise<number> {
  const action = args.positional[0] ?? "list";
  const nemu = await client();

  if (action === "list") {
    const response = await nemu.metrics.list({
      page: number_flag(args, "page"),
      limit: number_flag(args, "limit"),
      key_id: flag(args, "key", "key-id"),
      start_date: flag(args, "start", "start-date"),
      end_date: flag(args, "end", "end-date"),
    });
    const rows = response.data ?? [];
    table(
      rows.map((row) => ({ ...row }) as Record<string, unknown>),
      [
        "id",
        "model",
        "status",
        "total_tokens",
        "cost",
        "latency_ms",
        "created_at",
      ],
      "No requests recorded.",
    );
    if (!is_json_mode() && response.pagination) {
      const { page, pages, total } = response.pagination;
      out(`  page ${page} of ${pages}, ${total} total`);
    }
    return 0;
  }

  if (action === "get") {
    const metric = await nemu.metrics.get(
      require_positional(args, 1, "request id"),
    );
    detail({ ...metric }, "Request");
    return 0;
  }

  throw new Error(`Unknown metrics action "${action}".`);
}

export async function raw_api(args: Args): Promise<number> {
  const method = (
    args.positional[0] ?? require_positional(args, 0, "method")
  ).toUpperCase();
  const path = require_positional(args, 1, "path");
  const body = flag(args, "data", "d");

  const { read_credentials } = await import("../config.js");
  const credentials = await read_credentials();
  if (credentials === null) throw new Error("Not signed in. Run nemu login.");

  const base = (credentials.api_url ?? api_url()).replace(/\/+$/, "");
  const url = path.startsWith("http")
    ? path
    : `${base}${path.startsWith("/") ? "" : "/"}${path}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${credentials.access_token}`,
        "content-type": "application/json",
        "Nemu-Api-Version": API_VERSION,
      },
      body: body === undefined ? undefined : body,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${method} ${url} could not be reached: ${reason}`);
  }

  const text = await response.text();
  try {
    emit(JSON.parse(text));
  } catch {
    out(text);
  }
  return response.ok ? 0 : 1;
}
