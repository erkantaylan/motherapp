// Plain subcommands for terminals and scripts; they talk to gsettings/dconf directly and work
// without the core (the page picks changes up within a few seconds).
import type { Writable } from "node:stream";
import { accelLabel } from "./accel.ts";
import { bindingUses, conflictsFor } from "./conflicts.ts";
import { Gnome, GnomeError } from "./gnome.ts";
import { groupOf, groupShortcuts, plural } from "./groups.ts";
import type { Shortcut } from "./gnome.ts";
import { buildCommand, checkBinding, commandContext, groupedName, loadTools, warningsFor } from "./ops.ts";
import type { Env } from "./ops.ts";
import type { Runner } from "./runner.ts";

export const USAGE = `usage: shortcutsctl <command> [args]

  list [--flat] [--json]                every GNOME custom shortcut: name, key, command
                                        (* = made by motherapp, editable; the rest are read-only),
                                        grouped like the page: a "Group: " name prefix, the
                                        tool, or the same program. --flat: ungrouped, in GNOME's
                                        order. --json: each one gets "group" (a name or null)
  add [--group <g>] <name> <binding> -- <command…>
                                        add a motherapp shortcut; --group names it "<g>: <name>"
  edit <name> [--name <new>] [--group <g>] [--binding <b>] [-- <command…>]
                                        change a motherapp shortcut (--group "" takes it out
                                        of its group)
  remove <name>                         remove a motherapp shortcut
  suggestions [--json]                  commands the tools suggest binding to keys
  serve                                 JSON-RPC serve mode (started by the motherapp core)

<binding> is GNOME accelerator syntax: '<Control><Shift>F9', '<Super>m', '<Alt>KP_Add'.
<command…> after "--": several words are one argv; a single word is read as a command line
(shell syntax such as | or $ gets it wrapped in sh -c). A tool command such as audioctl is
written with its ~/.local/bin path, because GNOME doesn't search your shell's PATH.
<name> may also be the path segment shown by "list --json" (motherapp-…).

Exit codes: 0 ok (conflicts are warnings on stderr), 1 gsettings failed, no such shortcut,
not a motherapp shortcut or a duplicate name, 2 usage error.`;

export interface CliIO {
  runner: Runner;
  env: Env;
  stdout: Writable;
  stderr: Writable;
}

class UsageError extends Error {}

const line = (out: Writable, s = "") => out.write(s + "\n");

function splitDashDash(args: string[]): [string[], string[] | undefined] {
  const i = args.indexOf("--");
  return i < 0 ? [args, undefined] : [args.slice(0, i), args.slice(i + 1)];
}

/** Pulls `--group <g>` out of the arguments before "--". */
function takeGroup(args: string[]): [string[], string | undefined] {
  const i = args.indexOf("--group");
  if (i < 0) return [args, undefined];
  const v = args[i + 1];
  if (v === undefined) throw new UsageError("--group needs a value");
  const rest = [...args.slice(0, i), ...args.slice(i + 2)];
  if (rest.includes("--group")) throw new UsageError("--group given twice");
  return [rest, v];
}

function find(list: Shortcut[], name: string): Shortcut {
  const owned = list.filter((s) => s.owned);
  const byName = owned.filter((s) => s.name === name);
  const hit = byName[0] ?? owned.find((s) => s.id === name || s.path === name) ?? owned.find((s) => s.name.toLowerCase() === name.toLowerCase());
  if (hit) return hit;
  const foreign = list.find((s) => !s.owned && (s.name === name || s.id === name || s.path === name));
  if (foreign) throw new GnomeError(`'${foreign.name}' wasn't made by motherapp, so shortcutsctl won't change it. Use GNOME Settings.`);
  throw new GnomeError(`no motherapp shortcut named '${name}'`);
}

