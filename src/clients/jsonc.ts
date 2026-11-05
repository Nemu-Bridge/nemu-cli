import { copyFile, mkdir, readFile, rename, stat, writeFile, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { applyEdits, findNodeAtLocation, getNodeValue, modify, parseTree, type ParseError } from "jsonc-parser";
import { CliError } from "../errors.js";

export type EntryChange = "added" | "updated" | "unchanged" | "removed" | "absent";

export const BACKUP_SUFFIX = ".nemu-backup";

export function same_json(left: unknown, right: unknown): boolean {
  const stable = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (value !== null && typeof value === "object") {
      return `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
        .join(",")}}`;
    }
    return JSON.stringify(value) ?? "undefined";
  };
  return stable(left) === stable(right);
}

export interface EntryResult {
  change: EntryChange;
  backup: string | null;
}

async function read_text(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function indentation(text: string): { insertSpaces: boolean; tabSize: number; eol: string } {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const indented = text.split(/\r?\n/).find((line) => /^[ \t]+\S/.test(line));
  if (indented === undefined) return { insertSpaces: true, tabSize: 2, eol };
  if (indented.startsWith("\t")) return { insertSpaces: false, tabSize: 1, eol };
  const width = indented.length - indented.trimStart().length;
  return { insertSpaces: true, tabSize: width === 4 ? 4 : 2, eol };
}

function parse_object(path: string, text: string) {
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0 || tree === undefined || tree.type !== "object") {
    throw new CliError(
      `${path} could not be read safely, so nothing was changed. Fix the file or add Nemu by hand: nemu mcp config`,
      "config_unreadable",
    );
  }
  return tree;
}

async function write_atomic(path: string, text: string, original: string | null): Promise<string | null> {
  await mkdir(dirname(path), { recursive: true });
  const mode = original === null ? 0o600 : (await stat(path)).mode & 0o777;
  const backup = original === null ? null : `${path}${BACKUP_SUFFIX}`;
  if (backup !== null) await copyFile(path, backup);
  const temporary = `${path}.${process.pid}.nemu-tmp`;
  await writeFile(temporary, text, { encoding: "utf-8", mode });
  await chmod(temporary, mode).catch(() => undefined);
  await rename(temporary, path);
  return backup;
}

export async function read_entry(path: string, keys: string[]): Promise<unknown> {
  const text = await read_text(path);
  if (text === null) return undefined;
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0 || tree === undefined) return undefined;
  const node = findNodeAtLocation(tree, keys);
  return node === undefined ? undefined : getNodeValue(node);
}

function line_indent(text: string, offset: number): string {
  const start = text.lastIndexOf("\n", offset - 1) + 1;
  const match = /^[ \t]*/.exec(text.slice(start));
  return match === null ? "" : match[0];
}

function pretty(value: unknown, indent: string, unit: string): string {
  return JSON.stringify(value, null, unit).replaceAll("\n", `\n${indent}`);
}

function splice(text: string, offset: number, length: number, content: string): string {
  return `${text.slice(0, offset)}${content}${text.slice(offset + length)}`;
}

function insert_entry(text: string, keys: string[], value: unknown): string {
  const tree = parse_object("", text);
  const style = indentation(text);
  const unit = style.insertSpaces ? " ".repeat(style.tabSize) : "\t";
  const existing = findNodeAtLocation(tree, keys);
  if (existing !== undefined) {
    const indent = line_indent(text, existing.offset);
    return splice(text, existing.offset, existing.length, pretty(value, indent, unit));
  }
  let depth = keys.length - 1;
  while (depth > 0 && findNodeAtLocation(tree, keys.slice(0, depth))?.type !== "object") depth -= 1;
  const parent = depth === 0 ? tree : findNodeAtLocation(tree, keys.slice(0, depth));
  if (parent === undefined || parent.type !== "object") {
    throw new CliError("The config has an unexpected shape, so nothing was changed.", "config_unreadable");
  }
  const missing = keys.slice(depth);
  const nested = missing.slice(1).reduceRight<unknown>((inner, key) => ({ [key]: inner }), value);
  const parent_indent = line_indent(text, parent.offset);
  const child_indent = `${parent_indent}${unit}`;
  const property = `${JSON.stringify(missing[0])}: ${pretty(nested, child_indent, unit)}`;
  const children = parent.children ?? [];
  const last = children[children.length - 1];
  if (last !== undefined) {
    return splice(text, last.offset + last.length, 0, `,${style.eol}${child_indent}${property}`);
  }
  const inner_start = parent.offset + 1;
  const inner_end = parent.offset + parent.length - 1;
  const inner = text.slice(inner_start, inner_end);
  const content = inner.trim().length === 0
    ? `${style.eol}${child_indent}${property}${style.eol}${parent_indent}`
    : `${inner.replace(/\s+$/, "")}${style.eol}${child_indent}${property}${style.eol}${parent_indent}`;
  return splice(text, inner_start, inner_end - inner_start, content);
}

export async function set_entry(path: string, keys: string[], value: unknown): Promise<EntryResult> {
  const original = await read_text(path);
  const text = original === null || original.trim().length === 0 ? "{}" : original;
  const tree = parse_object(path, text);
  const existing = findNodeAtLocation(tree, keys);
  if (existing !== undefined && same_json(getNodeValue(existing), value)) {
    return { change: "unchanged", backup: null };
  }
  const next = insert_entry(text, keys, value);
  const written = findNodeAtLocation(parse_object(path, next), keys);
  if (written === undefined || !same_json(getNodeValue(written), value)) {
    throw new CliError(`${path} could not be updated safely, so nothing was changed.`, "config_unreadable");
  }
  const backup = await write_atomic(path, next.endsWith("\n") ? next : `${next}\n`, original);
  return { change: existing === undefined ? "added" : "updated", backup };
}

export async function remove_entry(
  path: string,
  keys: string[],
  is_ours: (value: unknown) => boolean,
): Promise<EntryChange> {
  const original = await read_text(path);
  if (original === null) return "absent";
  const tree = parse_object(path, original);
  const existing = findNodeAtLocation(tree, keys);
  if (existing === undefined || !is_ours(getNodeValue(existing))) return "absent";
  let next = applyEdits(original, modify(original, keys, undefined, {}));
  for (let depth = keys.length - 1; depth >= 1; depth -= 1) {
    const parent = findNodeAtLocation(parse_object(path, next), keys.slice(0, depth));
    if (parent === undefined || parent.type !== "object" || (parent.children ?? []).length > 0) break;
    next = applyEdits(next, modify(next, keys.slice(0, depth), undefined, {}));
  }
  parse_object(path, next);
  await write_atomic(path, next, original);
  return "removed";
}
