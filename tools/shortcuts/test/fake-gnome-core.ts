// An in-memory stand-in for `gsettings` and `dconf`, as far as the shortcuts tool uses them.
// The store maps dconf keys ("/org/…/custom-keybindings/custom0/name") to plain values.
// Output follows what gsettings 2.80 / dconf 0.40 print (checked against the real ones in
// test/real-gsettings.test.ts). Used in-process by FakeGnome and on PATH by fake-gnome.ts.
import { parseGVariant } from "../src/gvariant.ts";
import type { GValue } from "../src/gvariant.ts";

export const MEDIA = "org.gnome.settings-daemon.plugins.media-keys";
export const CUSTOM = `${MEDIA}.custom-keybinding`;
export const MEDIA_DIR = "/org/gnome/settings-daemon/plugins/media-keys/";
export const LIST = `${MEDIA_DIR}custom-keybindings`;

export interface Store {
  values: Record<string, GValue>;
  /** "schema key value" lines for list-recursively of a built-in schema. */
  builtins: Record<string, string[]>;
}

export interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

/** g_variant_print for a string: '…', or "…" when it contains a single quote. */
export function gvString(s: string): string {
  const dq = s.includes("'");
  let out = dq ? '"' : "'";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (dq && ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else if (cp < 0x20 || cp === 0x7f) out += "\\u" + cp.toString(16).padStart(4, "0");
    else out += ch;
  }
  return out + (dq ? '"' : "'");
}

export function gvPrint(v: GValue): string {
  if (typeof v === "string") return gvString(v);
  if (Array.isArray(v)) return v.length === 0 ? "@as []" : `[${v.map(gvPrint).join(", ")}]`;
  return String(v);
}

const ok = (stdout = ""): Result => ({ code: 0, stdout, stderr: "" });
const err = (stderr: string, code = 1): Result => ({ code, stdout: "", stderr: stderr + "\n" });

const KEYS = ["binding", "command", "name"]; // list-recursively prints them sorted

function schemaPath(spec: string): { schema: string; path?: string } | Result {
  const i = spec.indexOf(":");
  if (i < 0) return { schema: spec };
  const schema = spec.slice(0, i);
  const path = spec.slice(i + 1);
  if (schema !== CUSTOM) return err(`Schema “${schema}” is not relocatable`);
  if (!path.endsWith("/")) return err("Path must end with a slash (/)");
  if (!path.startsWith("/") || path.includes("//")) return err("Path must begin with a slash (/)");
  return { schema, path };
}

function gsettings(store: Store, args: string[]): Result {
  const [cmd, spec, key, value] = args;
  if (spec === undefined) return err("usage", 64);
  const sp = schemaPath(spec);
  if ("code" in sp) return sp;
  const { schema, path } = sp;
  const known = schema === MEDIA || schema === CUSTOM || schema in store.builtins;
  if (!known) return err(`No such schema “${schema}”`);
  if (schema === CUSTOM && path === undefined) return err(`Schema “${schema}” is relocatable (path must be specified)`);
  if (cmd === "list-recursively") {
    if (schema === CUSTOM) return ok(KEYS.map((k) => `${CUSTOM} ${k} ${gvPrint(store.values[path + k] ?? "")}\n`).join(""));
    if (schema === MEDIA) {
      const lines = (store.builtins[MEDIA] ?? []).filter((l) => !l.startsWith(`${MEDIA} custom-keybindings `));
      lines.push(`${MEDIA} custom-keybindings ${gvPrint(store.values[LIST] ?? [])}`);
      return ok(lines.sort().map((l) => l + "\n").join(""));
    }
    return ok(store.builtins[schema]!.map((l) => l + "\n").join(""));
  }
  const dkey = schema === CUSTOM ? `${path}${key}` : schema === MEDIA && key === "custom-keybindings" ? LIST : undefined;
  if (dkey === undefined || (schema === CUSTOM && !KEYS.includes(key!))) return err(`No such key “${key}”`);
  const dflt: GValue = schema === CUSTOM ? "" : [];
  if (cmd === "get") return ok(gvPrint(store.values[dkey] ?? dflt) + "\n");
  if (cmd === "set") {
    let v: GValue;
    try {
      v = parseGVariant(value ?? "");
    } catch {
      return err(`0-${String(value).length}:could not parse value`);
    }
    if (schema === CUSTOM ? typeof v !== "string" : !Array.isArray(v) || !v.every((x) => typeof x === "string")) return err("value is of the wrong type");
    store.values[dkey] = v;
    return ok();
  }
  if (cmd === "reset") {
    delete store.values[dkey];
    return ok();
  }
  return err(`Unknown command ${cmd}`, 64);
}

function dconf(store: Store, args: string[]): Result {
  const [cmd, a, b] = args;
  if (cmd === "dump") {
    const dir = a!;
    const groups = new Map<string, string[]>();
    for (const [k, v] of Object.entries(store.values).sort()) {
      if (!k.startsWith(dir)) continue;
      const rel = k.slice(dir.length);
      const i = rel.lastIndexOf("/");
      const g = i < 0 ? "/" : rel.slice(0, i);
      const name = i < 0 ? rel : rel.slice(i + 1);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(`${name}=${gvPrint(v)}`);
    }
    return ok([...groups].map(([g, lines]) => `[${g}]\n${lines.join("\n")}\n`).join("\n"));
  }
  if (cmd === "list") {
    const dir = a!;
    const names = new Set<string>();
    for (const k of Object.keys(store.values)) {
      if (!k.startsWith(dir)) continue;
      const rest = k.slice(dir.length);
      const i = rest.indexOf("/");
      names.add(i < 0 ? rest : rest.slice(0, i + 1));
    }
    return ok([...names].sort().map((n) => n + "\n").join(""));
  }
  if (cmd === "reset" && a === "-f") {
    for (const k of Object.keys(store.values)) if (k.startsWith(b!)) delete store.values[k];
    return ok();
  }
  return err(`error: unknown command ${cmd}`, 2);
}

export function handle(store: Store, cmd: string, args: string[]): Result {
  if (cmd === "gsettings") return gsettings(store, args);
  if (cmd === "dconf") return dconf(store, args);
  return err(`unexpected command ${cmd}`, 127);
}
