import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKUP_SUFFIX, read_entry, remove_entry, set_entry } from "../src/clients/jsonc.js";
import {
  EDITORS,
  editor_from_name,
  editor_has_nemu,
  is_nemu_entry,
  remove_from_editor,
} from "../src/clients/editors.js";
import { CliError } from "../src/errors.js";

const NEMU = "/usr/local/bin/nemu";
let directory = "";
let home = "";
const saved = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
};

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "nemu-cli-editors-"));
  home = join(directory, "home");
  await mkdir(home, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.XDG_CONFIG_HOME;
});

afterAll(async () => {
  process.env.HOME = saved.HOME;
  if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = saved.USERPROFILE;
  if (saved.XDG_CONFIG_HOME !== undefined) process.env.XDG_CONFIG_HOME = saved.XDG_CONFIG_HOME;
  await rm(directory, { recursive: true, force: true });
});

const ZED = `// Zed settings
{
  "theme": "One Dark", // keep this comment
  /* block comment */
  "context_servers": {
    "other": { "command": "other-server", "args": [] },
  },
  "vim_mode": true
}
`;

describe("editing a config file", () => {
  test("adds only the nemu entry and keeps comments, other servers and settings", async () => {
    const path = join(directory, "zed.json");
    await writeFile(path, ZED);
    const result = await set_entry(path, ["context_servers", "nemu"], { command: NEMU, args: ["mcp", "--client", "zed"], env: {} });
    expect(result.change).toBe("added");
    const text = await readFile(path, "utf-8");
    expect(text).toContain("// Zed settings");
    expect(text).toContain("// keep this comment");
    expect(text).toContain("/* block comment */");
    expect(text).toContain('"other": { "command": "other-server", "args": [] }');
    expect(text).toContain('"vim_mode": true');
    expect(await read_entry(path, ["context_servers", "nemu"])).toEqual({ command: NEMU, args: ["mcp", "--client", "zed"], env: {} });
    expect(await readFile(`${path}${BACKUP_SUFFIX}`, "utf-8")).toBe(ZED);
  });

  test("running it again changes nothing", async () => {
    const path = join(directory, "zed.json");
    const before = await readFile(path, "utf-8");
    const before_time = (await stat(path)).mtimeMs;
    const result = await set_entry(path, ["context_servers", "nemu"], { command: NEMU, args: ["mcp", "--client", "zed"], env: {} });
    expect(result).toEqual({ change: "unchanged", backup: null });
    expect(await readFile(path, "utf-8")).toBe(before);
    expect((await stat(path)).mtimeMs).toBe(before_time);
  });

  test("removing takes out only our entry", async () => {
    const path = join(directory, "zed.json");
    expect(await remove_entry(path, ["context_servers", "nemu"], is_nemu_entry)).toBe("removed");
    const text = await readFile(path, "utf-8");
    expect(text).not.toContain(NEMU);
    expect(text).toContain("// keep this comment");
    expect(text).toContain('"other"');
    expect(await remove_entry(path, ["context_servers", "nemu"], is_nemu_entry)).toBe("absent");
  });

  test("setup then uninstall gives back the exact file, even when setup added the section", async () => {
    const path = join(directory, "plain.json");
    const original = '{\n  "theme": "x",\n  "vim_mode": true\n}\n';
    await writeFile(path, original);
    await set_entry(path, ["context_servers", "nemu"], { command: NEMU, args: ["mcp"] });
    expect(await remove_entry(path, ["context_servers", "nemu"], is_nemu_entry)).toBe("removed");
    expect(await readFile(path, "utf-8")).toBe(original);
  });

  test("creates a missing file with only the entry", async () => {
    const path = join(directory, "fresh", "mcp.json");
    const result = await set_entry(path, ["mcpServers", "nemu"], { command: NEMU, args: ["mcp"] });
    expect(result).toEqual({ change: "added", backup: null });
    expect(JSON.parse(await readFile(path, "utf-8"))).toEqual({ mcpServers: { nemu: { command: NEMU, args: ["mcp"] } } });
  });

  test("keeps tab indentation", async () => {
    const path = join(directory, "tabs.json");
    await writeFile(path, '{\n\t"mcpServers": {\n\t\t"a": { "command": "a" }\n\t}\n}\n');
    await set_entry(path, ["mcpServers", "nemu"], { command: NEMU, args: ["mcp"] });
    const text = await readFile(path, "utf-8");
    expect(text).toContain('\t\t"nemu"');
    expect(text).not.toMatch(/^ {2}"/m);
  });

  test("never touches a file it cannot parse or that is not an object", async () => {
    for (const [name, content] of [["broken.json", '{ "mcpServers": { '], ["array.json", "[1, 2]"]] as const) {
      const path = join(directory, name);
      await writeFile(path, content);
      await expect(set_entry(path, ["mcpServers", "nemu"], { command: NEMU, args: ["mcp"] })).rejects.toBeInstanceOf(CliError);
      expect(await readFile(path, "utf-8")).toBe(content);
    }
  });

  test("leaves a different server called nemu alone when removing", async () => {
    const path = join(directory, "foreign.json");
    const content = '{ "mcpServers": { "nemu": { "command": "python", "args": ["server.py"] } } }\n';
    await writeFile(path, content);
    expect(await remove_entry(path, ["mcpServers", "nemu"], is_nemu_entry)).toBe("absent");
    expect(await readFile(path, "utf-8")).toBe(content);
  });
});

describe("editors", () => {
  test("recognises names and aliases", () => {
    expect(editor_from_name("cursor")?.id).toBe("cursor");
    expect(editor_from_name("code")?.id).toBe("vscode");
    expect(editor_from_name("VS-Code")?.id).toBe("vscode");
    expect(editor_from_name("gemini-cli")?.id).toBe("gemini");
    expect(editor_from_name("OpenCode")?.id).toBe("opencode");
    expect(editor_from_name("claude")).toBeNull();
  });

  test("only our bridge counts as the nemu entry", () => {
    expect(is_nemu_entry({ command: NEMU, args: ["mcp", "--client", "cursor"] })).toBe(true);
    expect(is_nemu_entry({ command: "C:\\Users\\a\\AppData\\Roaming\\npm\\nemu.cmd", args: ["mcp"] })).toBe(true);
    expect(is_nemu_entry({ command: "nemu", args: ["login"] })).toBe(false);
    expect(is_nemu_entry({ command: "python", args: ["mcp"] })).toBe(false);
    expect(is_nemu_entry("nemu")).toBe(false);
    expect(is_nemu_entry({ type: "local", command: [NEMU, "mcp", "--client", "opencode"] })).toBe(true);
    expect(is_nemu_entry({ type: "local", command: ["nemu", "serve"] })).toBe(false);
  });

  test("Cursor and Windsurf configs live under the home folder", () => {
    expect(EDITORS.cursor.config_path()).toBe(join(home, ".cursor", "mcp.json"));
    expect(EDITORS.windsurf.config_path()).toBe(join(home, ".codeium", "windsurf", "mcp_config.json"));
    expect(EDITORS.gemini.config_path()).toBe(join(home, ".gemini", "settings.json"));
  });

  test("setup refuses to replace a different server called nemu", async () => {
    const path = EDITORS.cursor.config_path();
    await mkdir(join(home, ".cursor"), { recursive: true });
    const content = '{ "mcpServers": { "nemu": { "command": "python", "args": ["x.py"] } } }\n';
    await writeFile(path, content);
    await expect(EDITORS.cursor.add(NEMU)).rejects.toBeInstanceOf(CliError);
    expect(await readFile(path, "utf-8")).toBe(content);
  });

  test("Cursor add, status and uninstall round trip", async () => {
    const path = EDITORS.cursor.config_path();
    await writeFile(path, '{\n  "mcpServers": {\n    "github": { "command": "gh-mcp" }\n  }\n}\n');
    expect((await EDITORS.cursor.add(NEMU)).change).toBe("added");
    expect(await editor_has_nemu(EDITORS.cursor)).toBe(true);
    expect(await read_entry(path, ["mcpServers", "github"])).toEqual({ command: "gh-mcp" });
    expect(await remove_from_editor(EDITORS.cursor)).toBe(true);
    expect(await editor_has_nemu(EDITORS.cursor)).toBe(false);
    expect(await read_entry(path, ["mcpServers", "github"])).toEqual({ command: "gh-mcp" });
  });

  test("OpenCode add, status and uninstall round trip, in the .jsonc file when that is the one present", async () => {
    const folder = join(home, ".config", "opencode");
    await mkdir(folder, { recursive: true });
    expect(EDITORS.opencode.config_path()).toBe(join(folder, "opencode.json"));
    const path = join(folder, "opencode.jsonc");
    await writeFile(path, '{\n  "$schema": "https://opencode.ai/config.json", // keep\n  "theme": "tokyonight"\n}\n');
    expect(EDITORS.opencode.config_path()).toBe(path);
    expect((await EDITORS.opencode.add(NEMU)).change).toBe("added");
    expect(await read_entry(path, ["mcp", "nemu"])).toEqual({
      type: "local",
      command: [NEMU, "mcp", "--client", "opencode"],
      enabled: true,
    });
    expect(await readFile(path, "utf-8")).toContain("// keep");
    expect(await editor_has_nemu(EDITORS.opencode)).toBe(true);
    expect((await EDITORS.opencode.add(NEMU)).change).toBe("unchanged");
    expect(await remove_from_editor(EDITORS.opencode)).toBe(true);
    expect(await read_entry(path, ["theme"])).toBe("tokyonight");
  });
});
