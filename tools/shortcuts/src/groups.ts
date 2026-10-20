// Groups of shortcuts for the page and `shortcutsctl list` (issue #19). Worked out from what
// GNOME stores, with nothing saved anywhere else, so GNOME stays the source of truth. The
// rules run in this order; a shortcut goes to the first rule that gives it a group of at
// least MIN_GROUP shortcuts (or a group of that name that already exists):
// 1. the name's prefix before ": " ("Dead Cells map: zoom in" → "Dead Cells map"; the row
//    shows "zoom in");
// 2. for motherapp's own shortcuts, the tool whose wrapper the command calls (audioctl →
//    "Audio", the title from the tool's manifest);
// 3. the same program: argv[0] (or sh -c's first word), shown by its file name. Launchers
//    such as env or flatpak don't count, since they say nothing about what runs.
// Everything else is a single row. Groups and rows are sorted by name.
// Browser-safe (page.ts uses it): imports only accel.ts and command.ts.
import { accelParts } from "./accel.ts";
import { commandProgram } from "./command.ts";

export const MIN_GROUP = 2;
/** Groups this big start collapsed. */
export const COLLAPSE_AT = 3;

const SEP = ": ";
const LAUNCHERS = new Set(["env", "flatpak", "gtk-launch", "xdg-open", "gio", "nohup", "setsid", "sh", "bash", "dbus-send", "gdbus", "busctl"]);

export interface Groupable {
  id: string;
  name: string;
  command: string;
  binding: string;
  owned: boolean;
  /** Non-empty when the binding clashes with something. */
  conflicts?: string | readonly string[];
}

export type GroupRule = "prefix" | "tool" | "program";

export interface Member<T> {
  item: T;
  /** What the row shows: the name without the group prefix (rule 1), else the name. */
  label: string;
}

export interface Group<T> {
  kind: "group";
  /** Lowercased name, unique among the entries of one call. */
  key: string;
  name: string;
  rule: GroupRule;
  members: Member<T>[];
  /** The key combinations at a glance: "Ctrl+F9–F12 · Ctrl+Shift+F9–F11". */
  keys: string;
  /** How many members have a conflict. */
  conflicts: number;
}

export interface Single<T> {
  kind: "single";
  item: T;
  label: string;
}

export type Entry<T> = Group<T> | Single<T>;

/** "Dead Cells map: zoom in" → { group: "Dead Cells map", rest: "zoom in" }; null without a prefix. */
export function splitPrefix(name: string): { group: string; rest: string } | null {
  const i = name.indexOf(SEP);
  if (i < 0) return null;
  const group = name.slice(0, i).trim();
  const rest = name.slice(i + SEP.length).trim();
  return group && rest ? { group, rest } : null;
}

/** The name to store for a shortcut in `group` ("" = none): "<Group>: <name>". */
export function joinGroup(group: string, name: string): string {
  const g = group.trim();
  const n = name.trim();
  return g ? `${g}${SEP}${n}` : n;
}

/** Why `group` can't be used as a prefix, or null. */
export function groupProblem(group: string): string | null {
  const g = group.trim();
  if (g.includes(SEP) || g.endsWith(":")) return `A group name can't contain ": " or end with ":".`;
  return null;
}

const basename = (p: string) => p.replace(/\/+$/, "").split("/").pop() ?? p;

/** argv[0] (or sh -c's first word) of a command, unless it's a launcher; null otherwise. */
export function commandProgramFor(command: string): string | null {
  const p = commandProgram(command);
  if (!p || LAUNCHERS.has(basename(p))) return null;
  return p;
}

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
const byName = (a: string, b: string) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

const hasConflict = (c: Groupable["conflicts"]) => (typeof c === "string" ? c !== "" : !!c && c.length > 0);

