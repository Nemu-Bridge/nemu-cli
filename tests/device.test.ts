import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { read_settings, update_settings, write_credentials } from "../src/config.js";
import { device_state, verify_device } from "../src/device.js";
import { status } from "../src/commands/status.js";
import { set_json_mode } from "../src/output.js";

interface ServedDevice {
  id: string;
  name: string;
  revoked_at: string | null;
}

const STALE_ID = "dev_aaaaaaaaaaaa";
const FRESH_ID = "dev_bbbbbbbbbbbb";

let directory = "";
let server: ReturnType<typeof Bun.serve>;
let base_url = "";
let served: ServedDevice[] = [];
let registrations = 0;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/api/v1/devices") return new Response("", { status: 404 });
      if (request.method === "GET") return Response.json({ data: served });
      registrations += 1;
      const created = { id: FRESH_ID, name: "test", revoked_at: null };
      served = [...served, created];
      return Response.json({ data: created }, { status: 201 });
    },
  });
  base_url = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "nemu-cli-device-"));
  process.env.NEMU_CONFIG_DIR = directory;
  served = [];
  registrations = 0;
});

afterEach(async () => {
  set_json_mode(false);
  delete process.env.NEMU_CONFIG_DIR;
  await rm(directory, { recursive: true, force: true });
});

async function sign_in(overrides: Record<string, unknown> = {}) {
  await write_credentials({
    access_token: "at_example",
    refresh_token: "rt_example",
    expires_at: Date.now() + 3_600_000,
    scope: "profile:read context:read context:write",
    api_url: base_url,
    account: "tester",
    ...overrides,
  });
  await update_settings({ device_id: STALE_ID, device_api_url: base_url });
}

async function status_report(): Promise<Record<string, unknown>> {
  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return true;
  }) as typeof process.stdout.write;
  set_json_mode(true);
  try {
    await status();
  } finally {
    process.stdout.write = original;
  }
  return JSON.parse(written.join("")) as Record<string, unknown>;
}

describe("asking Nemu about this computer", () => {
  test("a device the server no longer has is unknown, not active", async () => {
    await sign_in();
    served = [{ id: "dev_cccccccccccc", name: "macbook", revoked_at: null }];
    expect(await device_state()).toEqual({ state: "unknown", id: STALE_ID });
  });

  test("a revoked device is reported as revoked", async () => {
    await sign_in();
    served = [{ id: STALE_ID, name: "test", revoked_at: new Date().toISOString() }];
    expect(await device_state()).toEqual({ state: "revoked", id: STALE_ID });
  });

  test("a device the server lists and has not revoked is active", async () => {
    await sign_in();
    served = [{ id: STALE_ID, name: "test", revoked_at: null }];
    expect(await device_state()).toEqual({ state: "active", id: STALE_ID });
  });

  test("signing in again registers a fresh device in place of an unknown one", async () => {
    await sign_in();
    expect(await verify_device()).toBe(FRESH_ID);
    expect(registrations).toBe(1);
    expect((await read_settings()).device_id).toBe(FRESH_ID);
  });
});

describe("nemu status", () => {
  test("it reports a device the server does not know", async () => {
    await sign_in();
    const report = await status_report();
    expect(report.signed_in).toBe(true);
    expect(report.device_id).toBe(STALE_ID);
    expect(report.device_state).toBe("unknown");
  }, 30_000);

  test("it reports an expired sign in instead of ok", async () => {
    await sign_in({ expires_at: Date.now() - 60_000, refresh_token: undefined });
    const report = await status_report();
    expect(report.signed_in).toBe(false);
    expect(report.device_state).toBe("unchecked");
  }, 30_000);
});
