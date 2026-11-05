import type { Args } from "../args.js";
import { client_from_name } from "../clients/registry.js";
import { launch } from "../system.js";
import { out, dim } from "../ui.js";
import { load } from "./load.js";
import { resolve_nemu_binary, run_setup } from "./setup.js";
import { install_hooks, needs_repair } from "../clients/hooks.js";

export function client_command(name: "claude" | "codex") {
  return async (args: Args): Promise<number> => {
    const spec = client_from_name(name);
    if (args.positional[0] === "load") return load(spec, args);
    if (args.positional[0] === "setup") return run_setup(spec, args).then(() => 0);

    if (!(await spec.has_mcp())) {
      out(dim(`  Connecting ${spec.label} to Nemu Context first.`));
      await run_setup(spec, args);
    } else if (spec.id === "codex" && (await needs_repair(spec.hooks_path()))) {
      const nemu = await resolve_nemu_binary(false).catch(() => null);
      if (nemu !== null) {
        await install_hooks(spec.hooks_path(), nemu, spec.id);
        out(dim("  Repaired the Nemu hooks so Codex on Windows can run them."));
      }
    }
    return launch(spec.binary, args.positional);
  };
}
