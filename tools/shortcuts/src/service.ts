// Serve mode. Every 3 s one `dconf dump` of the media-keys dir tells whether anything
// changed (GNOME Settings, shortcutsctl, another tab); only then are the shortcuts re-read.
// GNOME's built-in bindings are re-read every minute. Without dconf, everything is re-read
// every 12 s. Rows are keyed by the dconf path's last segment.
import { RpcError } from "@motherapp/tool-sdk";
import type { JsonObject, JsonValue, Tool } from "@motherapp/tool-sdk";
import { accelLabel } from "./accel.ts";
import { bindingUses, conflictsFor } from "./conflicts.ts";
import type { BindingUse } from "./conflicts.ts";
import { diffState } from "./diff.ts";
import { GnomeError } from "./gnome.ts";
import type { Builtin, Gnome, Shortcut } from "./gnome.ts";
import { buildCommand, checkBinding, commandContext, groupedName, loadTools, missingProgram, warningsFor } from "./ops.ts";
import type { Env } from "./ops.ts";
import type { ToolCommands } from "./suggestions.ts";

export interface Timers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export const POLL_MS = 3000;
export const FULL_MS = 60_000;
export const NO_DCONF_EVERY = 4;
export const INITIAL_STATE: JsonObject = { shortcuts: {}, suggestions: {}, bindings: [], binDir: "", bins: [], binTools: {}, home: "" };

export interface Row {
  [k: string]: string | boolean | number;
  path: string;
  name: string;
  command: string;
  binding: string;
  /** "Ctrl+Shift+F9" */
  label: string;
  owned: boolean;
  order: number;
  /** "Also used by …", or "". */
  conflicts: string;
  /** "…/audioctl doesn't exist …", or "". */
  missing: string;
  /** The entry couldn't be read, or "". */
  error: string;
}

export function rowsFor(list: readonly Shortcut[], uses: readonly BindingUse[], env: Env): Record<string, Row> {
  const out: Record<string, Row> = {};
  for (const s of list) {
    const c = conflictsFor(s.binding, uses, s.id);
    out[s.id] = {
      path: s.path,
      name: s.name,
      command: s.command,
      binding: s.binding,
      label: s.binding ? accelLabel(s.binding) : "(no key)",
      owned: s.owned,
      order: s.order,
      conflicts: c.length ? `Also used by ${c.join(", ")}.` : "",
      missing: s.owned ? missingProgram(s.command, env.exists) : "",
      error: s.error ?? "",
    };
  }
  return out;
}

export interface ServiceOptions {
  tool: Tool;
  gnome: Gnome;
  env: Env;
  timers?: Timers;
}

const str = (v: unknown, what: string): string => {
  if (typeof v !== "string") throw new RpcError(-32602, `${what} must be a string`);
  return v;
};

export class ShortcutsService {
  private tool: Tool;
  private gnome: Gnome;
  private env: Env;
  private timers: Timers;
  private timer: unknown;
  private running = false;
  private inflight: Promise<void> | undefined;
  private lastSnapshot: string | null | undefined;
  private lastFull = -Infinity;
  private ticks = 0;
  private builtins: Builtin[] = [];
  private list: Shortcut[] = [];
  private tools: ToolCommands = { suggestions: [], bins: [], binTools: {}, problems: [] };
  private lastProblem = "";

  constructor(opts: ServiceOptions) {
    this.tool = opts.tool;
    this.gnome = opts.gnome;
    this.env = opts.env;
    this.timers = opts.timers ?? realTimers;
    this.registerActions();
  }

