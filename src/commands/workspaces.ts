import {
  bool_flag,
  flag,
  number_flag,
  require_positional,
  type Args,
} from "../args.js";
import { client, resolve_workspace } from "../session.js";
import { detail, done, table } from "../output.js";

const COLUMNS = ["id", "name", "budget", "created_at"];

export async function workspaces(args: Args): Promise<number> {
  const action = args.positional[0] ?? "list";
  const nemu = await client();

  if (action === "list") {
    const rows = await nemu.workspaces.list();
    table(
      rows.map((row) => ({ ...row })),
      bool_flag(args, "stats") ? [...COLUMNS, "stats"] : COLUMNS,
      "No workspaces.",
    );
    return 0;
  }

  if (action === "get") {
    const id = require_positional(args, 1, "workspace id");
    const workspace = await nemu.workspaces.get(id);
    detail({ ...workspace }, workspace.name);
    return 0;
  }

  if (action === "create") {
    const name = flag(args, "name") ?? require_positional(args, 1, "name");
    const workspace = await nemu.workspaces.create({ name });
    done(`Created workspace ${workspace.name}`, { ...workspace });
    return 0;
  }

  if (action === "rename" || action === "update") {
    const id = require_positional(args, 1, "workspace id");
    const name = flag(args, "name") ?? require_positional(args, 2, "new name");
    const workspace = await nemu.workspaces.get(id);
    await workspace.update({ name });
    done(`Renamed to ${name}`, { ...workspace });
    return 0;
  }

  if (action === "delete") {
    const id = require_positional(args, 1, "workspace id");
    if (!bool_flag(args, "yes", "y")) {
      throw new Error(
        "Deleting a workspace removes everything in it. Pass --yes to confirm.",
      );
    }
    const workspace = await nemu.workspaces.get(id);
    await workspace.delete();
    done(`Deleted workspace ${id}`);
    return 0;
  }

  if (action === "budget") {
    const workspace = await resolve_workspace(
      nemu,
      args.positional[1] ?? flag(args, "workspace", "w"),
    );
    const budget = await workspace.get_budget();
    detail({ workspace: workspace.name, ...budget }, "Budget");
    return 0;
  }

  if (action === "set-budget") {
    const workspace = await resolve_workspace(
      nemu,
      flag(args, "workspace", "w") ?? args.positional[1],
    );
    const amount =
      number_flag(args, "amount") ??
      Number(args.positional[2] ?? args.positional[1]);
    if (!Number.isFinite(amount)) {
      throw new Error("Pass the new budget, for example: set-budget <id> 50");
    }
    const applied = await workspace.set_budget(amount);
    done(`Budget for ${workspace.name} is now ${applied}`, {
      workspace_id: workspace.id,
      budget: applied,
    });
    return 0;
  }

  if (action === "gateway-key") {
    throw new Error(
      "Minting a gateway key needs a confidential client, so the CLI cannot do it. Use the console.",
    );
  }

  throw new Error(`Unknown workspaces action "${action}".`);
}

const MEMBER_COLUMNS = ["id", "user_id", "email", "role", "created_at"];

export async function members(args: Args): Promise<number> {
  const action = args.positional[0] ?? "list";
  const nemu = await client();
  const workspace = await resolve_workspace(
    nemu,
    flag(args, "workspace", "w"),
  );

  if (action === "list") {
    const rows = await workspace.members.list();
    table(
      rows.map((row) => ({ ...row })),
      MEMBER_COLUMNS,
      "No members.",
    );
    return 0;
  }

  if (action === "invite") {
    const emails = flag(args, "email", "emails");
    const invitation = await workspace.members.invite({
      restricted_to:
        emails === undefined
          ? undefined
          : emails.split(",").map((entry) => entry.trim()),
      max_uses: number_flag(args, "max-uses"),
      expires_in_days: number_flag(args, "expires-in-days", "expires"),
    });
    detail({ ...invitation }, "Invitation");
    return 0;
  }

  if (action === "role") {
    const member_id = require_positional(args, 1, "member id");
    const role = (
      flag(args, "role") ?? require_positional(args, 2, "role")
    ).toUpperCase();
    if (role !== "ADMIN" && role !== "MEMBER") {
      throw new Error('Role must be ADMIN or MEMBER.');
    }
    const list = await workspace.members.list();
    const member = list.find((entry) => entry.id === member_id);
    if (!member) throw new Error(`No member ${member_id} in ${workspace.name}.`);
    await member.update_role(role);
    done(`${member_id} is now ${role}`);
    return 0;
  }

  if (action === "remove") {
    const member_id = require_positional(args, 1, "member id");
    const list = await workspace.members.list();
    const member = list.find((entry) => entry.id === member_id);
    if (!member) throw new Error(`No member ${member_id} in ${workspace.name}.`);
    await member.remove();
    done(`Removed ${member_id} from ${workspace.name}`);
    return 0;
  }

  throw new Error(`Unknown members action "${action}".`);
}
