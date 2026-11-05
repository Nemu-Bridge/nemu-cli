import { hostname, platform } from "node:os";
import { read_credentials, read_settings, update_settings } from "./config.js";
import { list_devices, register_device } from "./context/api.js";
import { VERSION } from "./version.js";

const PLATFORMS = new Set(["darwin", "linux", "win32", "freebsd"]);

export function device_name(): string {
  const raw = hostname().replace(/\.local$/, "").replace(/[^\w .-]/g, "").trim();
  return (raw.length > 0 ? raw : "This computer").slice(0, 64);
}

export async function ensure_device(force = false): Promise<string> {
  const credentials = await read_credentials();
  const settings = await read_settings();
  if (
    !force &&
    settings.device_id !== undefined &&
    credentials !== null &&
    settings.device_api_url === credentials.api_url
  ) {
    return settings.device_id;
  }
  const current = platform();
  const device = await register_device({
    name: device_name(),
    platform: PLATFORMS.has(current) ? current : "other",
    client_version: VERSION,
  });
  await update_settings({
    device_id: device.id,
    device_api_url: credentials?.api_url,
  });
  return device.id;
}

export type DeviceState =
  | { state: "active" | "revoked" | "unknown"; id: string }
  | { state: "unregistered" };

export async function device_state(): Promise<DeviceState> {
  const credentials = await read_credentials();
  const settings = await read_settings();
  const id = settings.device_id;
  if (credentials === null || id === undefined || settings.device_api_url !== credentials.api_url) {
    return { state: "unregistered" };
  }
  const devices = await list_devices();
  const mine = devices.find((device) => device.id === id);
  if (mine === undefined) return { state: "unknown", id };
  return { state: mine.revoked_at === null ? "active" : "revoked", id };
}

export async function verify_device(): Promise<string> {
  const current = await device_state();
  if (current.state === "active") return current.id;
  return ensure_device(true);
}
