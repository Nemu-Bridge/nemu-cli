import spawn from "cross-spawn";
import { access, constants } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

const MAX_OUTPUT = 4 * 1024 * 1024;

const NOT_FOUND: RunResult = { code: 127, stdout: "", stderr: "" };

async function resolve_command(command: string): Promise<string | null> {
  if (process.platform !== "win32") return command;
  if (/[\\/]/.test(command)) return isAbsolute(command) ? command : null;
  return which(command);
}

export async function run(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeout_ms?: number; cwd?: string } = {},
): Promise<RunResult> {
  const resolved = await resolve_command(command);
  if (resolved === null) return NOT_FOUND;
  return new Promise((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf-8"),
        stderr: Buffer.concat(stderr).toString("utf-8"),
      });
    };
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      if (size >= MAX_OUTPUT) return;
      size += chunk.length;
      target.push(chunk);
    };
    const child = spawn(resolved, args, {
      env: options.env ?? process.env,
      cwd: options.cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill();
      finish(127);
    }, options.timeout_ms ?? 30_000);
    child.stdout?.on("data", collect(stdout));
    child.stderr?.on("data", collect(stderr));
    child.on("error", () => finish(127));
    child.on("close", (code) => finish(code ?? 127));
  });
}

export async function launch(command: string, args: string[]): Promise<number> {
  const resolved = await resolve_command(command);
  if (resolved === null) return 127;
  return new Promise((resolve) => {
    const child = spawn(resolved, args, { stdio: "inherit" });
    child.on("error", () => resolve(127));
    child.on("exit", (code, signal) => resolve(code ?? (signal !== null ? 1 : 0)));
  });
}

export async function which(name: string): Promise<string | null> {
  const extensions =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    const directory = entry.replace(/^"(.*)"$/, "$1");
    if (directory.length === 0 || !isAbsolute(directory)) continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension.toLowerCase()}`);
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        continue;
      }
    }
  }
  return null;
}
