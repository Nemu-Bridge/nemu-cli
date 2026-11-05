import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetch_latest, is_newer, latest_version } from "../src/update.js";
import { read_settings } from "../src/config.js";

let directory = "";
let served = "1.2.0";
let hits = 0;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "nemu-cli-update-"));
  process.env.NEMU_CONFIG_DIR = directory;
  server = Bun.serve({
    port: 0,
    fetch(request) {
      hits += 1;
      if (new URL(request.url).pathname !== "/nemu-cli/latest") return new Response("", { status: 404 });
      return Response.json({ name: "nemu-cli", version: served });
    },
  });
  process.env.NEMU_REGISTRY_URL = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  server.stop(true);
  delete process.env.NEMU_REGISTRY_URL;
  delete process.env.NEMU_CONFIG_DIR;
  await rm(directory, { recursive: true, force: true });
});

describe("comparing versions", () => {
  test("a higher major, minor or patch is newer", () => {
    expect(is_newer("1.2.0", "1.1.0")).toBe(true);
    expect(is_newer("2.0.0", "1.9.9")).toBe(true);
    expect(is_newer("1.1.1", "1.1.0")).toBe(true);
  });

  test("the same or an older version is not newer", () => {
    expect(is_newer("1.1.0", "1.1.0")).toBe(false);
    expect(is_newer("1.0.9", "1.1.0")).toBe(false);
    expect(is_newer("1.10.0", "1.9.0")).toBe(true);
  });

  test("a release is newer than its prerelease, and garbage never is", () => {
    expect(is_newer("1.2.0", "1.2.0-beta.1")).toBe(true);
    expect(is_newer("1.2.0-beta.1", "1.2.0")).toBe(false);
    expect(is_newer("latest", "1.1.0")).toBe(false);
    expect(is_newer("1.2", "1.1.0")).toBe(false);
  });
});

describe("asking the registry", () => {
  test("reads the latest version and refuses a malformed answer", async () => {
    served = "1.2.0";
    expect(await fetch_latest()).toBe("1.2.0");
    served = "not a version";
    expect(await fetch_latest()).toBeNull();
  });

  test("asks at most once a day and remembers the answer", async () => {
    served = "1.3.0";
    const start = 1_800_000_000_000;
    const before = hits;
    expect(await latest_version(false, start)).toBe("1.3.0");
    served = "1.4.0";
    expect(await latest_version(false, start + 60_000)).toBe("1.3.0");
    expect(hits).toBe(before + 1);
    expect(await latest_version(false, start + 25 * 60 * 60 * 1000)).toBe("1.4.0");
    expect(hits).toBe(before + 2);
    expect((await read_settings()).update_latest).toBe("1.4.0");
  });

  test("an unreachable registry answers nothing rather than failing", async () => {
    process.env.NEMU_CONFIG_DIR = join(directory, "empty");
    process.env.NEMU_REGISTRY_URL = "http://127.0.0.1:9";
    expect(await latest_version(true)).toBeNull();
    process.env.NEMU_REGISTRY_URL = `http://127.0.0.1:${server.port}`;
    process.env.NEMU_CONFIG_DIR = directory;
  });

  test("an unreachable registry falls back to today's answer", async () => {
    const now = Date.now();
    served = "1.5.0";
    expect(await latest_version(true, now)).toBe("1.5.0");
    process.env.NEMU_REGISTRY_URL = "http://127.0.0.1:9";
    expect(await latest_version(true, now + 60_000)).toBe("1.5.0");
    process.env.NEMU_REGISTRY_URL = `http://127.0.0.1:${server.port}`;
  });
});
