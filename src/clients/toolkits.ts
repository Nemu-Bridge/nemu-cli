import { flag, bool_flag, type Args } from "../args.js";
import { read_settings, update_settings, TOOLKITS, type Toolkit } from "../config.js";
import { CliError } from "../errors.js";
import { confirm, dim, is_interactive, out } from "../ui.js";

const DESCRIPTIONS: Record<Toolkit, string> = {
  context: "Context: project memory, handoffs and agents talking to each other",
  studio: "Studio: build 3D models and animations, preview them and export GLB",
};

function is_toolkit(value: string): value is Toolkit {
  return TOOLKITS.some((toolkit) => toolkit === value);
}

function parsed_flag(raw: string): Toolkit[] {
  const names = raw
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0);
  const wanted = names.map((name) => (name === "all" ? [...TOOLKITS] : [name])).flat();
  const unknown = wanted.filter((name) => !is_toolkit(name));
  if (unknown.length > 0) {
    throw new CliError(
      `Unknown toolkit ${unknown.join(", ")}. Choose from: ${TOOLKITS.join(", ")}, or all.`,
      "unknown_toolkit",
    );
  }
  const chosen = TOOLKITS.filter((toolkit) => wanted.includes(toolkit));
  if (chosen.length === 0) throw new CliError("Choose at least one toolkit.", "no_toolkit");
  return chosen;
}

export async function choose_toolkits(args: Args, client: string, label: string): Promise<Toolkit[]> {
  const given = flag(args, "toolkits");
  const existing = (await read_settings()).toolkits?.[client];
  const chosen = await (async (): Promise<Toolkit[]> => {
    if (given !== undefined) return parsed_flag(given);
    if (bool_flag(args, "yes", "y") || !is_interactive()) return existing ?? [...TOOLKITS];
    out();
    out(`  Which Nemu toolkits should ${label} get?`);
    const picked: Toolkit[] = [];
    for (const toolkit of TOOLKITS) {
      if (await confirm(DESCRIPTIONS[toolkit], existing === undefined || existing.includes(toolkit))) {
        picked.push(toolkit);
      }
    }
    if (picked.length > 0) return picked;
    out(dim("  No toolkit chosen, so both are added. Remove one later with --toolkits."));
    return [...TOOLKITS];
  })();
  const settings = await read_settings();
  await update_settings({ toolkits: { ...(settings.toolkits ?? {}), [client]: chosen } });
  return chosen;
}

export function toolkit_line(toolkits: Toolkit[]): string {
  return toolkits.map((toolkit) => DESCRIPTIONS[toolkit].split(":")[0]).join(" and ");
}
