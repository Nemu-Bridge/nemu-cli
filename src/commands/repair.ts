import { update_settings } from "../config.js";
import { run_migrations } from "../migrations.js";
import { emit, is_json_mode } from "../output.js";
import { dim, fail, out, success } from "../ui.js";
import { VERSION } from "../version.js";

export async function repair(): Promise<number> {
  const report = await run_migrations();
  if (report.failed.length === 0) await update_settings({ setup_version: VERSION });
  if (is_json_mode()) {
    emit({ ok: report.failed.length === 0, version: VERSION, ...report });
    return report.failed.length === 0 ? 0 : 1;
  }
  if (report.applied.length === 0 && report.failed.length === 0) {
    out(dim(`  Your setup is up to date for nemu ${VERSION}.`));
    return 0;
  }
  for (const line of report.applied) success(line);
  for (const line of report.failed) fail(`${line} did not finish. Details are in ~/.nemu/hooks.log`);
  return report.failed.length === 0 ? 0 : 1;
}
