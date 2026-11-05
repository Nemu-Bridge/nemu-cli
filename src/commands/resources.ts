import type {
  ModelType,
  PromptType,
  ProviderCompatibility,
  ProviderSource,
  PromptEnvironment,
} from "@nemu-ai/sdk";
import {
  bool_flag,
  flag,
  number_flag,
  require_positional,
  type Args,
} from "../args.js";
import { client, resolve_workspace } from "../session.js";
import { detail, done, table } from "../output.js";

function optional_bool(args: Args, name: string): boolean | undefined {
  const raw = flag(args, name);
  if (raw === undefined) {
    return args.flags[name] === true ? true : undefined;
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`--${name} must be true or false, got "${raw}"`);
}

function strip_undefined<T extends Record<string, unknown>>(value: T): T {
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) result[key] = entry;
  }
  return result as T;
}

const PROVIDER_COLUMNS = [
  "id",
  "name",
  "compatibility",
  "priority",
  "base_url",
  "enabled",
];

export async function providers(args: Args): Promise<number> {
  const action = args.positional[0] ?? "list";
  const nemu = await client();
  const workspace = await resolve_workspace(nemu, flag(args, "workspace", "w"));

  if (action === "list") {
    const rows = await workspace.providers.list(
      strip_undefined({
        name: flag(args, "name"),
        compatibility: flag(args, "compatibility") as
          | ProviderCompatibility
          | undefined,
      }),
    );
    table(rows.map((row) => ({ ...row })), PROVIDER_COLUMNS, "No providers.");
    return 0;
  }

  if (action === "get") {
    const provider = await workspace.providers.get(
      require_positional(args, 1, "provider id"),
    );
    detail({ ...provider }, provider.name);
    return 0;
  }

  if (action === "create") {
    const name = flag(args, "name") ?? require_positional(args, 1, "name");
    const provider = await workspace.providers.create(
      strip_undefined({
        name,
        priority: number_flag(args, "priority") ?? 1,
        base_url: flag(args, "base-url"),
        api_key: flag(args, "api-key"),
        compatibility: flag(args, "compatibility") as
          | ProviderCompatibility
          | undefined,
        models_dev_id: flag(args, "models-dev-id"),
        user_agent: flag(args, "user-agent"),
        source: flag(args, "source") as ProviderSource | undefined,
      }),
    );
    done(`Created provider ${provider.name}`, { ...provider });
    return 0;
  }

  if (action === "update") {
    const provider = await workspace.providers.get(
      require_positional(args, 1, "provider id"),
    );
    await provider.update(
      strip_undefined({
        name: flag(args, "name") ?? provider.name,
        priority: number_flag(args, "priority") ?? provider.priority,
        base_url: flag(args, "base-url") ?? provider.base_url ?? undefined,
        api_key: flag(args, "api-key"),
        compatibility:
          (flag(args, "compatibility") as ProviderCompatibility | undefined) ??
          provider.compatibility,
        user_agent: flag(args, "user-agent"),
        enabled: optional_bool(args, "enabled"),
      }),
    );
    done(`Updated provider ${provider.id}`, { ...provider });
    return 0;
  }

  if (action === "delete") {
    const provider = await workspace.providers.get(
      require_positional(args, 1, "provider id"),
    );
    if (!bool_flag(args, "yes", "y")) {
      throw new Error("Pass --yes to confirm deleting a provider.");
    }
    await provider.delete();
    done(`Deleted provider ${provider.id}`);
    return 0;
  }

  throw new Error(`Unknown providers action "${action}".`);
}

const MODEL_COLUMNS = [
  "id",
  "name",
  "display_name",
  "type",
  "provider_id",
  "input_cost",
  "output_cost",
  "context_window",
  "enabled",
];

