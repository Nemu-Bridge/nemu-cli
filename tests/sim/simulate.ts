import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { API_VERSION } from "../../src/config.js";
import { create_vault, VaultApi, type Transport } from "../../src/vault/api.js";
import { run_sync, type SyncReport } from "../../src/vault/engine.js";
import { has_conflict_markers } from "../../src/vault/merge.js";
import { lock_path, write_marker } from "../../src/vault/state.js";
import { check_path } from "../../src/vault/paths.js";
import { CliError } from "../../src/errors.js";

const API_URL = process.env.NEMU_SIM_API_URL;
const API_KEY = process.env.NEMU_SIM_API_KEY;
const ROOT = process.env.NEMU_SIM_ROOT;
const PRUNE = process.env.NEMU_SIM_PRUNE_CMD;
const DEVICES = Number(process.env.NEMU_SIM_DEVICES ?? 4);
const ROUNDS = Number(process.env.NEMU_SIM_ROUNDS ?? 12);
let seed = Number(process.env.NEMU_SIM_SEED ?? 20261029);

if (API_URL === undefined || API_KEY === undefined || ROOT === undefined) {
  process.stdout.write(
    "The sync simulator runs against a real platform. Set NEMU_SIM_API_URL, NEMU_SIM_API_KEY (a development workspace key with context:read and context:write) and NEMU_SIM_ROOT (an empty scratch folder).\n",
  );
  process.exit(0);
}

class SimCrash extends Error {
  constructor(readonly after_send: boolean) {
    super(after_send ? "simulated crash after the request was sent" : "simulated crash before the request");
  }
}

function random(): number {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}

function pick<T>(items: T[]): T {
  return items[Math.floor(random() * items.length)]!;
}

function token(): string {
  return Math.floor(random() * 2 ** 31).toString(36);
}

