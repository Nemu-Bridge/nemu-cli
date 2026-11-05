import { has_scope, read_credentials, read_settings, api_url } from "../config.js";
import { installed_hooks, needs_repair, HOOK_SPECS } from "../clients/hooks.js";
import { CLIENTS, client_installed } from "../clients/registry.js";
import { EDITORS, editor_has_nemu } from "../clients/editors.js";
import { run, which } from "../system.js";
import { VERSION } from "../version.js";
import { device_state, type DeviceState } from "../device.js";
import { error_code } from "../errors.js";
import { bold, dim, green, out, red } from "../ui.js";
import { emit, is_json_mode } from "../output.js";

type DeviceCheck =
  | { checked: true; result: DeviceState }
  | { checked: false; code: string; message: string };

function mark(ok: boolean): string {
  return ok ? green("ok") : red("no");
}

async function check_device(): Promise<DeviceCheck> {
  try {
    return { checked: true, result: await device_state() };
  } catch (error) {
    return {
      checked: false,
      code: error_code(error),
      message: error instanceof Error ? error.message : "Unexpected error.",
    };
  }
}

function device_line(device_id: string | null, check: DeviceCheck | null): string {
  const local = device_id ?? red("not registered");
  if (check === null) return local;
  if (!check.checked) {
    return check.code === "not_signed_in" ? local : `${local}${dim(`  could not check: ${check.message}`)}`;
  }
  const fix = dim("  run nemu login --force");
  switch (check.result.state) {
    case "active":
      return check.result.id;
    case "revoked":
      return `${check.result.id}  ${red("revoked")}${fix}`;
    case "unknown":
      return `${check.result.id}  ${red("not known to Nemu")}${fix}`;
    default:
      return `${red("not registered")}${fix}`;
  }
}

export async function status(): Promise<number> {
  const credentials = await read_credentials();
  const settings = await read_settings();
  const global = await which("nemu");
  const global_version =
    global === null ? null : (await run(global, ["--version"], { timeout_ms: 15_000 })).stdout.trim() || null;

  const clients = await Promise.all(
    Object.values(CLIENTS).map(async (spec) => {
      const installed = await client_installed(spec);
      const mcp = installed ? await spec.has_mcp() : false;
      const hooks = installed ? await installed_hooks(spec.hooks_path()) : [];
      return {
        id: spec.id,
        label: spec.label,
        installed,
        mcp,
        hooks,
        hooks_complete: hooks.length === HOOK_SPECS[spec.id].length,
        hooks_need_repair: spec.id === "codex" && installed ? await needs_repair(spec.hooks_path()) : false,
        hooks_path: spec.hooks_path(),
      };
    }),
  );

  const editors = await Promise.all(
    Object.values(EDITORS).map(async (editor) => {
      const installed = await editor.detect();
      return {
        id: editor.id,
        label: editor.label,
        installed,
        mcp: installed ? await editor_has_nemu(editor) : false,
        config: editor.config_path(),
      };
    }),
  );

  const context_access = credentials !== null && has_scope(credentials, "context:write");
  const check = context_access && credentials.kind !== "key" ? await check_device() : null;
  const is_session_expired = check !== null && !check.checked && check.code === "not_signed_in";

  const report = {
    version: VERSION,
    api_url: credentials?.api_url ?? api_url(),
    signed_in: credentials !== null && !is_session_expired,
    account: credentials?.account ?? null,
    context_access,
    device_id: settings.device_id ?? null,
    device_state: check === null ? null : check.checked ? check.result.state : "unchecked",
    device_check_error: check !== null && !check.checked ? check.message : null,
    reports: settings.reports,
    global_install: global,
    global_version,
    clients,
    editors,
  };

  if (is_json_mode()) {
    emit(report);
    return 0;
  }

  out();
  out(`  ${bold("nemu")} ${dim(VERSION)}  ${dim(report.api_url)}`);
  out(`  Signed in        ${is_session_expired ? red("expired") : mark(report.signed_in)}${report.account !== null ? `  ${report.account}` : ""}${is_session_expired ? dim("  run nemu login") : ""}`);
  out(`  Context access   ${mark(report.context_access)}${report.signed_in && !report.context_access ? dim("  run nemu login --force") : ""}`);
  out(`  This device      ${device_line(report.device_id, check)}`);
  out(`  Global install   ${mark(global !== null)}${global !== null ? dim(`  ${global} ${global_version ?? ""}`) : dim("  npm i -g nemu-cli")}`);
  out(`  Error reports    ${report.reports ? "on" : "off"}`);
  for (const client of clients) {
    out();
    out(`  ${bold(client.label)}${client.installed ? "" : dim("  not installed")}`);
    if (!client.installed) continue;
    out(`    MCP server     ${mark(client.mcp)}${client.mcp ? "" : dim(`  nemu setup ${client.id === "codex" ? "codex" : "claude"}`)}`);
    out(`    Hooks          ${client.hooks.length === 0 ? dim("none") : client.hooks_complete ? green("all") : `${client.hooks.join(", ")}`}`);
    if (client.hooks_need_repair) out(`    ${red("Hooks cannot start on Windows.")} ${dim("Repair with: nemu setup codex --hooks")}`);
  }
  const found = editors.filter((editor) => editor.installed);
  if (found.length > 0) {
    out();
    out(`  ${bold("Editors")}`);
    for (const editor of found) {
      out(`    ${editor.label.padEnd(15)}${mark(editor.mcp)}${editor.mcp ? "" : dim(`  nemu setup ${editor.id}`)}`);
    }
  }
  out();
  return 0;
}
