// Test doubles: a Runner whose gsettings/dconf answer from an in-memory store, the machine's
// real set of custom shortcuts as a fixture, and timers advanced by hand.
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import type { GValue } from "../src/gvariant.ts";
import type { Env } from "../src/ops.ts";
import type { Proc, Runner } from "../src/runner.ts";
import type { Timers } from "../src/service.ts";
import { LIST, MEDIA, handle } from "./fake-gnome-core.ts";
import type { Store } from "./fake-gnome-core.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_TOOLS = path.resolve(here, "..", "..");

export const DIR = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/";

/**
 * The user's 8 custom shortcuts on 2026-10-20 (issue #7): paths, names and bindings as
 * reported. The commands and CopyQ's binding weren't reported, so those are made up.
 */
export const MACHINE: { seg: string; name: string; binding: string; command: string }[] = [
  { seg: "custom0", name: "CopyQ", binding: "<Super>v", command: "copyq toggle" },
  { seg: "dc-map-toggle", name: "dc-map-toggle", binding: "<Control>F9", command: "/home/erkan/.local/bin/dc-map toggle" },
  { seg: "dc-map-opacity", name: "dc-map-opacity", binding: "<Control>F10", command: "/home/erkan/.local/bin/dc-map opacity" },
  { seg: "dc-map-zoomout", name: "dc-map-zoomout", binding: "<Control>F11", command: "/home/erkan/.local/bin/dc-map zoomout" },
  { seg: "dc-map-zoomin", name: "dc-map-zoomin", binding: "<Control>F12", command: "/home/erkan/.local/bin/dc-map zoomin" },
  { seg: "dc-map-fit", name: "dc-map-fit", binding: "<Control><Shift>F9", command: "/home/erkan/.local/bin/dc-map fit" },
  { seg: "dc-map-follow", name: "dc-map-follow", binding: "<Control><Shift>F10", command: "/home/erkan/.local/bin/dc-map follow" },
  { seg: "dc-map-clicks", name: "dc-map-clicks", binding: "<Control><Shift>F11", command: "/home/erkan/.local/bin/dc-map clicks" },
];
export const MACHINE_PATHS = MACHINE.map((m) => `${DIR}${m.seg}/`);

/**
 * The same 8 as the user listed them in issue #19 (names and bindings as reported there; the
 * dconf segments and commands are still made up, all Dead Cells ones calling one script).
 */
export const MACHINE_19: typeof MACHINE = [
  { seg: "custom0", name: "Dead Cells map: show / hide", binding: "<Control>F9", command: "/home/erkan/.local/bin/dc-map toggle" },
  { seg: "custom1", name: "Dead Cells map: opacity", binding: "<Control>F10", command: "/home/erkan/.local/bin/dc-map opacity" },
  { seg: "custom2", name: "Dead Cells map: zoom out", binding: "<Control>F11", command: "/home/erkan/.local/bin/dc-map zoomout" },
  { seg: "custom3", name: "Dead Cells map: zoom in", binding: "<Control>F12", command: "/home/erkan/.local/bin/dc-map zoomin" },
  { seg: "custom4", name: "Dead Cells map: whole level", binding: "<Control><Shift>F9", command: "/home/erkan/.local/bin/dc-map fit" },
  { seg: "custom5", name: "Dead Cells map: follow the hero", binding: "<Control><Shift>F10", command: "/home/erkan/.local/bin/dc-map follow" },
  { seg: "custom6", name: "Dead Cells map: take clicks", binding: "<Control><Shift>F11", command: "/home/erkan/.local/bin/dc-map clicks" },
  { seg: "custom7", name: "CopyQ", binding: "<Primary><Alt><Shift>0", command: "copyq toggle" },
];

/** `gsettings list-recursively` of GNOME 46's keybinding schemas, captured in the container. */
export function builtinLines(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const l of fs.readFileSync(path.join(here, "fixtures", "builtins-gnome46.txt"), "utf8").split("\n")) {
    if (!l) continue;
    const schema = l.slice(0, l.indexOf(" "));
    (out[schema] ??= []).push(l);
  }
  return out;
}

export function machineStore(entries = MACHINE): Store {
  const values: Record<string, GValue> = { [LIST]: entries.map((m) => `${DIR}${m.seg}/`) };
  for (const m of entries) {
    values[`${DIR}${m.seg}/name`] = m.name;
    values[`${DIR}${m.seg}/binding`] = m.binding;
    values[`${DIR}${m.seg}/command`] = m.command;
  }
  return { values, builtins: builtinLines() };
}

/** Every value of the 8 machine entries plus the array, for before/after comparisons. */
export function machineSnapshot(store: Store): Record<string, GValue | undefined> {
  const out: Record<string, GValue | undefined> = {};
  for (const m of MACHINE) for (const k of ["name", "binding", "command"]) out[`${DIR}${m.seg}/${k}`] = store.values[`${DIR}${m.seg}/${k}`];
  return out;
}

export class FakeProc extends EventEmitter implements Proc {
  readonly stdin = null;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  kill(): boolean {
    return true;
  }
  finish(code: number, out: string, err: string): void {
    this.stdout.end(out);
    this.stderr.end(err);
    setImmediate(() => this.emit("close", code, null));
  }
}

export class FakeGnome implements Runner {
  store: Store;
  calls: string[] = [];
  envs: (NodeJS.ProcessEnv | undefined)[] = [];
  /** Commands that aren't installed. */
  missing = new Set<string>();
  /** Runs before a call is answered; may change the store (to simulate other writers). */
  before: ((cmd: string, args: string[]) => void) | undefined;

  constructor(store: Store = machineStore()) {
    this.store = store;
  }

  spawn(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Proc {
    const p = new FakeProc();
    this.calls.push([cmd, ...args].join(" "));
    this.envs.push(env);
    setImmediate(() => {
      if (this.missing.has(cmd)) {
        p.emit("error", Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: "ENOENT" }));
        return;
      }
      this.before?.(cmd, args);
      const r = handle(this.store, cmd, args);
      p.finish(r.code, r.stdout, r.stderr);
    });
    return p;
  }

  paths(): string[] {
    return (this.store.values[LIST] as string[] | undefined) ?? [];
  }

  /** The writes made so far (gsettings set/reset, dconf reset). */
  writes(): string[] {
    return this.calls.filter((c) => /^(gsettings (set|reset)|dconf reset) /.test(c));
  }
}

export { LIST, MEDIA };

export function testEnv(over: Partial<Env> = {}): Env {
  const existing = new Set(["/home/u/.local/bin/audioctl", "/home/u/.local/bin/brightctl"]);
  return {
    home: "/home/u",
    binDir: "/home/u/.local/bin",
    toolsDir: REPO_TOOLS,
    exists: (p) => existing.has(p) || (p.endsWith("manifest.json") && fs.existsSync(p)),
    ...over,
  };
}

export class FakeTimers implements Timers {
  t = 1_700_000_000_000;
  private list: { at: number; fn: () => void; id: number }[] = [];
  private id = 0;
  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.id;
    this.list.push({ at: this.t + ms, fn, id });
    return id;
  }
  clearTimeout(h: unknown): void {
    this.list = this.list.filter((x) => x.id !== h);
  }
  advance(ms: number): void {
    this.t += ms;
    const due = this.list.filter((x) => x.at <= this.t);
    this.list = this.list.filter((x) => x.at > this.t);
    for (const d of due) d.fn();
  }
}

export const tick = () => new Promise((r) => setImmediate(r));

export async function waitFor(pred: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
