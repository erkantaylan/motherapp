// Plain subcommands for terminals and scripts; they talk to gsettings/dconf directly and work
// without the core (the page picks changes up within a few seconds).
import type { Writable } from "node:stream";
import { accelLabel } from "./accel.ts";
import { bindingUses, conflictsFor } from "./conflicts.ts";
import { Gnome, GnomeError } from "./gnome.ts";
import type { Shortcut } from "./gnome.ts";
import { buildCommand, checkBinding, commandContext, loadTools, warningsFor } from "./ops.ts";
import type { Env } from "./ops.ts";
import type { Runner } from "./runner.ts";

export const USAGE = `usage: shortcutsctl <command> [args]

  list [--json]                         every GNOME custom shortcut: name, key, command
                                        (* = made by motherapp, editable; the rest are read-only)
  add <name> <binding> -- <command…>    add a motherapp shortcut
  edit <name> [--name <new>] [--binding <b>] [-- <command…>]
                                        change a motherapp shortcut
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
        const bad = args.find((a) => a !== "--json");
        if (bad !== undefined) throw new UsageError(`unknown option "${bad}"`);
        const list = await gnome.list();
        const builtins = await gnome.builtins();
        const uses = bindingUses(list, builtins);
        if (args.includes("--json")) {
          line(io.stdout, JSON.stringify(list.map((s) => ({ ...s, conflicts: conflictsFor(s.binding, uses, s.id) })), null, 2));
          return 0;
        }
        if (list.length === 0) {
          line(io.stdout, "No custom shortcuts.");
          return 0;
        }
        const wn = Math.max(...list.map((s) => s.name.length));
        const wb = Math.max(...list.map((s) => s.binding.length));
        for (const s of list) {
          const c = conflictsFor(s.binding, uses, s.id);
          const tail = s.error ? `  (can't read: ${s.error})` : c.length ? `  (also: ${c.join(", ")})` : "";
          line(io.stdout, `${s.owned ? "*" : " "} ${s.name.padEnd(wn)}  ${s.binding.padEnd(wb)}  ${s.command}${tail}`);
        }
        return 0;
      }
      case "add": {
        const [pos, command] = splitDashDash(args);
        if (pos.length !== 2) throw new UsageError(pos.length < 2 ? "add needs <name> and <binding>" : "add takes <name> <binding> -- <command…> (quote names with spaces)");
        if (!command || command.length === 0) throw new UsageError('add needs the command after "--"');
        const binding = checkBinding(pos[1]);
        const c = buildCommand(command, commandContext(io.env, loadTools(io.env)));
        const uses = bindingUses(await gnome.list(), await gnome.builtins());
        warn(warningsFor(binding, c, uses, io.env));
        const s = await gnome.add({ name: pos[0]!, binding, command: c });
        line(io.stdout, `added '${s.name}' (${accelLabel(binding)}): ${c}`);
        return 0;
      }
      case "edit": {
        const [pos, command] = splitDashDash(args);
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
        if (Object.keys(fields).length === 0) throw new UsageError("nothing to change: give --name, --binding or -- <command…>");
        const list = await gnome.list();
        const s = find(list, rest[0]!);
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
