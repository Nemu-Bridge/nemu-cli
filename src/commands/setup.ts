import { bool_flag, parse_args, type Args } from "../args.js";
import { has_scope, read_credentials } from "../config.js";
import { CliError } from "../errors.js";
import { ensure_device } from "../device.js";
import { run, which } from "../system.js";
import { VERSION } from "../version.js";
import { bold, confirm, dim, is_interactive, out, success } from "../ui.js";
import { emit, is_json_mode } from "../output.js";
import { install_hooks } from "../clients/hooks.js";
import { client_from_name, client_installed, type ClientSpec } from "../clients/registry.js";
import { editor_from_name, require_editor, type EditorSpec } from "../clients/editors.js";
import { login } from "./login.js";

function newer_or_equal(found: string, wanted: string): boolean {
  const parse = (value: string) => value.split(/[.-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  const [a, b] = [parse(found), parse(wanted)];
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0);
  }
  return true;
}

export async function resolve_nemu_binary(interactive_install: boolean): Promise<string> {
  const forced = process.env.NEMU_BIN;
  if (forced !== undefined && forced.length > 0) return forced;

  const found = await which("nemu");
  if (found !== null) {
    const version = (await run(found, ["--version"], { timeout_ms: 15_000 })).stdout.trim();
    if (newer_or_equal(version, VERSION)) return found;
  }

  const verb = found === null ? "install" : "update";
  const accepted =
    interactive_install &&
    (await confirm(
      `Your agents start nemu on every session, so it needs a global install. ${verb === "install" ? "Install" : "Update"} it now with npm i -g nemu-cli@${VERSION}?`,
      true,
    ));
  if (!accepted) {
    throw new CliError(
      `Install the CLI globally first: npm i -g nemu-cli@${VERSION} (or bun add -g nemu-cli@${VERSION})`,
      "global_install_required",
    );
  }
  const result = await run("npm", ["install", "-g", `nemu-cli@${VERSION}`], { timeout_ms: 180_000 });
  if (result.code !== 0) {
    throw new CliError(
      `npm could not install nemu-cli. Run it yourself: npm i -g nemu-cli@${VERSION}`,
      "global_install_failed",
    );
  }
  const installed = await which("nemu");
  if (installed === null) {
    throw new CliError("nemu was installed but is not on your PATH. Open a new terminal and run setup again.", "global_install_path");
  }
  return installed;
}

async function ensure_signed_in(): Promise<void> {
  const credentials = await read_credentials();
  const ready = credentials !== null && has_scope(credentials, "context:write");
  if (ready) return;
  if (!is_interactive()) {
    throw new CliError(
      credentials === null
        ? "Not signed in. Run nemu login first."
        : "Your sign in predates Context. Run nemu login --force once.",
      "not_signed_in",
    );
  }
  if (credentials !== null) out(dim("  Your sign in needs the new Context permission. Signing in again."));
  const code = await login(parse_args(credentials === null ? [] : ["--force"]));
  if (code !== 0) throw new CliError("Sign in did not finish.", "not_signed_in");
}

async function choose_hooks(args: Args, spec: ClientSpec): Promise<boolean> {
  if (bool_flag(args, "no-hooks")) return false;
  if (bool_flag(args, "hooks") || bool_flag(args, "yes", "y")) return true;
  if (!is_interactive()) return false;
  out();
  out(`  Hooks let ${spec.label} load this project's notes when a session starts and`);
  out("  ask the agent to save a handoff before it stops, without you asking.");
  return confirm("Install the Nemu hooks too?", true);
}

export interface SetupResult {
  client: string;
  hooks: boolean;
  nemu: string;
  device_id: string;
}

export async function run_setup(spec: ClientSpec, args: Args): Promise<SetupResult> {
  if (!(await client_installed(spec))) {
    throw new CliError(`${spec.label} is not installed. ${spec.install_hint}`, "client_missing");
  }
  await ensure_signed_in();
  const device_id = await ensure_device(bool_flag(args, "new-device"));
  const nemu = await resolve_nemu_binary(is_interactive() && !bool_flag(args, "no-install"));
  await spec.add_mcp(nemu);
  const hooks = await choose_hooks(args, spec);
  if (hooks) await install_hooks(spec.hooks_path(), nemu, spec.id);
  return { client: spec.id, hooks, nemu, device_id };
}

async function setup_editor(editor: EditorSpec, args: Args): Promise<number> {
  await require_editor(editor);
  await ensure_signed_in();
  const device_id = await ensure_device(bool_flag(args, "new-device"));
  const nemu = await resolve_nemu_binary(is_interactive() && !bool_flag(args, "no-install"));
  const { change, backup } = await editor.add(nemu);
  if (is_json_mode()) {
    emit({ ok: true, client: editor.id, change, config: editor.config_path(), backup, nemu, device_id });
    return 0;
  }
  out();
  success(`${editor.label} is connected to Nemu Context`);
  out(
    dim(
      change === "unchanged"
        ? `  The nemu server was already in ${editor.config_path()}`
        : `  MCP server "nemu" ${change === "added" ? "added to" : "updated in"} ${editor.config_path()}`,
    ),
  );
  if (backup !== null) out(dim(`  The file as it was before is saved at ${backup}`));
  for (const line of editor.after_setup) out(`  ${line}`);
  if (bool_flag(args, "hooks")) out(dim(`  Hooks are only available for Claude Code and Codex.`));
  out(dim(`  Check it any time with: ${bold("nemu status")}`));
  return 0;
}

export async function setup(args: Args): Promise<number> {
  const editor = editor_from_name(args.positional[0]);
  if (editor !== null) return setup_editor(editor, args);
  const spec = client_from_name(args.positional[0]);
  const result = await run_setup(spec, args);
  if (is_json_mode()) {
    emit({ ok: true, ...result });
    return 0;
  }
  out();
  success(`${spec.label} is connected to Nemu Context`);
  out(dim(`  MCP server "nemu" registered${result.hooks ? `, hooks added to ${spec.hooks_path()}` : ", no hooks"}`));
  for (const line of spec.after_setup) out(`  ${line}`);
  if (!result.hooks) out(dim(`  Add hooks later with: nemu setup ${spec.binary} --hooks`));
  out(dim(`  Check it any time with: ${bold("nemu status")}`));
  return 0;
}
