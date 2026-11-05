import type { Args } from "../args.js";
import { remove_hooks } from "../clients/hooks.js";
import { CLIENTS, client_from_name, client_installed, type ClientSpec } from "../clients/registry.js";
import { CliError } from "../errors.js";
import { EDITORS, editor_from_name, remove_from_editor, type EditorSpec } from "../clients/editors.js";
import { dim, out, success } from "../ui.js";
import { emit, is_json_mode } from "../output.js";

async function remove_from(spec: ClientSpec) {
  const installed = await client_installed(spec);
  const mcp = installed ? await spec.remove_mcp() : false;
  const hooks = await remove_hooks(spec.hooks_path());
  return { client: spec.id, mcp_removed: mcp, hooks_removed: hooks };
}

async function remove_editor(editor: EditorSpec) {
  return { client: editor.id, label: editor.label, mcp_removed: await remove_from_editor(editor) };
}

export async function uninstall(args: Args): Promise<number> {
  const target = args.positional[0] ?? "all";
  const editor = target === "all" ? null : editor_from_name(target);
  const specs = target === "all" ? Object.values(CLIENTS) : editor !== null ? [] : [client_from_name(target)];
  const editors = target === "all" ? Object.values(EDITORS) : editor !== null ? [editor] : [];
  if (specs.length === 0 && editors.length === 0) throw new CliError("Nothing to uninstall.", "invalid_arguments");

  const results = [];
  for (const spec of specs) results.push(await remove_from(spec));
  const editor_results = [];
  for (const item of editors) editor_results.push(await remove_editor(item));

  if (is_json_mode()) {
    emit({ ok: true, results, editors: editor_results });
    return 0;
  }
  for (const result of editor_results) {
    if (!result.mcp_removed) {
      if (target !== "all") out(dim(`  ${result.label}: nothing from Nemu was installed`));
      continue;
    }
    success(`${result.label}: removed the MCP server`);
  }
  for (const result of results) {
    const label = CLIENTS[result.client].label;
    if (!result.mcp_removed && !result.hooks_removed) {
      out(dim(`  ${label}: nothing from Nemu was installed`));
      continue;
    }
    success(`${label}: removed${result.mcp_removed ? " the MCP server" : ""}${result.mcp_removed && result.hooks_removed ? " and" : ""}${result.hooks_removed ? " the hooks" : ""}`);
  }
  out(dim("  Your saved Context stays in your Nemu account. Sign out with nemu logout."));
  return 0;
}
