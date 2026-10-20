// GNOME custom keyboard shortcuts through gsettings and dconf.
//
// How GNOME 46 stores them:
// - `gsettings get org.gnome.settings-daemon.plugins.media-keys custom-keybindings` is an
//   array of dconf paths, in the order GNOME Settings shows them;
// - each path holds the relocatable schema
//   org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:<path> with the keys
//   name, command and binding.
//
// Ownership: this tool only ever creates, edits or removes paths under
// OWNED_PREFIX (…/custom-keybindings/motherapp-<slug>/). Every other entry is read-only. The
// array is read, changed and written back with every other entry in place and in order, and
// it is re-read right before each write to keep the window for races small.
import { normalizeAccel } from "./accel.ts";
import type { BuiltinLike } from "./conflicts.ts";
import { GVariantError, parseGVariant, parseStringArray, printString, printStringArray } from "./gvariant.ts";
import { SpawnError, run } from "./runner.ts";
import type { Runner } from "./runner.ts";

export const MEDIA_KEYS = "org.gnome.settings-daemon.plugins.media-keys";
export const CUSTOM_SCHEMA = `${MEDIA_KEYS}.custom-keybinding`;
export const LIST_KEY = "custom-keybindings";
export const CUSTOM_DIR = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/";
export const OWNED_PREFIX = `${CUSTOM_DIR}motherapp-`;
/** dconf directory whose dump changes whenever a custom shortcut or the list changes. */
export const WATCH_DIR = "/org/gnome/settings-daemon/plugins/media-keys/";

/** Schemas whose keybindings count as GNOME's built-in ones for conflict warnings. */
export const BUILTIN_SCHEMAS: readonly { schema: string; title: string }[] = [
  { schema: "org.gnome.desktop.wm.keybindings", title: "Window manager" },
  { schema: "org.gnome.shell.keybindings", title: "GNOME Shell" },
  { schema: MEDIA_KEYS, title: "Settings daemon" },
  { schema: "org.gnome.mutter.keybindings", title: "Mutter" },
  { schema: "org.gnome.mutter.wayland.keybindings", title: "Mutter (Wayland)" },
];

/** gsettings prints non-ASCII text as "?" outside a UTF-8 locale. */
const ENV = { LC_ALL: "C.UTF-8" };

export interface Shortcut {
  /** dconf path, "/org/…/custom-keybindings/custom0/". */
  path: string;
  /** State key: the path's last segment, made safe for a dotted state path. */
  id: string;
  name: string;
  command: string;
  binding: string;
  /** Created by motherapp (path under OWNED_PREFIX), so editable. */
  owned: boolean;
  /** Position in the custom-keybindings array. */
  order: number;
  /** Set when the entry couldn't be read. */
  error?: string;
}

export interface Builtin extends BuiltinLike {
  schema: string;
}

export interface NewShortcut {
  name: string;
  binding: string;
  /** The final command line (see command.ts). */
  command: string;
}

/** gsettings/dconf failed, or a request breaks the rules (not owned, duplicate name, …). */
export class GnomeError extends Error {}

const OWNED_RE = /^\/org\/gnome\/settings-daemon\/plugins\/media-keys\/custom-keybindings\/motherapp-[a-z0-9]+(?:-[a-z0-9]+)*\/$/;

export function isOwnedPath(p: string): boolean {
  return OWNED_RE.test(p);
}

/** "Mute Firefox!" → "mute-firefox"; at most 40 characters, "shortcut" when nothing is left. */
export function slugify(name: string): string {
  const s = name
    .replace(/ı/g, "i")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return s || "shortcut";
}

export function ownedPath(slug: string): string {
  return `${OWNED_PREFIX}${slug}/`;
}

/** A state key for a path: its last segment with anything outside [A-Za-z0-9_-] hex-escaped. */
export function idForPath(p: string, used: Set<string>): string {
  const seg = p.replace(/\/+$/, "").split("/").pop() || "entry";
  let id = seg.replace(/[^A-Za-z0-9_-]/g, (c) => `_${c.codePointAt(0)!.toString(16)}`);
  if (used.has(id)) {
    let n = 2;
    while (used.has(`${id}~${n}`)) n++;
    id = `${id}~${n}`;
  }
  used.add(id);
  return id;
}

function firstLine(s: string): string {
  return s.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
}

export interface GnomeOptions {
  runner: Runner;
}

