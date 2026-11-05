import type { Args } from "../args.js";
import { read_settings, update_settings } from "../config.js";
import { CliError } from "../errors.js";
import { emit, is_json_mode } from "../output.js";
import { out, success } from "../ui.js";

export async function config_command(args: Args): Promise<number> {
  const [action, key, value] = args.positional;
  if (action === undefined || action === "get") {
    const settings = await read_settings();
    if (is_json_mode()) {
      emit(settings);
      return 0;
    }
    out(`  reports  ${settings.reports ? "on" : "off"}`);
    out(`  device   ${settings.device_id ?? "not registered"}`);
    return 0;
  }
  if (action === "set" && key === "reports" && (value === "on" || value === "off")) {
    await update_settings({ reports: value === "on" });
    success(`Error reports are ${value}`);
    return 0;
  }
  throw new CliError("Use: nemu config get | nemu config set reports on|off", "invalid_arguments");
}