/** Key combinations at a glance: per modifier set, the keys, with runs of 3+ as "F9–F12". */
export function keysSummary(bindings: readonly string[], maxParts = 3): string {
  const byMods = new Map<string, Set<string>>();
  for (const b of bindings) {
    const p = b ? accelParts(b) : null;
    if (!p) continue;
    let s = byMods.get(p.mods);
    if (!s) byMods.set(p.mods, (s = new Set()));
    s.add(p.key);
  }
  const rank = (k: string): [number, number] => {
    const f = /^F(\d+)$/.exec(k);
    if (f) return [0, Number(f[1])];
    if (/^[0-9]$/.test(k)) return [1, k.charCodeAt(0)];
    if (/^[A-Z]$/.test(k)) return [2, k.charCodeAt(0)];
    return [3, 0];
  };
  const mods = [...byMods.keys()].sort((a, b) => (a ? a.split("+").length : 0) - (b ? b.split("+").length : 0) || byName(a, b));
  const parts = mods.map((m) => {
    const keys = [...byMods.get(m)!].sort((a, b) => {
      const [ca, ra] = rank(a);
      const [cb, rb] = rank(b);
      return ca - cb || ra - rb || byName(a, b);
    });
    const out: string[] = [];
    for (let i = 0; i < keys.length; ) {
      const [c, r] = rank(keys[i]!);
      let j = i;
      while (c < 3 && j + 1 < keys.length && rank(keys[j + 1]!)[0] === c && rank(keys[j + 1]!)[1] === r + (j + 1 - i)) j++;
      if (j - i >= 2) out.push(`${keys[i]}–${keys[j]}`);
      else for (let k = i; k <= j; k++) out.push(keys[k]!);
      i = j + 1;
    }
    return (m ? `${m}+` : "") + out.join(", ");
  });
  return parts.length > maxParts ? [...parts.slice(0, maxParts), "…"].join(" · ") : parts.join(" · ");
}

interface Candidate<T> {
  name: string;
  rule: GroupRule;
  members: Member<T>[];
}

/**
 * Groups `items` (one card: call it separately for motherapp's own and the others).
 * `binTools` maps a wrapper's command name to its tool's title ("audioctl" → "Audio").
 */
export function groupShortcuts<T extends Groupable>(items: readonly T[], binTools: Readonly<Record<string, string>> = {}): Entry<T>[] {
  const rules: ((it: T) => { id: string; name: string; label: string } | null)[] = [
    (it) => {
      const p = splitPrefix(it.name);
      return p ? { id: p.group.toLowerCase(), name: p.group, label: p.rest } : null;
    },
    (it) => {
      if (!it.owned) return null;
      const p = commandProgram(it.command);
      const title = p ? binTools[basename(p)] : undefined;
      return title ? { id: title.toLowerCase(), name: title, label: it.name } : null;
    },
    (it) => {
      const p = commandProgramFor(it.command);
      return p ? { id: p, name: basename(p), label: it.name } : null;
    },
  ];
  const ruleNames: GroupRule[] = ["prefix", "tool", "program"];
  const groups = new Map<string, Candidate<T>>();
  let left = [...items];
  rules.forEach((rule, n) => {
    const cands = new Map<string, Candidate<T>>();
    const rest: T[] = [];
    for (const it of left) {
      const c = rule(it);
      if (!c) {
        rest.push(it);
        continue;
      }
      let cand = cands.get(c.id);
      if (!cand) cands.set(c.id, (cand = { name: c.name, rule: ruleNames[n]!, members: [] }));
      cand.members.push({ item: it, label: c.label });
    }
    for (const [id, cand] of cands) {
      let key = cand.name.toLowerCase();
      let existing = groups.get(key);
      // Another program with the same file name is a different group: name its directory.
      if (existing?.rule === "program" && cand.rule === "program") {
        cand.name = `${cand.name} (${id.includes("/") ? id.slice(0, id.lastIndexOf("/")) || "/" : "on PATH"})`;
        key = cand.name.toLowerCase();
        existing = groups.get(key);
      }
      if (existing) existing.members.push(...cand.members);
      else if (cand.members.length >= MIN_GROUP) groups.set(key, cand);
      else rest.push(...cand.members.map((m) => m.item));
    }
    left = rest;
  });
  const entries: Entry<T>[] = [];
  for (const [key, g] of groups) {
    // "Audio: mute mic" that landed in the Audio tool group (its prefix alone was too small)
    for (const m of g.members) {
      const p = splitPrefix(m.item.name);
      if (p && p.group.toLowerCase() === key) m.label = p.rest;
    }
    const members = g.members.sort((a, b) => byName(a.label, b.label) || byName(a.item.binding, b.item.binding));
    entries.push({
      kind: "group",
      key,
      name: g.name,
      rule: g.rule,
      members,
      keys: keysSummary(members.map((m) => m.item.binding)),
      conflicts: members.filter((m) => hasConflict(m.item.conflicts)).length,
    });
  }
  for (const it of left) entries.push({ kind: "single", item: it, label: it.name });
  const nameOf = (e: Entry<T>) => (e.kind === "group" ? e.name : e.label);
  return entries.sort((a, b) => byName(nameOf(a), nameOf(b)));
}

/** The group each item ended up in (by id), for `list --json`. */
export function groupOf<T extends Groupable>(entries: readonly Entry<T>[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of entries) if (e.kind === "group") for (const m of e.members) out.set(m.item.id, e.name);
  return out;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