export async function runCli(argv: string[], io: CliIO): Promise<number> {
  const [cmd, ...args] = argv;
  const gnome = new Gnome({ runner: io.runner });
  const warn = (ws: string[]) => ws.forEach((w) => line(io.stderr, `shortcutsctl: warning: ${w}`));
  try {
    switch (cmd) {
      case "list": {
        const bad = args.find((a) => a !== "--json" && a !== "--flat");
        if (bad !== undefined) throw new UsageError(`unknown option "${bad}"`);
        const list = await gnome.list();
        const builtins = await gnome.builtins();
        const uses = bindingUses(list, builtins);
        const rows = list.map((s) => ({ ...s, conflicts: conflictsFor(s.binding, uses, s.id) }));
        type R = (typeof rows)[number];
        const { binTools } = loadTools(io.env);
        const mine = groupShortcuts(rows.filter((r) => r.owned), binTools);
        const theirs = groupShortcuts(rows.filter((r) => !r.owned), binTools);
        if (args.includes("--json")) {
          const group = new Map([...groupOf(mine), ...groupOf(theirs)]);
          line(io.stdout, JSON.stringify(rows.map((r) => ({ ...r, group: group.get(r.id) ?? null })), null, 2));
          return 0;
        }
        if (list.length === 0) {
          line(io.stdout, "No custom shortcuts.");
          return 0;
        }
        const tail = (s: R) => (s.error ? `  (can't read: ${s.error})` : s.conflicts.length ? `  (also: ${s.conflicts.join(", ")})` : "");
        // --flat: GNOME's order, as before. Otherwise motherapp's own first, then the rest, each
        // group's rows indented under a header line.
        const out: ({ head: string } | { row: R; label: string })[] = [];
        if (args.includes("--flat")) out.push(...rows.map((row) => ({ row, label: row.name })));
        else {
          for (const e of [...mine, ...theirs]) {
            if (e.kind === "single") {
              out.push({ row: e.item, label: e.label });
              continue;
            }
            const extra = [plural(e.members.length, "shortcut"), e.keys, e.conflicts ? plural(e.conflicts, "conflict") : ""].filter(Boolean);
            out.push({ head: `${e.members[0]!.item.owned ? "*" : " "} ${e.name}  (${extra.join(", ")})` });
            for (const m of e.members) out.push({ row: m.item, label: `  ${m.label}` });
          }
        }
        const rowsOut = out.filter((o): o is { row: R; label: string } => "row" in o);
        const wn = Math.max(...rowsOut.map((o) => o.label.length));
        const wb = Math.max(...rowsOut.map((o) => o.row.binding.length));
        for (const o of out) {
          if ("head" in o) line(io.stdout, o.head);
          else line(io.stdout, `${o.row.owned ? "*" : " "} ${o.label.padEnd(wn)}  ${o.row.binding.padEnd(wb)}  ${o.row.command}${tail(o.row)}`);
        }
        return 0;
      }
      case "add": {
        const [all, command] = splitDashDash(args);
        const [pos, group] = takeGroup(all);
        if (pos.length !== 2) throw new UsageError(pos.length < 2 ? "add needs <name> and <binding>" : "add takes <name> <binding> -- <command…> (quote names with spaces)");
        if (!command || command.length === 0) throw new UsageError('add needs the command after "--"');
        const binding = checkBinding(pos[1]);
        const name = group === undefined ? pos[0]! : groupedName(group, pos[0]!);
        const c = buildCommand(command, commandContext(io.env, loadTools(io.env)));
        const uses = bindingUses(await gnome.list(), await gnome.builtins());
        warn(warningsFor(binding, c, uses, io.env));
        const s = await gnome.add({ name, binding, command: c });
        line(io.stdout, `added '${s.name}' (${accelLabel(binding)}): ${c}`);
        return 0;
      }
      case "edit": {
        const [all, command] = splitDashDash(args);
        const [pos, group] = takeGroup(all);
        const fields: { name?: string; binding?: string; command?: string } = {};
        const rest: string[] = [];
        for (let i = 0; i < pos.length; i++) {
          const a = pos[i]!;
          if (a === "--name" || a === "--binding") {
            const v = pos[++i];
            if (v === undefined) throw new UsageError(`${a} needs a value`);
            if (a === "--name") fields.name = v;
            else fields.binding = checkBinding(v);
          } else if (a.startsWith("--")) throw new UsageError(`unknown option "${a}"`);
          else rest.push(a);
        }
        if (rest.length !== 1) throw new UsageError(rest.length === 0 ? "edit needs the shortcut's name" : "edit takes one name (quote names with spaces)");
        if (command !== undefined) {
          if (command.length === 0) throw new UsageError('nothing after "--"');
          fields.command = buildCommand(command, commandContext(io.env, loadTools(io.env)));
        }
        if (Object.keys(fields).length === 0 && group === undefined) throw new UsageError("nothing to change: give --name, --group, --binding or -- <command…>");
        const list = await gnome.list();
        const s = find(list, rest[0]!);
        if (group !== undefined) fields.name = groupedName(group, fields.name, s.name);
        warn(warningsFor(fields.binding ?? s.binding, fields.command ?? s.command, bindingUses(list, await gnome.builtins()), io.env, s.id));
        await gnome.edit(s.path, fields);
        line(io.stdout, `changed '${fields.name ?? s.name}'`);
        return 0;
      }
      case "remove": {
        if (args.length !== 1 || args[0] === "") throw new UsageError(args.length === 0 ? "remove needs the shortcut's name" : "remove takes one name (quote names with spaces)");
        const s = find(await gnome.list(), args[0]!);
        await gnome.remove(s.path);
        line(io.stdout, `removed '${s.name}'`);
        return 0;
      }
      case "suggestions": {
        const bad = args.find((a) => a !== "--json");
        if (bad !== undefined) throw new UsageError(`unknown option "${bad}"`);
        const { suggestions } = loadTools(io.env);
        if (args.includes("--json")) {
          line(io.stdout, JSON.stringify(suggestions, null, 2));
          return 0;
        }
        const w = Math.max(0, ...suggestions.map((s) => s.title.length));
        for (const s of suggestions) line(io.stdout, `${s.title.padEnd(w)}  ${s.command}${s.installed ? "" : "  (wrapper not installed)"}`);
        return 0;
      }
      case undefined:
      case "help":
      case "-h":
      case "--help":
        line(cmd === undefined ? io.stderr : io.stdout, USAGE);
        return cmd === undefined ? 2 : 0;
      default:
        throw new UsageError(`unknown command "${cmd}"`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      line(io.stderr, `shortcutsctl: ${e.message}\n\n${USAGE}`);
      return 2;
    }
    line(io.stderr, `shortcutsctl: ${(e as Error).message}`);
    return 1;
  }
}