export class Gnome {
  private runner: Runner;

  constructor(opts: GnomeOptions) {
    this.runner = opts.runner;
  }

  private async cmd(prog: "gsettings" | "dconf", args: string[]): Promise<string> {
    let res;
    try {
      res = await run(this.runner, prog, args, ENV);
    } catch (e) {
      if (e instanceof SpawnError && e.missing) {
        throw new GnomeError(prog === "gsettings" ? "gsettings not found (Ubuntu package libglib2.0-bin)." : "dconf not found (Ubuntu package dconf-cli).");
      }
      throw new GnomeError((e as Error).message);
    }
    if (res.code !== 0) {
      const msg = firstLine(res.stderr);
      if (/No such schema/i.test(msg)) throw new GnomeError(`GNOME's settings schema is missing: ${msg}`);
      throw new GnomeError(`${prog} ${args[0]} failed: ${msg || `exit code ${res.code}`}`);
    }
    return res.stdout;
  }

  private gsettings(...args: string[]): Promise<string> {
    return this.cmd("gsettings", args);
  }

  /** The custom-keybindings array, exactly as stored (order and duplicates kept). */
  async readPaths(): Promise<string[]> {
    const out = await this.gsettings("get", MEDIA_KEYS, LIST_KEY);
    try {
      return parseStringArray(out.trim());
    } catch (e) {
      throw new GnomeError(`can't read the custom shortcut list: ${(e as Error).message}`);
    }
  }

  private async writePaths(paths: readonly string[]): Promise<void> {
    await this.gsettings("set", MEDIA_KEYS, LIST_KEY, printStringArray(paths));
  }

  /** name, command and binding of one entry (one gsettings call). */
  async readEntry(path: string): Promise<{ name: string; command: string; binding: string }> {
    const out = await this.gsettings("list-recursively", `${CUSTOM_SCHEMA}:${path}`);
    const v: Record<string, string> = { name: "", command: "", binding: "" };
    for (const line of out.split("\n")) {
      const m = /^(\S+) (\S+) (.*)$/.exec(line);
      if (!m || !(m[2]! in v)) continue;
      try {
        const x = parseGVariant(m[3]!);
        if (typeof x === "string") v[m[2]!] = x;
      } catch (e) {
        if (!(e instanceof GVariantError)) throw e;
        throw new GnomeError(`can't read ${m[2]} of ${path}: ${e.message}`);
      }
    }
    return { name: v.name!, command: v.command!, binding: v.binding! };
  }

  /** Every custom shortcut in array order. An entry that can't be read gets `error`. */
  async list(): Promise<Shortcut[]> {
    const paths = await this.readPaths();
    const used = new Set<string>();
    const out: Shortcut[] = [];
    for (const [i, p] of paths.entries()) {
      const base = { path: p, id: idForPath(p, used), owned: isOwnedPath(p), order: i };
      if (!p.startsWith("/") || !p.endsWith("/") || p.includes("//")) {
        out.push({ ...base, owned: false, name: "", command: "", binding: "", error: "not a valid dconf path" });
        continue;
      }
      try {
        out.push({ ...base, ...(await this.readEntry(p)) });
      } catch (e) {
        out.push({ ...base, name: "", command: "", binding: "", error: (e as Error).message });
      }
    }
    return out;
  }

  /**
   * A cheap fingerprint of everything under the media-keys dconf dir (one dconf call), to see
   * whether anything changed since the last full read. null when dconf isn't usable.
   */
  async snapshot(): Promise<string | null> {
    try {
      return await this.cmd("dconf", ["dump", WATCH_DIR]);
    } catch {
      return null;
    }
  }

  /** GNOME's own keybindings (schemas that aren't installed are skipped). */
  async builtins(): Promise<Builtin[]> {
    const out: Builtin[] = [];
    for (const { schema, title } of BUILTIN_SCHEMAS) {
      let text: string;
      try {
        text = await this.gsettings("list-recursively", schema);
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        const m = /^(\S+) (\S+) (.*)$/.exec(line);
        if (!m || m[2] === LIST_KEY) continue;
        let v;
        try {
          v = parseGVariant(m[3]!);
        } catch {
          continue;
        }
        const list = typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
        for (const a of list) if (normalizeAccel(a)) out.push({ schema, title, key: m[2]!, accel: a });
      }
    }
    return out;
  }

