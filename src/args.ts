export interface Args {
  positional: string[];
  flags: Record<string, string | boolean>;
}

const SHORT_WITH_VALUE = new Set(["w", "o", "d"]);

export function parse_args(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;

    if (token === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }

    if (token.startsWith("--")) {
      const body = token.slice(2);
      const equals = body.indexOf("=");
      if (equals !== -1) {
        flags[body.slice(0, equals)] = body.slice(equals + 1);
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        flags[body] = true;
        continue;
      }
      flags[body] = next;
      i += 1;
      continue;
    }

    if (token.startsWith("-") && token.length > 1) {
      const name = token.slice(1);
      const next = argv[i + 1];
      if (SHORT_WITH_VALUE.has(name) && next !== undefined && !next.startsWith("-")) {
        flags[name] = next;
        i += 1;
        continue;
      }
      flags[name] = true;
      continue;
    }

    positional.push(token);
  }

  return { positional, flags };
}

export function flag(args: Args, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = args.flags[name];
    if (typeof value === "string") return value;
  }
  return undefined;
}

export function bool_flag(args: Args, ...names: string[]): boolean {
  for (const name of names) {
    if (args.flags[name] === true) return true;
    const value = args.flags[name];
    if (value === "true") return true;
  }
  return false;
}

export function number_flag(
  args: Args,
  ...names: string[]
): number | undefined {
  const raw = flag(args, ...names);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`--${names[0]} must be a number, got "${raw}"`);
  }
  return value;
}

export function list_flag(args: Args, ...names: string[]): string[] | undefined {
  const raw = flag(args, ...names);
  if (raw === undefined) return undefined;
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

export function require_positional(
  args: Args,
  index: number,
  name: string,
): string {
  const value = args.positional[index];
  if (value === undefined || value === "") {
    throw new Error(`Missing required argument: ${name}`);
  }
  return value;
}