export async function models(args: Args): Promise<number> {
  const action = args.positional[0] ?? "list";
  const nemu = await client();
  const workspace = await resolve_workspace(nemu, flag(args, "workspace", "w"));

  if (action === "list") {
    const rows = await workspace.models.list(
      strip_undefined({
        type: flag(args, "type") as ModelType | undefined,
        provider_id: flag(args, "provider", "provider-id"),
        name: flag(args, "name"),
      }),
    );
    table(rows.map((row) => ({ ...row })), MODEL_COLUMNS, "No models.");
    return 0;
  }

  if (action === "get") {
    const model = await workspace.models.get(
      require_positional(args, 1, "model id"),
    );
    detail({ ...model }, model.display_name ?? model.name);
    return 0;
  }

  if (action === "create") {
    const model_name = flag(args, "name") ?? require_positional(args, 1, "name");
    const provider_id = flag(args, "provider", "provider-id");
    if (provider_id === undefined) {
      throw new Error("--provider <id> is required. Run: nemu providers list");
    }
    const model = await workspace.models.create(
      strip_undefined({
        name: model_name,
        display_name: flag(args, "display-name") ?? model_name,
        api_name: flag(args, "api-name"),
        provider_id,
        type: (flag(args, "type") ?? "chat") as ModelType,
        input_cost: number_flag(args, "input-cost") ?? 0,
        output_cost: number_flag(args, "output-cost") ?? 0,
        context_window: number_flag(args, "context-window") ?? 8192,
        cache_read_cost: number_flag(args, "cache-read-cost"),
        cache_write_cost: number_flag(args, "cache-write-cost"),
        max_output: number_flag(args, "max-output"),
        per_image_cost: number_flag(args, "per-image-cost"),
        per_minute_cost: number_flag(args, "per-minute-cost"),
        supports_vision: optional_bool(args, "supports-vision"),
        supports_audio_input: optional_bool(args, "supports-audio-input"),
        supports_audio_output: optional_bool(args, "supports-audio-output"),
        max_images_per_request: number_flag(args, "max-images-per-request"),
      }),
    );
    done(`Created model ${model.name}`, { ...model });
    return 0;
  }

  if (action === "update") {
    const model = await workspace.models.get(
      require_positional(args, 1, "model id"),
    );
    await model.update(
      strip_undefined({
        name: model.name,
        provider_id: model.provider_id,
        type: model.type as ModelType,
        display_name:
          flag(args, "display-name") ?? model.display_name ?? model.name,
        api_name: flag(args, "api-name") ?? model.api_name ?? undefined,
        input_cost: number_flag(args, "input-cost") ?? model.input_cost ?? 0,
        output_cost:
          number_flag(args, "output-cost") ?? model.output_cost ?? 0,
        context_window:
          number_flag(args, "context-window") ?? model.context_window ?? 8192,
        cache_read_cost: number_flag(args, "cache-read-cost"),
        cache_write_cost: number_flag(args, "cache-write-cost"),
        max_output: number_flag(args, "max-output"),
        enabled: optional_bool(args, "enabled"),
      }),
    );
    done(`Updated model ${model.id}`, { ...model });
    return 0;
  }

  if (action === "delete") {
    const model = await workspace.models.get(
      require_positional(args, 1, "model id"),
    );
    if (!bool_flag(args, "yes", "y")) {
      throw new Error("Pass --yes to confirm deleting a model.");
    }
    await model.delete();
    done(`Deleted model ${model.id}`);
    return 0;
  }

  throw new Error(`Unknown models action "${action}".`);
}

const PROMPT_COLUMNS = [
  "id",
  "name",
  "type",
  "environment",
  "position",
  "is_global",
  "enabled",
];

export async function prompts(args: Args): Promise<number> {
  const action = args.positional[0] ?? "list";
  const nemu = await client();
  const workspace = await resolve_workspace(nemu, flag(args, "workspace", "w"));

  if (action === "list") {
    const rows = await workspace.prompts.list(
      strip_undefined({
        name: flag(args, "name"),
        type: flag(args, "type") as PromptType | undefined,
        environment: flag(args, "environment") as PromptEnvironment | undefined,
      }),
    );
    table(rows.map((row) => ({ ...row })), PROMPT_COLUMNS, "No prompts.");
    return 0;
  }

  if (action === "get") {
    const prompt = await workspace.prompts.get(
      require_positional(args, 1, "prompt id"),
    );
    detail({ ...prompt }, prompt.name);
    return 0;
  }

  if (action === "create") {
    const prompt = await workspace.prompts.create(
      strip_undefined({
        name: flag(args, "name") ?? require_positional(args, 1, "name"),
        content: flag(args, "content") ?? require_positional(args, 2, "content"),
        type: flag(args, "type") as PromptType | undefined,
        model_id: flag(args, "model", "model-id"),
        is_global: optional_bool(args, "global"),
        enabled: optional_bool(args, "enabled"),
        position: number_flag(args, "position"),
        environment: flag(args, "environment") as PromptEnvironment | undefined,
      }),
    );
    done(`Created prompt ${prompt.name}`, { ...prompt });
    return 0;
  }

  if (action === "update") {
    const prompt = await workspace.prompts.get(
      require_positional(args, 1, "prompt id"),
    );
    await prompt.update(
      strip_undefined({
        name: flag(args, "name") ?? prompt.name,
        content: flag(args, "content") ?? prompt.content,
        type: (flag(args, "type") as PromptType | undefined) ?? prompt.type,
        position: number_flag(args, "position") ?? prompt.position,
        environment: flag(args, "environment") as PromptEnvironment | undefined,
        enabled: optional_bool(args, "enabled"),
        is_global: optional_bool(args, "global"),
      }),
    );
    done(`Updated prompt ${prompt.id}`, { ...prompt });
    return 0;
  }

  if (action === "delete") {
    const prompt = await workspace.prompts.get(
      require_positional(args, 1, "prompt id"),
    );
    if (!bool_flag(args, "yes", "y")) {
      throw new Error("Pass --yes to confirm deleting a prompt.");
    }
    await prompt.delete();
    done(`Deleted prompt ${prompt.id}`);
    return 0;
  }

  throw new Error(`Unknown prompts action "${action}".`);
}

