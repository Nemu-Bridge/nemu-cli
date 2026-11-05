import { execFile } from "node:child_process";
import { basename } from "node:path";

export interface RepositoryInfo {
  root: string;
  name: string;
  root_commit?: string;
  remote_url?: string;
  branch?: string;
  head?: string;
}

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, timeout: 4000, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error !== null) {
          resolve(null);
          return;
        }
        const value = stdout.toString().trim();
        resolve(value.length > 0 ? value : null);
      },
    );
  });
}

const COMMIT = /^[0-9a-f]{40}$/;

export async function repository(cwd: string): Promise<RepositoryInfo> {
  const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (root === null) return { root: cwd, name: basename(cwd) || "project" };

  const [roots, remote, branch, head] = await Promise.all([
    git(root, ["rev-list", "--max-parents=0", "HEAD"]),
    git(root, ["remote", "get-url", "origin"]),
    git(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(root, ["rev-parse", "HEAD"]),
  ]);

  const root_commit = roots
    ?.split("\n")
    .map((line) => line.trim())
    .filter((line) => COMMIT.test(line))
    .sort()[0];

  return {
    root,
    name: basename(root) || "project",
    root_commit,
    remote_url: remote ?? undefined,
    branch: branch !== null && branch !== "HEAD" ? branch : undefined,
    head: head !== null && COMMIT.test(head) ? head : undefined,
  };
}
