// Suggested commands: each tool's manifest may list, per `bin` command, a few invocations
// worth binding to a key (docs/extension-contract.md, "commands"):
//
//   "bin": { "audioctl": "audioctl.ts" },
//   "commands": { "audioctl": [{ "title": "Mute Firefox", "args": ["app-mute", "firefox", "toggle"] }] }
//
// The core ignores the field; only this tool reads it.
import * as fs from "node:fs";
import * as path from "node:path";
import { joinArgv } from "./command.ts";

export interface Suggestion {
  [k: string]: string | boolean | string[];
  tool: string;
  toolTitle: string;
  bin: string;
  title: string;
  args: string[];
  /** The command line GNOME will run: the wrapper's absolute path plus the quoted args. */
  command: string;
  /** Whether ~/.local/bin/<bin> exists (install.sh writes it). */
  installed: boolean;
}

export interface ToolCommands {
  suggestions: Suggestion[];
  /** Every `bin` command of every tool, for turning "audioctl …" into its absolute path. */
  bins: string[];
  /** Problems with manifests, for the log. */
  problems: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function readToolCommands(toolsDir: string, binDir: string, exists: (p: string) => boolean = fs.existsSync): ToolCommands {
  const suggestions: Suggestion[] = [];
  const bins: string[] = [];
  const problems: string[] = [];
  let dirs: string[];
  try {
    dirs = fs.readdirSync(toolsDir).sort();
  } catch (e) {
    return { suggestions, bins, problems: [`can't read ${toolsDir}: ${(e as Error).message}`] };
  }
  for (const d of dirs) {
    const file = path.join(toolsDir, d, "manifest.json");
    if (!exists(file)) continue;
    let m: unknown;
    try {
      m = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      problems.push(`tools/${d}/manifest.json: ${(e as Error).message}`);
      continue;
    }
    if (!isObj(m) || !isObj(m.bin)) continue;
    const toolId = typeof m.id === "string" ? m.id : d;
    const toolTitle = typeof m.title === "string" ? m.title : toolId;
    const toolBins = Object.keys(m.bin).filter((b) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(b));
    bins.push(...toolBins);
    if (m.commands === undefined) continue;
    if (!isObj(m.commands)) {
      problems.push(`tools/${d}/manifest.json: "commands" must be an object keyed by bin command`);
      continue;
    }
    for (const [bin, list] of Object.entries(m.commands)) {
      if (!toolBins.includes(bin)) {
        problems.push(`tools/${d}/manifest.json: "commands" names ${JSON.stringify(bin)}, which isn't in "bin"`);
        continue;
      }
      if (!Array.isArray(list)) {
        problems.push(`tools/${d}/manifest.json: commands.${bin} must be an array`);
        continue;
      }
      for (const c of list) {
        if (!isObj(c) || typeof c.title !== "string" || c.title.trim() === "" || !Array.isArray(c.args) || !c.args.every((a) => typeof a === "string")) {
          problems.push(`tools/${d}/manifest.json: each commands.${bin} entry needs "title" (string) and "args" (array of strings)`);
          continue;
        }
        const wrapper = `${binDir.replace(/\/+$/, "")}/${bin}`;
        suggestions.push({
          tool: toolId,
          toolTitle,
          bin,
          title: c.title.trim(),
          args: c.args as string[],
          command: joinArgv([wrapper, ...(c.args as string[])]),
          installed: exists(wrapper),
        });
      }
    }
  }
  return { suggestions, bins, problems };
}
