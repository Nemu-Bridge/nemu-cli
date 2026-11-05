import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { install_hooks } from "../src/clients/hooks.js";
import { set_entry } from "../src/clients/jsonc.js";
import { safe_browser_url } from "../src/ui.js";

let directory = "";

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "nemu-cli-mode-"));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

const mode_of = async (path: string) => (await stat(path)).mode & 0o777;

describe.skipIf(process.platform === "win32")("settings files keep their permissions", () => {
  test("hooks keep a settings file the user locked to 0600", async () => {
    const path = join(directory, "locked.json");
    await writeFile(path, JSON.stringify({ env: { TOKEN: "placeholder" } }));
    await chmod(path, 0o600);
    await install_hooks(path, "/usr/local/bin/nemu", "claude-code");
    expect(await mode_of(path)).toBe(0o600);
  });

  test("hooks create a new settings file readable by its owner only", async () => {
    const path = join(directory, "fresh-hooks.json");
    await install_hooks(path, "/usr/local/bin/nemu", "claude-code");
    expect(await mode_of(path)).toBe(0o600);
  });

  test("editor config created from nothing is readable by its owner only", async () => {
    const path = join(directory, "fresh-editor.json");
    await set_entry(path, ["mcpServers", "nemu"], { command: "nemu" });
    expect(await mode_of(path)).toBe(0o600);
  });
});

describe("browser links", () => {
  const origin = "https://app.nemu.cc";

  test("opens the server's own https link", () => {
    expect(safe_browser_url("https://app.nemu.cc/device", origin)).toBe("https://app.nemu.cc/device");
  });

  test("refuses another origin", () => {
    expect(safe_browser_url("https://evil.example/device", origin)).toBeNull();
  });

  test("refuses plain http away from loopback", () => {
    expect(safe_browser_url("http://app.nemu.cc/device", "http://app.nemu.cc")).toBeNull();
  });

  test("allows http on loopback for local development", () => {
    expect(safe_browser_url("http://localhost:3002/device", "http://localhost:3002")).toBe(
      "http://localhost:3002/device",
    );
  });

  test("refuses a link carrying shell metacharacters outside the expected origin", () => {
    expect(safe_browser_url("https://x/&calc", origin)).toBeNull();
    expect(safe_browser_url("file:///etc/passwd", origin)).toBeNull();
  });
});
