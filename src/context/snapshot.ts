import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { redact } from "./redact.js";

const SKIPPED = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "out",
  "coverage",
  "target",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
  ".turbo",
  ".cache",
  ".idea",
  ".vscode",
]);

const KEY_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
];

const MAX_TREE_LINES = 60;
const MAX_FILE_CHARS = 600;
const MAX_SNAPSHOT_CHARS = 2400;

async function tree(root: string, depth: number): Promise<string[]> {
  const lines: string[] = [];
  async function walk(path: string, prefix: string, level: number): Promise<void> {
    if (level > depth || lines.length >= MAX_TREE_LINES) return;
    const items = await readdir(path, { withFileTypes: true }).catch(() => []);
    const visible = items
      .filter((item) => !SKIPPED.has(item.name) && !item.name.startsWith(".env"))
      .filter((item) => !item.name.startsWith("._") && item.name !== ".DS_Store")
      .filter((item) => !(item.name.startsWith(".") && item.isDirectory()))
      .sort((left, right) =>
        left.isDirectory() === right.isDirectory()
          ? left.name.localeCompare(right.name)
          : left.isDirectory()
            ? -1
            : 1,
      );
    for (const item of visible) {
      if (lines.length >= MAX_TREE_LINES) return;
      lines.push(`${prefix}${item.name}${item.isDirectory() ? "/" : ""}`);
      if (item.isDirectory()) await walk(join(path, item.name), `${prefix}  `, level + 1);
    }
  }
  await walk(root, "", 1);
  return lines;
}

async function head_of(path: string): Promise<string | null> {
  try {
    const text = await readFile(path, "utf-8");
    const trimmed = text.trim();
    if (trimmed.length === 0) return null;
    return redact(trimmed.slice(0, MAX_FILE_CHARS));
  } catch {
    return null;
  }
}

export async function snapshot(root: string): Promise<string> {
  const lines = await tree(root, 2);
  const sections: string[] = [];
  if (lines.length > 0) {
    sections.push(`Files (top two levels${lines.length >= MAX_TREE_LINES ? ", cut short" : ""}):\n${lines.join("\n")}`);
  }
  for (const name of KEY_FILES) {
    const head = await head_of(join(root, name));
    if (head !== null) sections.push(`${name} (start):\n${head}`);
  }
  const text = sections.join("\n\n");
  return text.length > MAX_SNAPSHOT_CHARS ? `${text.slice(0, MAX_SNAPSHOT_CHARS)}\n...` : text;
}