function sha(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

const stats = {
  runs: 0,
  crashes_before: 0,
  crashes_after: 0,
  duplicates: 0,
  stale_locks: 0,
  state_rollbacks: 0,
  merges: 0,
  conflicts: 0,
  moves: 0,
  pulls: 0,
  pushes: 0,
  deletes: 0,
  retry_cycles: 0,
  full_reconciles: 0,
  requests: 0,
  rate_limited: 0,
  user_ops: 0,
};

interface Faults {
  crash_before: number;
  crash_after: number;
  duplicate: number;
  force_410: boolean;
}

function base_transport(): Transport {
  return async (method, path, options) => {
    const url = new URL(`${API_URL}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    stats.requests += 1;
    const response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "nemu-api-version": API_VERSION,
        "user-agent": "nemu-sync-simulator",
        ...(options.headers ?? {}),
      },
      body: options.body,
    });
    if (response.status === 429) stats.rate_limited += 1;
    return response;
  };
}

function faulty(inner: Transport, faults: Faults): Transport {
  return async (method, path, options) => {
    if (faults.force_410 && path.endsWith("/changes")) {
      faults.force_410 = false;
      return new Response(JSON.stringify({ error: "forced", code: "resync_required" }), { status: 410 });
    }
    if (method === "GET") return inner(method, path, options);
    if (random() < faults.crash_before) {
      stats.crashes_before += 1;
      throw new SimCrash(false);
    }
    if (random() < faults.duplicate) {
      stats.duplicates += 1;
      const first = await inner(method, path, options);
      await first.arrayBuffer();
      return inner(method, path, options);
    }
    const response = await inner(method, path, options);
    if (random() < faults.crash_after) {
      stats.crashes_after += 1;
      await response.arrayBuffer();
      throw new SimCrash(true);
    }
    return response;
  };
}

interface Device {
  name: string;
  root: string;
  state_path: string;
  faults: Faults;
  api: VaultApi;
}

const written_lines = new Set<string>();
const written_hashes = new Set<string>();
let recorded_contents = 0;

async function walk(root: string, relative = ""): Promise<string[]> {
  const entries = await readdir(join(root, relative), { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries) {
    const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (path === ".nemu") continue;
    if (entry.isDirectory()) found.push(...(await walk(root, path)));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

const SYNCED = (path: string) =>
  !path.startsWith(".obsidian/") && !path.includes("/.") && !path.startsWith(".") && !path.endsWith(".tmp");

async function snapshot(device: Device): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  for (const path of await walk(device.root)) {
    if (!SYNCED(path)) continue;
    files.set(path.normalize("NFC"), await readFile(join(device.root, ...path.split("/"))));
  }
  return files;
}

function lines_of(content: Buffer): string[] {
  return content
    .toString("utf-8")
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.length > 0);
}

async function record(device: Device, skip: (path: string) => boolean = () => false): Promise<void> {
  for (const [path, content] of await snapshot(device)) {
    if (skip(path)) continue;
    recorded_contents += 1;
    if (path.endsWith(".md")) for (const line of lines_of(content)) written_lines.add(line);
    else written_hashes.add(sha(content));
  }
}

async function sync(device: Device, options: { allow_deletes?: boolean; record?: boolean } = {}): Promise<SyncReport> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (options.record !== false) await record(device, (path) => !/^[\w ()/.,-]+$/.test(path));
    const before = await readFile(device.state_path).catch(() => null);
    if (random() < 0.05) {
      stats.stale_locks += 1;
      await mkdir(join(device.root, ".nemu"), { recursive: true });
      await writeFile(lock_path(device.root), JSON.stringify({ pid: 2_147_000_001, host: hostname(), started_at: "x", token: "dead" }));
    }
    stats.runs += 1;
    try {
      const report = await run_sync({
        root: device.root,
        api: device.api,
        state_path: device.state_path,
        device: device.name,
        quiet_ms: 0,
        allow_deletes: options.allow_deletes,
      });
      stats.merges += report.merged.length;
      stats.conflicts += report.conflicts.length;
      stats.moves += report.moved.length;
      stats.pulls += report.pulled.length;
      stats.pushes += report.pushed.length;
      stats.deletes += report.deleted_local.length + report.deleted_remote.length;
      stats.retry_cycles += report.cycles - 1;
      if (report.full) stats.full_reconciles += 1;
      return report;
    } catch (error) {
      if (!(error instanceof SimCrash)) throw error;
      if (before !== null && random() < 0.5) {
        stats.state_rollbacks += 1;
        await writeFile(device.state_path, before);
      }
    }
  }
  throw new Error(`${device.name} kept crashing`);
}

const FOLDERS = ["", "Projects/", "Journal/", "Ideas/Deep/"];
const NAMES = ["Plan", "Notes", "Todo", "Draft", "Meeting", "Research", "Inbox", "Log", "Spec", "Story"];

async function user_op(device: Device, round: number): Promise<void> {
  stats.user_ops += 1;
  const files = [...(await snapshot(device)).keys()].filter((path) => !path.includes("(conflict,"));
  const markdown = files.filter((path) => path.endsWith(".md"));
  const roll = random();
  const stamp = `${device.name} r${round} ${token()}`;
  const absolute = (path: string) => join(device.root, ...path.split("/"));
  if (roll < 0.25 || markdown.length < 3) {
    const path = `${pick(FOLDERS)}${pick(NAMES)} ${token().slice(0, 3)}.md`;
    const crlf = random() < 0.2;
    const body = [`# ${path}`, `created by ${stamp}`, `line a ${token()}`, `line b ${token()}`, `line c ${token()}`, `line d ${token()}`];
    await mkdir(join(absolute(path), ".."), { recursive: true });
    await writeFile(absolute(path), body.join(crlf ? "\r\n" : "\n") + (crlf ? "\r\n" : "\n"));
    return;
  }
  if (roll < 0.65) {
    const path = pick(markdown);
    const text = (await readFile(absolute(path))).toString("utf-8");
    const ending = text.includes("\r\n") ? "\r\n" : "\n";
    const lines = text.split(/\r?\n/);
    const at = Math.floor(random() * lines.length);
    const kind = random();
    if (kind < 0.5) lines[at] = `edit by ${stamp}`;
    else if (kind < 0.85) lines.splice(at, 0, `insert by ${stamp}`);
    else lines.push(`append by ${stamp}`);
    await writeFile(absolute(path), lines.join(ending));
    return;
  }
  if (roll < 0.75) {
    const path = `${pick(FOLDERS)}blob ${token().slice(0, 2)}.bin`;
    await mkdir(join(absolute(path), ".."), { recursive: true });
    await writeFile(absolute(path), Buffer.from(Array.from({ length: 16 + Math.floor(random() * 64) }, () => Math.floor(random() * 256))));
    return;
  }
  if (roll < 0.88) {
    const path = pick(files);
    const extension = path.slice(path.lastIndexOf("."));
    const target = `${pick(FOLDERS)}${pick(NAMES)} moved ${token().slice(0, 3)}${extension}`;
    if (files.includes(target)) return;
    await mkdir(join(absolute(target), ".."), { recursive: true });
    await rename(absolute(path), absolute(target));
    return;
  }
  if (roll < 0.95 && files.length > 12) {
    await rm(absolute(pick(files)));
    return;
  }
  await mkdir(join(device.root, ".obsidian"), { recursive: true });
  await writeFile(join(device.root, ".obsidian", "workspace.json"), JSON.stringify({ open: token() }));
}

async function make_device(name: string, vault_id: string, vault_name: string): Promise<Device> {
  const root = join(ROOT!, name);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  await write_marker(root, {
    version: 1,
    vault_id,
    vault_name,
    workspace_id: null,
    server: API_URL!,
    linked_at: new Date().toISOString(),
  });
  const faults: Faults = { crash_before: 0, crash_after: 0, duplicate: 0, force_410: false };
  return {
    name,
    root,
    state_path: join(ROOT!, `${name}.state.json`),
    faults,
    api: new VaultApi(faulty(base_transport(), faults), vault_id, `nemu-sync-sim ${name}`),
  };
}

async function hashes(device: Device): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const [path, content] of await snapshot(device)) {
    if (check_path(path).ok) result.set(path, sha(content));
  }
  return result;
}