const MAPPING_COLUMNS = [
  "id",
  "source_name",
  "target_model",
  "priority",
  "is_pattern",
  "enabled",
];

export async function mappings(args: Args): Promise<number> {
  const action = args.positional[0] ?? "list";
  const nemu = await client();
  const workspace = await resolve_workspace(nemu, flag(args, "workspace", "w"));

  if (action === "list") {
    const rows = await workspace.mappings.list(
      strip_undefined({
        source_name: flag(args, "source", "source-name"),
        target_model: flag(args, "target", "target-model"),
      }),
    );
    table(rows.map((row) => ({ ...row })), MAPPING_COLUMNS, "No mappings.");
    return 0;
  }

  if (action === "get") {
    const mapping = await workspace.mappings.get(
      require_positional(args, 1, "mapping id"),
    );
    detail({ ...mapping }, mapping.source_name);
    return 0;
  }

  if (action === "create") {
    const mapping = await workspace.mappings.create(
      strip_undefined({
        source_name:
          flag(args, "source", "source-name") ??
          require_positional(args, 1, "source name"),
        target_model:
          flag(args, "target", "target-model") ??
          require_positional(args, 2, "target model"),
        priority: number_flag(args, "priority"),
        enabled: optional_bool(args, "enabled"),
        is_pattern: optional_bool(args, "pattern"),
      }),
    );
    done(`Created mapping ${mapping.source_name}`, { ...mapping });
    return 0;
  }

  if (action === "update") {
    const mapping = await workspace.mappings.get(
      require_positional(args, 1, "mapping id"),
    );
    await mapping.update(
      strip_undefined({
        source_name:
          flag(args, "source", "source-name") ?? mapping.source_name,
        target_model:
          flag(args, "target", "target-model") ?? mapping.target_model,
        priority: number_flag(args, "priority") ?? mapping.priority,
        enabled: optional_bool(args, "enabled"),
        is_pattern: optional_bool(args, "pattern"),
      }),
    );
    done(`Updated mapping ${mapping.id}`, { ...mapping });
    return 0;
  }

  if (action === "delete") {
    const mapping = await workspace.mappings.get(
      require_positional(args, 1, "mapping id"),
    );
    if (!bool_flag(args, "yes", "y")) {
      throw new Error("Pass --yes to confirm deleting a mapping.");
    }
    await mapping.delete();
    done(`Deleted mapping ${mapping.id}`);
    return 0;
  }

  throw new Error(`Unknown mappings action "${action}".`);
}

export async function workflows(args: Args): Promise<number> {
  const action = args.positional[0] ?? "list";
  const nemu = await client();
  const workspace = await resolve_workspace(nemu, flag(args, "workspace", "w"));

  if (action === "list") {
    const rows = await workspace.workflows.list(
      strip_undefined({ name: flag(args, "name") }),
    );
    table(
      rows.map((row) => ({ ...row })),
      ["id", "name", "enabled", "created_at"],
      "No workflows.",
    );
    return 0;
  }

  if (action === "get") {
    const workflow = await workspace.workflows.get(
      require_positional(args, 1, "workflow id"),
    );
    detail({ ...workflow }, workflow.name);
    return 0;
  }

  throw new Error(
    `Workflows are read only through the API. Known actions: list, get.`,
  );
}
