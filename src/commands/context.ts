import { writeFile } from "node:fs/promises";
import { flag, number_flag, type Args } from "../args.js";
import { CliError } from "../errors.js";
import { export_all, list_projects, load_project, search_project } from "../context/api.js";
import { current_project } from "../context/project.js";
import { bold, dim, out, success } from "../ui.js";
import { emit, is_json_mode, table } from "../output.js";

export async function context(args: Args): Promise<number> {
  const action = args.positional[0] ?? "load";
  switch (action) {
    case "load": {
      const project = await current_project(process.cwd(), false);
      const loaded = await load_project(project.id, project.repository.branch);
      if (is_json_mode()) {
        emit(loaded);
        return 0;
      }
      out(loaded.text);
      return 0;
    }
    case "search": {
      const query = args.positional.slice(1).join(" ").trim();
      if (query.length === 0) throw new CliError("Use: nemu context search <words>", "invalid_arguments");
      const project = await current_project(process.cwd());
      const entries = await search_project(project.id, query, number_flag(args, "limit") ?? 10);
      if (is_json_mode()) {
        emit(entries);
        return 0;
      }
      if (entries.length === 0) {
        out(dim(`  Nothing saved matches "${query}".`));
        return 0;
      }
      for (const entry of entries) {
        out(`  ${bold(entry.name)}  ${entry.subject}`);
        out(dim(`    ${entry.body}`));
      }
      return 0;
    }
    case "projects": {
      const projects = await list_projects();
      table(
        projects.map((project) => ({
          id: project.id,
          name: project.name,
          remote: project.remote_url ?? "",
          notes: project.entry_count ?? 0,
        })),
        ["id", "name", "remote", "notes"],
        "No Context projects yet.",
      );
      return 0;
    }
    case "export": {
      const data = await export_all();
      const path = flag(args, "out", "o");
      if (path === undefined) {
        emit(data);
        return 0;
      }
      await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
      success(`Exported to ${path}`);
      return 0;
    }
    default:
      throw new CliError(
        "Use: nemu context load | search <words> | projects | export [--out file]",
        "invalid_arguments",
      );
  }
}
