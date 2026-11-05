import { access } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import { run } from "../system.js";
import type { LoadResult } from "./api.js";

const MAX_GIT_CHECKS = 40;
const PATH_LIKE = /^[\w@.\-/\\]+$/;

interface Candidate {
  name: string;
  stale: boolean;
  refs: string[];
  commit: string | null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function candidates(loaded: LoadResult): Candidate[] {
  const entries = [
    ...(loaded.handoff !== null && loaded.handoff !== undefined ? [loaded.handoff] : []),
    ...(loaded.pinned ?? []),
  ].map((entry) => ({ name: entry.name, stale: entry.stale, refs: entry.refs, commit: entry.commit }));
  const indexed = (loaded.index ?? []).map((entry) => ({
    name: entry.name,
    stale: entry.stale,
    refs: entry.refs ?? [],
    commit: entry.commit ?? null,
  }));
  return [...entries, ...indexed];
}

async function ref_missing(root: string, ref: string): Promise<boolean | null> {
  const clean = ref.split(/[:#]/)[0]?.trim() ?? "";
  if (clean.length === 0 || !PATH_LIKE.test(clean) || isAbsolute(clean)) return null;
  if (!/[/\\.]/.test(clean)) return null;
  const resolved = normalize(join(root, clean));
  if (!resolved.startsWith(normalize(root))) return null;
  return !(await exists(resolved));
}

async function commit_gone(root: string, commit: string, budget: { left: number }): Promise<boolean | null> {
  if (budget.left <= 0) return null;
  budget.left -= 1;
  const result = await run("git", ["merge-base", "--is-ancestor", commit, "HEAD"], { cwd: root, timeout_ms: 3000 });
  if (result.code === 0) return false;
  if (result.code === 1) return true;
  return null;
}

export async function staleness(
  root: string,
  loaded: LoadResult,
  is_repository: boolean,
): Promise<{ stale: string[]; fresh: string[] }> {
  const stale: string[] = [];
  const fresh: string[] = [];
  const budget = { left: is_repository ? MAX_GIT_CHECKS : 0 };
  for (const entry of candidates(loaded)) {
    const verdicts: (boolean | null)[] = [];
    for (const ref of entry.refs.slice(0, 8)) verdicts.push(await ref_missing(root, ref));
    if (entry.commit !== null) verdicts.push(await commit_gone(root, entry.commit, budget));
    const known = verdicts.filter((verdict): verdict is boolean => verdict !== null);
    if (known.length === 0) continue;
    const now_stale = known.some((verdict) => verdict);
    if (now_stale && !entry.stale) stale.push(entry.name);
    if (!now_stale && entry.stale) fresh.push(entry.name);
  }
  return { stale, fresh };
}