  start(): void {
    this.running = true;
    if (!this.tool.isStale("shortcuts")) this.tool.markStale("shortcuts");
    this.loadSuggestions();
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private loadSuggestions(): void {
    this.tools = loadTools(this.env);
    for (const p of this.tools.problems) this.tool.log.warn(p);
    const map: Record<string, JsonValue> = {};
    const count: Record<string, number> = {};
    for (const s of this.tools.suggestions) {
      const n = (count[s.tool] = (count[s.tool] ?? 0) + 1);
      map[`${s.tool}-${n}`] = s;
    }
    this.publish("suggestions", map);
    this.setIfChanged("binDir", this.env.binDir);
    this.setIfChanged("home", this.env.home);
    this.setIfChanged("bins", this.tools.bins);
    this.setIfChanged("binTools", this.tools.binTools);
  }

  private async tick(): Promise<void> {
    await this.poll();
    if (this.running) this.timer = this.timers.setTimeout(() => void this.tick(), POLL_MS);
  }

  /** One poll: a full read when something changed, a minute passed, or `force`. */
  poll(force = false): Promise<void> {
    const p = (this.inflight ?? Promise.resolve()).then(() => this.pollOnce(force));
    const mine: Promise<void> = p.finally(() => {
      if (this.inflight === mine) this.inflight = undefined;
    });
    this.inflight = mine;
    return mine;
  }

  private async pollOnce(force: boolean): Promise<void> {
    this.ticks++;
    const now = this.timers.now();
    const full = force || now - this.lastFull >= FULL_MS;
    const snap = await this.gnome.snapshot();
    const changed = snap === null ? this.ticks % NO_DCONF_EVERY === 1 : snap !== this.lastSnapshot;
    if (!full && !changed && !this.tool.isStale("shortcuts")) return;
    try {
      if (full) {
        this.builtins = await this.gnome.builtins();
        this.lastFull = now;
      }
      this.list = await this.gnome.list();
      this.lastSnapshot = snap;
      this.publishList();
      this.setStatus(undefined);
      this.problem("");
    } catch (e) {
      const msg = e instanceof GnomeError ? e.message : `reading the shortcuts failed: ${(e as Error).message}`;
      this.problem(msg);
      this.lastSnapshot = undefined; // retry on the next tick
      if (!this.tool.isStale("shortcuts")) this.tool.markStale("shortcuts");
      this.setStatus(`Can't read GNOME's shortcuts: ${msg}`);
    }
  }

  private uses(): BindingUse[] {
    return bindingUses(this.list, this.builtins);
  }

  private publishList(): void {
    const uses = this.uses();
    this.publish("shortcuts", rowsFor(this.list, uses, this.env) as unknown as JsonValue);
    this.setIfChanged("bindings", uses as unknown as JsonValue);
  }

  private publish(key: string, next: JsonValue): void {
    const t = this.tool;
    if (t.isStale(key) || t.get(key) === undefined) {
      t.set(key, next);
      return;
    }
    for (const c of diffState(key, t.get(key), next)) {
      if (c.value === null) t.delete(c.path);
      else t.set(c.path, c.value);
    }
  }

  private setIfChanged(key: string, v: JsonValue): void {
    if (JSON.stringify(this.tool.get(key)) !== JSON.stringify(v) || this.tool.isStale(key)) this.tool.set(key, v);
  }

  private setStatus(text: string | undefined): void {
    const cur = this.tool.get("status");
    if (text === undefined) {
      if (cur !== undefined) this.tool.delete("status");
    } else if (cur !== text) this.tool.set("status", text);
  }

  private problem(msg: string): void {
    if (msg === this.lastProblem) return;
    if (msg) this.tool.log.warn(msg);
    else if (this.lastProblem) this.tool.log.info("GNOME shortcuts readable again");
    this.lastProblem = msg;
  }

  private ownedPath(id: unknown): string {
    const key = str(id, "id");
    if (key === "" || key.includes(".")) throw new RpcError(-32602, "id must be a shortcut id from the state");
    const row = this.tool.get(`shortcuts.${key}`) as Row | undefined;
    if (!row) throw new RpcError(-32000, "That shortcut doesn't exist anymore.");
    if (!row.owned) throw new RpcError(-32000, `'${row.name}' wasn't made by motherapp, so it is read-only here. Change it in GNOME Settings.`);
    return row.path;
  }

  private wrap<T>(f: () => Promise<T>): Promise<T> {
    return f().catch((e: unknown) => {
      if (e instanceof GnomeError) throw new RpcError(-32000, e.message);
      throw e;
    });
  }

  private registerActions(): void {
    const t = this.tool;
    t.action("add", (args) =>
      this.wrap(async () => {
        const name = args.group === undefined ? str(args.name, "name") : groupedName(args.group, str(args.name, "name"));
        const binding = checkBinding(args.binding);
        this.tools = loadTools(this.env);
        const command = buildCommand(args.command, commandContext(this.env, this.tools));
        await this.poll(true); // conflicts against the current list
        const warnings = warningsFor(binding, command, this.uses(), this.env);
        const s = await this.gnome.add({ name, binding, command });
        t.log.info(`added shortcut '${s.name}'`, { path: s.path, binding, command });
        await this.poll(true);
        return { id: s.id, path: s.path, command, warnings };
      }),
    );
    t.action("edit", (args) =>
      this.wrap(async () => {
        const path = this.ownedPath(args.id);
        const fields: { name?: string; binding?: string; command?: string } = {};
        if (args.name !== undefined) fields.name = str(args.name, "name");
        if (args.group !== undefined) fields.name = groupedName(args.group, fields.name, (t.get(`shortcuts.${str(args.id, "id")}.name`) as string | undefined) ?? "");
        if (args.binding !== undefined) fields.binding = checkBinding(args.binding);
        if (args.command !== undefined) fields.command = buildCommand(args.command, commandContext(this.env, loadTools(this.env)));
        const id = str(args.id, "id");
        const row = t.get(`shortcuts.${id}`) as Row;
        const warnings = warningsFor(fields.binding ?? row.binding, fields.command ?? row.command, this.uses(), this.env, id);
        await this.gnome.edit(path, fields);
        t.log.info(`edited shortcut '${fields.name ?? row.name}'`, { path, ...fields });
        await this.poll(true);
        return { id, command: fields.command ?? row.command, warnings };
      }),
    );
    t.action("remove", (args) =>
      this.wrap(async () => {
        const path = this.ownedPath(args.id);
        const name = (t.get(`shortcuts.${str(args.id, "id")}.name`) as string | undefined) ?? path;
        await this.gnome.remove(path);
        t.log.info(`removed shortcut '${name}'`, { path });
        await this.poll(true);
        return null;
      }),
    );
    t.action("refresh", () =>
      this.wrap(async () => {
        this.loadSuggestions();
        await this.poll(true);
        return null;
      }),
    );
  }
}
