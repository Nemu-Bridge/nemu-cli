import { watch, type FSWatcher } from "node:fs";
import { randomBytes } from "node:crypto";
import { acquire_lock } from "./lock.js";

export interface WatchOptions {
  root: string;
  run: () => Promise<void>;
  on_error: (error: unknown) => "continue" | "stop";
  debounce_ms?: number;
  interval_ms?: number;
  signal?: AbortSignal;
}

function is_own_file(name: string): boolean {
  const normalized = name.split("\\").join("/");
  return normalized === ".nemu" || normalized.startsWith(".nemu/") || normalized.endsWith(".nemu.tmp");
}

function open_watcher(root: string, on_change: (name: string) => void): { watcher: FSWatcher | null; recursive: boolean } {
  try {
    const watcher = watch(root, { recursive: true }, (_event, name) => on_change(name === null ? "" : String(name)));
    return { watcher, recursive: true };
  } catch {
    try {
      const watcher = watch(root, (_event, name) => on_change(name === null ? "" : String(name)));
      return { watcher, recursive: false };
    } catch {
      return { watcher: null, recursive: false };
    }
  }
}

export async function watch_folder(options: WatchOptions): Promise<void> {
  const lock = await acquire_lock(options.root, randomBytes(8).toString("hex"));
  const debounce_ms = options.debounce_ms ?? 2_500;
  let running = false;
  let again = false;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let finish: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    clearInterval(interval);
    opened.watcher?.close();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    finish();
  };

  const cycle = async () => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        try {
          await options.run();
        } catch (error) {
          if (options.on_error(error) === "stop") {
            stop();
            return;
          }
        }
      } while (again && !stopped);
    } finally {
      running = false;
    }
  };

  const schedule = () => {
    if (stopped) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void cycle();
    }, debounce_ms);
  };

  const opened = open_watcher(options.root, (name) => {
    if (name.length > 0 && is_own_file(name)) return;
    schedule();
  });
  const interval_ms = options.interval_ms ?? (opened.recursive ? 30_000 : 10_000);
  const interval = setInterval(() => void cycle(), interval_ms);

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  options.signal?.addEventListener("abort", stop);

  try {
    await cycle();
    await done;
    while (running) await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    await lock.release();
  }
}
