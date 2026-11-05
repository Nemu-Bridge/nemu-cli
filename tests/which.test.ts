import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { which } from "../src/system.js";

const original_path = process.env.PATH;
const original_cwd = process.cwd();

afterEach(() => {
  process.env.PATH = original_path;
  process.chdir(original_cwd);
});

async function executable(directory: string, name: string): Promise<string> {
  const file = join(directory, name);
  await writeFile(file, "#!/bin/sh\nexit 0\n");
  await chmod(file, 0o755);
  return file;
}

describe("which", () => {
  test("ignores relative PATH entries, so the working directory is never searched", async () => {
    const planted = await mkdtemp(join(tmpdir(), "nemu-which-"));
    await executable(planted, "nemu-probe-tool");
    process.chdir(planted);
    process.env.PATH = [".", ""].join(delimiter);
    expect(await which("nemu-probe-tool")).toBeNull();
  });

  test.skipIf(process.platform === "win32")("finds a command in an absolute PATH entry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nemu-which-"));
    const file = await executable(directory, "nemu-probe-tool");
    process.env.PATH = directory;
    expect(await which("nemu-probe-tool")).toBe(file);
  });
});
