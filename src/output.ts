import { bold, dim, out } from "./ui.js";

let json_mode = false;

export function set_json_mode(enabled: boolean): void {
  json_mode = enabled;
}

export function is_json_mode(): boolean {
  return json_mode;
}

export function emit(value: unknown): void {
  out(JSON.stringify(value, null, 2));
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function table(
  rows: readonly Record<string, unknown>[],
  columns: readonly string[],
  empty = "Nothing to show.",
): void {
  if (json_mode) {
    emit(rows);
    return;
  }

  if (rows.length === 0) {
    out(dim(`  ${empty}`));
    return;
  }

  const header = columns.map((column) => column.toUpperCase());
  const body = rows.map((row) => columns.map((column) => cell(row[column])));
  const widths = header.map((label, index) =>
    Math.max(
      label.length,
      ...body.map((cells) => (cells[index] ?? "").length),
      0,
    ),
  );

  const render = (cells: string[]) =>
    cells
      .map((value, index) => value.padEnd(widths[index] ?? 0))
      .join("  ")
      .trimEnd();

  out(`  ${dim(render(header))}`);
  for (const cells of body) out(`  ${render(cells)}`);
  out(dim(`  ${rows.length} row${rows.length === 1 ? "" : "s"}`));
}

export function detail(
  record: Record<string, unknown>,
  title?: string,
): void {
  if (json_mode) {
    emit(record);
    return;
  }

  if (title !== undefined) {
    out();
    out(`  ${bold(title)}`);
  }
  const keys = Object.keys(record);
  const width = Math.max(...keys.map((key) => key.length), 0);
  for (const key of keys) {
    out(`  ${dim(key.padEnd(width))}  ${cell(record[key])}`);
  }
  out();
}

export function done(message: string, payload?: Record<string, unknown>): void {
  if (json_mode) {
    emit({ ok: true, message, ...(payload ?? {}) });
    return;
  }
  out(`  ${message}`);
}