function same(left: Map<string, string>, right: Map<string, string>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) if (right.get(key) !== value) return false;
  return true;
}

const results: Record<string, unknown> = {};
const failures: string[] = [];

function check(label: string, ok: boolean, detail?: unknown): void {
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${label}${ok || detail === undefined ? "" : ` ${JSON.stringify(detail).slice(0, 600)}`}\n`);
  if (!ok) failures.push(label);
}

async function converge(devices: Device[], api: VaultApi): Promise<{ converged: boolean; files: number; passes: number }> {
  for (const device of devices) Object.assign(device.faults, { crash_before: 0, crash_after: 0, duplicate: 0 });
  let passes = 0;
  for (let pass = 0; pass < 4; pass += 1) {
    passes += 1;
    let changed = 0;
    for (const device of devices) {
      const report = await sync(device);
      changed += report.pulled.length + report.pushed.length + report.merged.length + report.moved.length +
        report.deleted_local.length + report.deleted_remote.length + report.conflicts.length;
    }
    if (changed === 0 && pass > 0) break;
  }
  const listing = await api.notes();
  const server = new Map<string, string>();
  for (const note of listing.notes) if (!note.deleted) server.set(note.path, note.hash);
  const local = await Promise.all(devices.map(hashes));
  const converged = local.every((files) => same(files, server));
  if (!converged) {
    const diff = local.map((files, index) => ({
      device: devices[index]!.name,
      only_local: [...files.keys()].filter((key) => !server.has(key)),
      only_server: [...server.keys()].filter((key) => !files.has(key)),
      differ: [...files.keys()].filter((key) => server.has(key) && server.get(key) !== files.get(key)),
    }));
    process.stdout.write(`${JSON.stringify(diff, null, 1)}\n`);
  }
  return { converged, files: server.size, passes };
}

async function history_corpus(api: VaultApi): Promise<{ lines: Set<string>; hashes: Set<string>; versions: number; notes: number }> {
  const lines = new Set<string>();
  const hashes = new Set<string>();
  const live = await api.notes();
  const trash = await api.notes(true);
  let versions = 0;
  for (const note of [...live.notes, ...trash.notes]) {
    for (const version of await api.history(note.id)) {
      if (version.deleted) continue;
      versions += 1;
      hashes.add(version.hash);
      if (version.path.endsWith(".md")) {
        const content = await api.read_version(note.id, version.version);
        for (const line of lines_of(content)) lines.add(line);
      }
    }
  }
  return { lines, hashes, versions, notes: live.notes.length + trash.notes.length };
}

async function main(): Promise<void> {
  await mkdir(ROOT!, { recursive: true });
  const name = `sync-sim ${Date.now().toString(36)}`;
  const vault = await create_vault(base_transport(), name);
  process.stdout.write(`vault ${vault.id}\n`);
  const plain = new VaultApi(base_transport(), vault.id, "nemu-sync-sim checker");
  const devices = await Promise.all(
    Array.from({ length: DEVICES }, (_, index) => make_device(`sim-${String.fromCharCode(97 + index)}`, vault.id, name)),
  );
  const stale = devices[devices.length - 1]!;
  const active = devices.slice(0, -1);

  for (const device of devices) {
    for (let index = 0; index < 3; index += 1) await user_op(device, 0);
    await sync(device);
  }
  for (const device of devices) await sync(device);

  for (let round = 1; round <= ROUNDS; round += 1) {
    for (const device of active) {
      Object.assign(device.faults, {
        crash_before: Number(process.env.NEMU_SIM_CRASH ?? 0.04),
        crash_after: Number(process.env.NEMU_SIM_CRASH ?? 0.04),
        duplicate: Number(process.env.NEMU_SIM_DUPLICATE ?? 0.08),
      });
      const ops = 1 + Math.floor(random() * 3);
      for (let index = 0; index < ops; index += 1) await user_op(device, round);
    }
    const shared = pick(active);
    const shared_files = [...(await snapshot(shared)).keys()].filter((path) => path.endsWith(".md") && !path.includes("(conflict,"));
    if (shared_files.length > 0 && round % 3 === 0) {
      const path = pick(shared_files);
      for (const device of active) {
        const absolute = join(device.root, ...path.split("/"));
        const text = await readFile(absolute, "utf-8").catch(() => null);
        if (text === null) continue;
        const lines = text.split("\n");
        lines[Math.min(1, lines.length - 1)] = `same line edited by ${device.name} r${round}`;
        await writeFile(absolute, lines.join("\n"));
      }
    }
    await Promise.all(active.map((device) => sync(device)));
    process.stdout.write(`round ${round}: ${stats.runs} runs, ${stats.requests} requests, ${stats.merges} merges, ${stats.conflicts} conflicts\n`);
  }

  const before_stale = new Map<string, Buffer>();
  for (const [path, content] of await snapshot(active[0]!)) before_stale.set(path, content);
  await Promise.all(active.map((device) => sync(device)));
  const remote_pre = new Map<string, string[]>();
  for (const note of (await plain.notes()).notes) {
    if (!note.path.endsWith(".md")) continue;
    remote_pre.set(note.path, lines_of((await plain.read(note.path)).content));
  }
  const stale_files = [...(await snapshot(stale)).keys()].filter((path) => path.endsWith(".md"));
  const stale_edited: string[] = [];
  for (const path of stale_files.slice(0, 6)) {
    const absolute = join(stale.root, ...path.split("/"));
    const text = await readFile(absolute, "utf-8");
    await writeFile(absolute, `${text.trimEnd()}\nstale device edit ${token()}\n`);
    stale_edited.push(path);
  }
  await writeFile(join(stale.root, `Offline ${token()}.md`), "written while offline\n");
  let pruned = "forced in transport";
  if (PRUNE !== undefined) {
    const [command, ...args] = PRUNE.split(" ");
    execFileSync(command!, [...args, vault.id], { stdio: "inherit" });
    pruned = "pruned_revision raised in the database";
  } else {
    stale.faults.force_410 = true;
  }
  const stale_report = await sync(stale);
  check("stale device: the 410 led to a full reconcile", stale_report.full, { full: stale_report.full });
  let kept = 0;
  for (const path of stale_edited) {
    const before = remote_pre.get(path);
    if (before === undefined) {
      kept += 1;
      continue;
    }
    const after = lines_of((await plain.read(path).catch(() => ({ content: Buffer.alloc(0) }))).content);
    if (before.every((line) => after.includes(line))) kept += 1;
  }
  check(`stale device: ${kept}/${stale_edited.length} notes it edited still hold every line other devices wrote meanwhile`, kept === stale_edited.length);
  results.stale_device = {
    edited: stale_edited.length,
    remote_kept_in_head: kept,
    merged: stale_report.merged.length,
    conflicts: stale_report.conflicts.length,
    reconcile: pruned,
  };

  const convergence = await converge(devices, plain);
  check(`convergence: ${devices.length} devices and the server hold the same ${convergence.files} files`, convergence.converged);
  results.convergence = convergence;

  const corpus = await history_corpus(plain);
  const missing_lines = [...written_lines].filter((line) => !corpus.lines.has(line));
  const missing_hashes = [...written_hashes].filter((hash) => !corpus.hashes.has(hash));
  check(
    `every byte: ${written_lines.size} distinct Markdown lines and ${written_hashes.size} binary contents seen on any device are in the history (${corpus.versions} versions of ${corpus.notes} notes)`,
    missing_lines.length === 0 && missing_hashes.length === 0,
    { missing_lines: missing_lines.slice(0, 10), missing_hashes: missing_hashes.length },
  );
  results.every_byte = {
    recorded_snapshots: recorded_contents,
    distinct_lines: written_lines.size,
    binary_contents: written_hashes.size,
    versions_checked: corpus.versions,
    notes_checked: corpus.notes,
    missing_lines: missing_lines.length,
    missing_binaries: missing_hashes.length,
  };

  let marked = 0;
  let notes_scanned = 0;
  for (const device of devices) {
    for (const [path, content] of await snapshot(device)) {
      if (!path.endsWith(".md")) continue;
      notes_scanned += 1;
      if (has_conflict_markers(content.toString("utf-8"))) marked += 1;
    }
  }
  for (const note of (await plain.notes()).notes) {
    if (!note.path.endsWith(".md")) continue;
    notes_scanned += 1;
    if (has_conflict_markers((await plain.read(note.path)).content.toString("utf-8"))) marked += 1;
  }
  check(`no conflict markers in ${notes_scanned} notes on devices and server`, marked === 0, { marked });
  results.conflict_markers = { notes_scanned, with_markers: marked };

  const victim = devices[0]!;
  const live_before = (await plain.notes()).notes.length;
  for (const path of await walk(victim.root)) await rm(join(victim.root, ...path.split("/")), { force: true });
  const guard = await sync(victim, { record: false }).then(
    () => null,
    (error: unknown) => error,
  );
  const live_after = (await plain.notes()).notes.length;
  check(
    `mass-delete guard: emptying a folder of ${live_before} files stopped the sync and the vault still has ${live_after}`,
    guard instanceof CliError && guard.code === "mass_delete" && live_after === live_before,
    { guard: guard instanceof Error ? guard.message : guard },
  );
  await rm(victim.state_path, { force: true });
  const restored = await sync(victim, { record: false });
  const small = devices[1]!;
  const small_files = [...(await snapshot(small)).keys()];
  await rm(join(small.root, ...small_files[0]!.split("/")));
  const one_delete = await sync(small);
  check("mass-delete guard: one ordinary delete still goes through", one_delete.deleted_remote.length === 1);
  results.mass_delete = {
    folder_files: live_before,
    guard_fired: guard instanceof CliError && guard.code === "mass_delete",
    vault_files_after: live_after,
    restored_by_relink: restored.pulled.length,
    single_delete_allowed: one_delete.deleted_remote.length === 1,
  };

  const [a, b] = devices;
  await writeFile(join(a!.root, "Clash.md"), "clash from a\n");
  await writeFile(join(b!.root, "clash.md"), "clash from b\n");
  await sync(a!);
  const clash = await sync(b!);
  const nfd = "Café nfd.md";
  await writeFile(join(a!.root, nfd), "nfd name\n");
  for (const bad of ["CON.md", "aux.txt", "bad:name.md", "dot.md.", "space .md "]) {
    await writeFile(join(a!.root, bad), "should never leave this device\n");
  }
  const named = await sync(a!);
  const names_converged = await converge(devices, plain);
  const server_paths = (await plain.notes()).notes.map((note) => note.path);
  const clash_keys = server_paths.filter((path) => path.toLowerCase() === "clash.md");
  const clash_copy = server_paths.find((path) => path.toLowerCase().startsWith("clash (conflict,"));
  check(
    "case clash: one note keeps the path, the other version is a conflict copy",
    clash_keys.length === 1 && clash_copy !== undefined && clash.conflicts.length === 1,
    { clash_keys, clash_copy, conflicts: clash.conflicts },
  );
  check("NFD name is stored as NFC", server_paths.includes("Café nfd.md") && !server_paths.includes(nfd));
  const second_pass = await Promise.all(devices.map((device) => sync(device)));
  const churn = second_pass.reduce((total, report) => total + report.pulled.length + report.pushed.length, 0);
  check("NFD name causes no loop: a further pass moves nothing", churn === 0, { churn });
  const skipped = named.skipped.map((entry) => entry.path);
  const forbidden_on_server = server_paths.filter((path) => ["CON.md", "aux.txt", "bad:name.md", "dot.md.", "space .md "].includes(path));
  check(
    `Windows-reserved names: ${skipped.length} skipped and reported, ${forbidden_on_server.length} on the server`,
    forbidden_on_server.length === 0 && ["CON.md", "aux.txt", "bad:name.md", "dot.md."].every((path) => skipped.includes(path)),
    { skipped },
  );
  results.names = {
    case_clash: { notes_at_path: clash_keys.length, conflict_copy: clash_copy ?? null },
    nfd: { stored_as_nfc: server_paths.includes("Café nfd.md"), churn_after: churn },
    windows_reserved: { skipped, on_server: forbidden_on_server },
    converged: names_converged.converged,
  };
  const obsidian_on_server = server_paths.filter((path) => path.startsWith(".obsidian"));
  check("after the name cases every device still matches the server", names_converged.converged);
  check(".obsidian/workspace.json never reached the server", obsidian_on_server.length === 0, obsidian_on_server);

  results.stats = stats;
  results.failures = failures;
  await writeFile(join(ROOT!, "result.json"), JSON.stringify(results, null, 2));
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  process.stdout.write(failures.length === 0 ? "SIMULATION PASSED\n" : `SIMULATION FAILED: ${failures.join("; ")}\n`);
  process.exit(failures.length === 0 ? 0 : 1);
}

await main();
