import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_API_URL,
  DEFAULT_CLIENT_ID,
  api_url,
  client_id,
  clear_credentials,
  config_dir,
  is_expired,
  read_credentials,
  write_credentials,
} from "../src/config.js";

let directory = "";
let saved_dir: string | undefined;
let saved_api: string | undefined;
let saved_client: string | undefined;

beforeEach(async () => {
  saved_dir = process.env.NEMU_CONFIG_DIR;
  saved_api = process.env.NEMU_API_URL;
  saved_client = process.env.NEMU_CLIENT_ID;
  directory = await mkdtemp(join(tmpdir(), "nemu-cli-"));
  process.env.NEMU_CONFIG_DIR = directory;
  delete process.env.NEMU_API_URL;
  delete process.env.NEMU_CLIENT_ID;
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
  if (saved_dir === undefined) delete process.env.NEMU_CONFIG_DIR;
  else process.env.NEMU_CONFIG_DIR = saved_dir;
  if (saved_api === undefined) delete process.env.NEMU_API_URL;
  else process.env.NEMU_API_URL = saved_api;
  if (saved_client === undefined) delete process.env.NEMU_CLIENT_ID;
  else process.env.NEMU_CLIENT_ID = saved_client;
});

function credentials(overrides: Record<string, unknown> = {}) {
  return {
    access_token: "at_example",
    refresh_token: "rt_example",
    expires_at: Date.now() + 3_600_000,
    scope: "profile:read",
    api_url: DEFAULT_API_URL,
    account: "hiraeeth",
    ...overrides,
  };
}

describe("where the CLI points", () => {
  test("it talks to the console by default", () => {
    expect(api_url()).toBe("https://app.nemu.cc");
  });

  test("it can be pointed elsewhere for development", () => {
    process.env.NEMU_API_URL = "http://localhost:3002";
    expect(api_url()).toBe("http://localhost:3002");
  });

  test("it identifies as the first party client", () => {
    expect(client_id()).toBe(DEFAULT_CLIENT_ID);
    expect(DEFAULT_CLIENT_ID).toBe("nemu_cli");
  });

  test("the config directory is overridable, which is what lets this test run", () => {
    expect(config_dir()).toBe(directory);
  });
});

describe("storing a token on disk", () => {
  test("nothing is reported when nothing was ever written", async () => {
    expect(await read_credentials()).toBeNull();
  });

  test("what is written comes back, and an older file reads as an OAuth sign in", async () => {
    const value = credentials();
    await write_credentials(value);
    expect(await read_credentials()).toEqual({ kind: "oauth", ...value });
  });

  test("an API key sign in keeps its kind and workspace", async () => {
    const value = {
      ...credentials(),
      kind: "key" as const,
      refresh_token: undefined,
      workspace: { id: "ws_1", name: "nemu" },
    };
    await write_credentials(value);
    const read = await read_credentials();
    expect(read?.kind).toBe("key");
    expect(read?.workspace).toEqual({ id: "ws_1", name: "nemu" });
    expect(read?.refresh_token).toBeUndefined();
  });

  test("the file is not readable by other users on this machine", async () => {
    const path = await write_credentials(credentials());
    const info = await stat(path);
    if (process.platform === "win32") {
      expect(info.isFile()).toBe(true);
      return;
    }
    expect(info.mode & 0o077).toBe(0);
  });

  test("it lands in the config directory as auth.json", async () => {
    const path = await write_credentials(credentials());
    expect(path).toBe(join(directory, "auth.json"));
  });

  test("the token is not written anywhere else in the file", async () => {
    const path = await write_credentials(credentials());
    const raw = await readFile(path, "utf-8");
    expect(raw.split("at_example").length - 1).toBe(1);
  });

  test("a corrupted file reads as signed out rather than crashing", async () => {
    await write_credentials(credentials());
    await Bun.write(join(directory, "auth.json"), "{ not json");
    expect(await read_credentials()).toBeNull();
  });

  test("a file with no token reads as signed out", async () => {
    await Bun.write(join(directory, "auth.json"), JSON.stringify({ scope: "" }));
    expect(await read_credentials()).toBeNull();
  });
});

describe("signing out", () => {
  test("it removes the stored token", async () => {
    await write_credentials(credentials());
    expect(await clear_credentials()).toBe(true);
    expect(await read_credentials()).toBeNull();
  });

  test("signing out twice is not an error", async () => {
    await write_credentials(credentials());
    expect(await clear_credentials()).toBe(true);
    expect(await clear_credentials()).toBe(false);
  });
});

describe("knowing when to sign in again", () => {
  test("a future expiry is still valid", () => {
    expect(is_expired(credentials())).toBe(false);
  });

  test("a past expiry is not", () => {
    expect(is_expired(credentials({ expires_at: Date.now() - 1000 }))).toBe(
      true,
    );
  });

  test("an expiry of exactly now counts as expired", () => {
    expect(is_expired(credentials({ expires_at: Date.now() }))).toBe(true);
  });
});