  private async hasData(path: string): Promise<boolean> {
    try {
      return (await this.cmd("dconf", ["list", path])).trim() !== "";
    } catch {
      return false; // no dconf: the array is all we can go by
    }
  }

  private async setKeys(path: string, fields: Partial<NewShortcut>): Promise<void> {
    for (const k of ["name", "command", "binding"] as const) {
      const v = fields[k];
      if (v !== undefined) await this.gsettings("set", `${CUSTOM_SCHEMA}:${path}`, k, printString(v));
    }
  }

  private async resetPath(path: string): Promise<void> {
    try {
      await this.cmd("dconf", ["reset", "-f", path]);
    } catch (e) {
      if (!(e instanceof GnomeError) || !/^dconf not found/.test(e.message)) throw e;
      for (const k of ["name", "command", "binding"]) await this.gsettings("reset", `${CUSTOM_SCHEMA}:${path}`, k);
    }
  }

  private static checkName(name: string): string {
    const n = name.trim();
    if (n === "") throw new GnomeError("The shortcut needs a name.");
    if (/[\n\r]/.test(n)) throw new GnomeError("The name must be one line.");
    return n;
  }

  private static sameName(a: string, b: string): boolean {
    const f = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
    return f(a) === f(b);
  }

  /**
   * Adds a motherapp shortcut: picks a free motherapp-<slug>/ path (slug-2, slug-3, … when
   * taken by the list or by leftover dconf data), writes its three keys, then appends the path
   * to a freshly re-read array. Returns the new entry.
   */
  async add(s: NewShortcut): Promise<Shortcut> {
    const name = Gnome.checkName(s.name);
    const current = await this.list();
    const dup = current.find((x) => x.owned && Gnome.sameName(x.name, name));
    if (dup) throw new GnomeError(`There is already a motherapp shortcut named '${dup.name}'.`);
    const base = slugify(name);
    let slug = base;
    for (let n = 2; current.some((x) => x.path === ownedPath(slug)) || (await this.hasData(ownedPath(slug))); n++) slug = `${base}-${n}`;
    const path = ownedPath(slug);
    await this.setKeys(path, { name, command: s.command, binding: s.binding });
    try {
      const paths = await this.readPaths(); // re-read right before writing
      if (!paths.includes(path)) await this.writePaths([...paths, path]);
      const after = await this.readPaths();
      if (!after.includes(path)) throw new GnomeError("GNOME didn't keep the new shortcut (is the session's dconf reachable?).");
    } catch (e) {
      await this.resetPath(path).catch(() => {});
      throw e;
    }
    const used = new Set<string>();
    const paths = await this.readPaths();
    const order = paths.indexOf(path);
    for (const p of paths.slice(0, order)) idForPath(p, used);
    return { path, id: idForPath(path, used), name, command: s.command, binding: s.binding, owned: true, order };
  }

  private async ownedEntry(path: string): Promise<Shortcut> {
    if (!isOwnedPath(path)) throw new GnomeError("That shortcut wasn't made by motherapp, so it is read-only here. Change it in GNOME Settings.");
    const entry = (await this.list()).find((x) => x.path === path);
    if (!entry) throw new GnomeError("That shortcut doesn't exist anymore.");
    return entry;
  }

  /** Changes name, command and/or binding of a motherapp shortcut. The path stays the same. */
  async edit(path: string, fields: Partial<NewShortcut>): Promise<void> {
    await this.ownedEntry(path);
    const f = { ...fields };
    if (f.name !== undefined) {
      const name = Gnome.checkName(f.name);
      const dup = (await this.list()).find((x) => x.owned && x.path !== path && Gnome.sameName(x.name, name));
      if (dup) throw new GnomeError(`There is already a motherapp shortcut named '${dup.name}'.`);
      f.name = name;
    }
    await this.setKeys(path, f);
  }

  /** Takes a motherapp shortcut out of the array (others untouched), then clears its keys. */
  async remove(path: string): Promise<void> {
    await this.ownedEntry(path);
    const paths = await this.readPaths(); // re-read right before writing
    const next = paths.filter((p) => p !== path);
    if (next.length !== paths.length) await this.writePaths(next);
    if ((await this.readPaths()).includes(path)) throw new GnomeError("GNOME didn't remove the shortcut (is the session's dconf reachable?).");
    await this.resetPath(path);
  }
}
