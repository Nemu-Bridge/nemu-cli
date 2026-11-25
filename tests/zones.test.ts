import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { build_manifest, hash_of, index_prompt } from "../src/context/manifest.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changed_zones, matching_zones, zone_hint, type Zone } from "../src/context/zones.js";

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");

const ANIMATION: Zone = {
  vault: "Sky Runner",
  name: "animation",
  keywords: ["run", "walk", "jog", "jump", "emote", "animate"],
  paths: ["animation/running.md"],
  sources: [],
};
const RIGS: Zone = { vault: "Sky Runner", name: "rigs", keywords: ["motor6d", "attach", "hand"], paths: [], sources: [] };
const OPTIMIZATION: Zone = {
  vault: "Sky Runner",
  name: "optimization",
  keywords: ["fps", "lag", "frame rate"],
  paths: ["optimization/fps.md"],
  sources: [],
};
const ZONES = [ANIMATION, RIGS, OPTIMIZATION];

function names(prompt: string): string[] {
  return matching_zones(prompt, ZONES).map((zone) => zone.name);
}

describe("matching a prompt to zones", () => {
  test("finds the zone a task belongs to, in any word form", () => {
    expect(names("create a clean running animation")).toEqual(["animation"]);
    expect(names("Make the character JOG smoothly.")).toEqual(["animation"]);
    expect(names("the double jumps feel bad")).toEqual(["animation"]);
    expect(names("Attach a sword to the player's right hand")).toEqual(["rigs"]);
    expect(names("the frame rates drop")).toEqual(["optimization"]);
  });

  test("puts the zone with the most matches first and stops at two", () => {
    expect(names("animate the walk and jump, attach it, fix the fps")).toEqual(["animation", "rigs"]);
  });

  test("stays quiet when nothing matches", () => {
    expect(names("rename the variable plrs to players")).toEqual([]);
    expect(names("what does pcall do")).toEqual([]);
    expect(names("the flag is grunted")).toEqual([]);
    expect(names("")).toEqual([]);
  });

  test("names the notes to read", () => {
    expect(zone_hint([ANIMATION])).toContain('vault_read {"vault":"Sky Runner","path":"animation/running.md"}');
    expect(zone_hint([RIGS])).toContain('vault_index {"vault":"Sky Runner","folder":"rigs"}');
    expect(zone_hint([])).toBeNull();
  });

  test("picks the notes that fit the request when a zone holds many", () => {
    const paths = ["world/layout.md", "world/air/wind.md", "world/props/chests.md", "world/props/campfires.md"];
    const world: Zone = { ...RIGS, name: "world", paths };
    const fire = zone_hint([world], "make a campfire for the world") ?? "";
    expect(fire).toContain('call vault_read {"vault":"Sky Runner","path":"world/props/campfires.md"}, and read');
    expect(fire).toContain("these that also fit: world/layout.md, world/air/wind.md, world/props/chests.md");
    const none = zone_hint([world], "make the world breezy") ?? "";
    expect(none).not.toContain('"path":"world/');
    paths.forEach((path) => expect(none).toContain(path));
  });
});

describe("a project on disk", () => {
  let root = "";

  async function put(path: string, text: string): Promise<void> {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "nemu-cli-manifest-"));
    await put("src/Run.luau", "print(1)\n");
    await put("src/big.luau", "x".repeat(1024 * 1024 + 1));
    await put("src/leak.luau", `local key = "sk-ant-${"a".repeat(30)}"`);
    await put("src/secrets.ts", "export const a = 1;");
    await put(".env", "KEY=1");
    await put("node_modules/a/index.js", "1");
    await put("assets/one.png", "x");
    await put("assets/two.png", "x");
    await put("notes.bin", "x");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("lists source files with their hash and leaves out secrets, large files and packages", async () => {
    const manifest = await build_manifest(root);
    expect(manifest.files).toEqual([{ path: "src/Run.luau", hash: hash_of(Buffer.from("print(1)\n")), size: 9 }]);
    expect(manifest.assets).toEqual({ "assets/*.png": 2 });
    expect(manifest.skipped.sort()).toEqual(["src/big.luau", "src/leak.luau", "src/secrets.ts"]);
    const prompt = index_prompt("sky-runner", "Game", manifest);
    expect(prompt).toContain(`- src/Run.luau#${manifest.files[0]!.hash}, 9`);
    expect(prompt).toContain("projects: [sky-runner]");
    expect(prompt).not.toContain("sk-ant-");
    expect(prompt).not.toContain(".env");
  });

  test("gives the same hash on Windows and Mac line endings", () => {
    expect(hash_of(Buffer.from("a\r\nb"))).toBe(hash_of(Buffer.from("a\nb")));
  });

  test("reports only zones whose files changed, and never looks outside the project", async () => {
    const good = hash_of(Buffer.from("print(1)\n"));
    const zone = (sources: Zone["sources"]): Zone[] => [{ ...ANIMATION, sources }];
    expect(await changed_zones(root, zone([{ path: "src/Run.luau", hash: good }]))).toBeNull();
    const changed = await changed_zones(
      root,
      zone([
        { path: "src/Run.luau", hash: "0123456789ab" },
        { path: "src/Gone.luau", hash: "0123456789ab" },
      ]),
    );
    expect(changed).toContain(`src/Run.luau#${good}`);
    expect(changed).toContain("src/Gone.luau (deleted)");
    for (const path of ["../outside.luau", "/etc/passwd", "C:/Windows/win.ini", "src", "src/../../x"]) {
      expect(await changed_zones(root, zone([{ path, hash: "0123456789ab" }]))).toBeNull();
    }
  });
});

describe("the prompt hook", () => {
  let directory = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "nemu-cli-zones-"));
    await mkdir(join(directory, "sessions"), { recursive: true });
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function state_file(): string {
    return join(directory, "sessions", "claude-code-s1.json");
  }

  async function start(zones: unknown): Promise<void> {
    await writeFile(
      state_file(),
      JSON.stringify({
        cwd: directory,
        root: directory,
        files: [],
        edits_since_checkpoint: 0,
        last_asked_at: null,
        compacted: false,
        updated_at: Date.now(),
        ...(zones === undefined ? {} : { zones }),
      }),
    );
  }

  function prompt(text: string): string {
    const result = spawnSync("bun", [ENTRY, "hook", "prompt", "--client", "claude-code"], {
      input: JSON.stringify({ session_id: "s1", cwd: directory, prompt: text }),
      env: {
        ...process.env,
        NEMU_CONFIG_DIR: directory,
        NEMU_NO_UPDATE_CHECK: "1",
        NEMU_API_KEY: "",
        NEMU_API_URL: "http://127.0.0.1:9",
        NEMU_NO_REPORTS: "1",
      },
      encoding: "utf-8",
    });
    return result.stdout.trim();
  }

  test("adds the hint once per session, without being signed in", async () => {
    await start(ZONES);
    const output = JSON.parse(prompt("create a clean running animation"));
    expect(output.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(output.hookSpecificOutput.additionalContext).toContain("animation/running.md");
    expect(prompt("make the running animation faster")).toBe("");
    const state = JSON.parse(await readFile(state_file(), "utf-8"));
    expect(state.hinted).toEqual(["Sky Runner/animation"]);
    expect(JSON.stringify(state)).not.toContain("clean running");
  }, 30_000);

  test("works with a session saved by an older version", async () => {
    await start(undefined);
    expect(prompt("create a clean running animation")).toBe("");
  }, 30_000);
});
