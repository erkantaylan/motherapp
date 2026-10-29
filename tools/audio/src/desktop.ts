// App names from desktop entries: maps a process binary ("Discord", "spotify") to the Name= of
// the .desktop file that launches it, the way GNOME names windows. Read once, on first use.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Where desktop entries live: XDG data dirs plus snap's and flatpak's export dirs. */
export function desktopDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME ?? os.homedir();
  const dataHome = env.XDG_DATA_HOME || path.join(home, ".local", "share");
  const dataDirs = (env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":").filter(Boolean);
  const dirs = [dataHome, ...dataDirs].map((d) => path.join(d, "applications"));
  dirs.push("/var/lib/snapd/desktop/applications", "/var/lib/flatpak/exports/share/applications", path.join(dataHome, "flatpak", "exports", "share", "applications"));
  return [...new Set(dirs)];
}

/**
 * Keys (lowercased) under which an entry is found: its file id, StartupWMClass and the basename
 * of Exec's program. Only the [Desktop Entry] group counts (not actions).
 */
export function parseDesktopEntry(id: string, text: string): { name: string; keys: string[]; exec?: string } | undefined {
  let inMain = false;
  let name: string | undefined;
  let exec: string | undefined;
  let wmClass: string | undefined;
  let hidden = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inMain = line === "[Desktop Entry]";
      continue;
    }
    if (!inMain) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    if (k === "Name") name = v;
    else if (k === "Exec") exec = v;
    else if (k === "StartupWMClass") wmClass = v;
    else if (k === "Hidden" && v === "true") hidden = true;
  }
  if (!name || hidden) return undefined;
  const keys = [id];
  if (wmClass) keys.push(wmClass);
  const out: { name: string; keys: string[]; exec?: string } = { name, keys: keys.map((k) => k.toLowerCase()) };
  const prog = exec?.split(/\s+/).find((w) => w !== "env" && !/^\w+=/.test(w));
  if (prog) out.exec = path.basename(prog.replace(/^"|"$/g, "")).toLowerCase();
  return out;
}

/**
 * binary (lowercased) → Name=. File ids and StartupWMClass first (the first directory wins, as
 * in XDG lookup), then Exec's program, but only when one entry name uses it: Steam game
 * shortcuts all run `steam steam://rungameid/…`, so "steam" must not become a game's name.
 */
export function loadDesktopNames(dirs: string[] = desktopDirs()): Map<string, string> {
  const out = new Map<string, string>();
  const byExec = new Map<string, Set<string>>();
  for (const dir of dirs) {
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".desktop"));
    } catch {
      continue;
    }
    for (const f of files) {
      let entry;
      try {
        entry = parseDesktopEntry(f.slice(0, -".desktop".length), fs.readFileSync(path.join(dir, f), "utf8"));
      } catch {
        continue;
      }
      if (!entry) continue;
      for (const k of entry.keys) if (!out.has(k)) out.set(k, entry.name);
      if (entry.exec) {
        const names = byExec.get(entry.exec) ?? new Set<string>();
        names.add(entry.name);
        byExec.set(entry.exec, names);
      }
    }
  }
  for (const [exec, names] of byExec) if (names.size === 1 && !out.has(exec)) out.set(exec, [...names][0]!);
  return out;
}

/** A lookup that reads the desktop entries the first time it is asked. */
export function desktopNameLookup(load: () => Map<string, string> = () => loadDesktopNames()): (binary: string) => string | undefined {
  let names: Map<string, string> | undefined;
  return (binary) => {
    names ??= load();
    return names.get(binary.toLowerCase());
  };
}
