// What the CLI and serve mode share: where the wrappers live, turning user input into a
// command line, and the warnings shown for a shortcut.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { accelLabel, bindingProblem, bindingWarning } from "./accel.ts";
import { commandFromArgv, commandFromLine, commandProgram } from "./command.ts";
import type { CommandContext } from "./command.ts";
import { conflictsFor } from "./conflicts.ts";
import type { BindingUse } from "./conflicts.ts";
import { GnomeError } from "./gnome.ts";
import { groupProblem, joinGroup, splitPrefix } from "./groups.ts";
import { readToolCommands } from "./suggestions.ts";
import type { ToolCommands } from "./suggestions.ts";

/** tools/ (this tool's parent directory). */
export const TOOLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface Env {
  home: string;
  /** ~/.local/bin, absolute: where install.sh writes the wrappers. */
  binDir: string;
  toolsDir: string;
  exists: (p: string) => boolean;
}

export function defaultEnv(): Env {
  const home = os.homedir();
  return { home, binDir: path.join(home, ".local", "bin"), toolsDir: TOOLS_DIR, exists: fs.existsSync };
}

export function loadTools(env: Env): ToolCommands {
  return readToolCommands(env.toolsDir, env.binDir, env.exists);
}

export function commandContext(env: Env, tools: ToolCommands): CommandContext {
  return { binDir: env.binDir, home: env.home, bins: new Set(tools.bins) };
}

/** A string is one command line; an array is an argv (a suggestion, or the CLI after `--`). */
export function buildCommand(input: unknown, ctx: CommandContext): string {
  try {
    if (Array.isArray(input) && input.every((x) => typeof x === "string")) {
      return input.length === 1 ? commandFromLine(input[0]!, ctx) : commandFromArgv(input, ctx);
    }
    if (typeof input === "string") return commandFromLine(input, ctx);
  } catch (e) {
    throw new GnomeError((e as Error).message);
  }
  throw new GnomeError("command must be a string or an array of strings");
}

export function checkBinding(binding: unknown): string {
  if (typeof binding !== "string") throw new GnomeError("binding must be a string");
  const b = binding.trim();
  const p = bindingProblem(b);
  if (p) throw new GnomeError(p);
  return b;
}

/**
 * The name to store when a group is given ("<Group>: <name>"; "" = no group). Without a new
 * name (an edit that only changes the group), the current name's old prefix is replaced.
 */
export function groupedName(group: unknown, name: string | undefined, current = ""): string {
  if (typeof group !== "string") throw new GnomeError("group must be a string");
  const p = groupProblem(group);
  if (p) throw new GnomeError(p);
  const base = name ?? splitPrefix(current)?.rest ?? current;
  return joinGroup(group, base);
}

/** Text for a missing program, or "" (absolute paths only; a bare name is looked up on PATH). */
export function missingProgram(command: string, exists: (p: string) => boolean): string {
  const p = commandProgram(command);
  return p && p.startsWith("/") && !exists(p) ? `${p} doesn't exist${p.includes("/.local/bin/") ? " (run ./install.sh to write the tool wrappers)" : ""}.` : "";
}

/** Everything worth telling the user about a shortcut that still gets saved. */
export function warningsFor(binding: string, command: string, uses: readonly BindingUse[], env: Env, selfId?: string): string[] {
  const out: string[] = [];
  const c = conflictsFor(binding, uses, selfId);
  if (c.length) out.push(`${accelLabel(binding)} is also used by ${c.join(", ")}.`);
  const w = bindingWarning(binding);
  if (w) out.push(w);
  const m = missingProgram(command, env.exists);
  if (m) out.push(m);
  return out;
}
