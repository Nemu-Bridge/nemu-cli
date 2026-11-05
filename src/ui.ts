import { spawn } from "node:child_process";

const SUPPORTS_COLOR =
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== "dumb" &&
  process.stdout.isTTY === true;

function paint(code: string, value: string): string {
  return SUPPORTS_COLOR ? `[${code}m${value}[0m` : value;
}

export const dim = (value: string) => paint("2", value);
export const bold = (value: string) => paint("1", value);
export const green = (value: string) => paint("32", value);
export const red = (value: string) => paint("31", value);
export const cyan = (value: string) => paint("36", value);

export function out(line = ""): void {
  process.stdout.write(`${line}\n`);
}

export function fail(message: string): void {
  process.stderr.write(`${red("Error")} ${message}\n`);
}

export function success(message: string): void {
  out(`${green("✓")} ${message}`);
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function spinner(label: string): { stop: () => void } {
  if (process.stdout.isTTY !== true) {
    out(`  ${label}`);
    return { stop: () => {} };
  }

  let index = 0;
  const timer = setInterval(() => {
    process.stdout.write(`\r  ${dim(FRAMES[index % FRAMES.length]!)} ${label}`);
    index += 1;
  }, 90);

  return {
    stop: () => {
      clearInterval(timer);
      process.stdout.write(`\r${" ".repeat(label.length + 6)}\r`);
    },
  };
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function safe_browser_url(url: string, expected_origin: string): string | null {
  try {
    const parsed = new URL(url);
    const is_secure =
      parsed.protocol === "https:" ||
      (parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname));
    if (!is_secure) return null;
    if (parsed.origin !== new URL(expected_origin).origin) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

export function open_browser(url: string, expected_origin: string): boolean {
  const target = safe_browser_url(url, expected_origin);
  if (target === null) return false;
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "rundll32"
        : "xdg-open";
  const args =
    process.platform === "win32" ? ["url.dll,FileProtocolHandler", target] : [target];

  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export function is_interactive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

export async function confirm(question: string, fallback: boolean): Promise<boolean> {
  if (!is_interactive()) return fallback;
  const { createInterface } = await import("node:readline/promises");
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await reader.question(`  ${question} ${fallback ? "[Y/n]" : "[y/N]"} `))
      .trim()
      .toLowerCase();
    if (answer.length === 0) return fallback;
    return answer === "y" || answer === "yes";
  } finally {
    reader.close();
  }
}

export async function ask_secret(question: string): Promise<string> {
  const input = process.stdin;
  process.stdout.write(`  ${question} `);
  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error: Error | null) => {
      input.setRawMode(false);
      input.pause();
      input.removeListener("data", on_data);
      process.stdout.write("\n");
      if (error === null) resolve(value);
      else reject(error);
    };
    const on_data = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") return finish(null);
        if (character === "\u0003") return finish(new Error("Cancelled."));
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= " ") value += character;
      }
    };
    input.on("data", on_data);
  });
}
