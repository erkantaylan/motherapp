// State paths, delta application and stale tracking, shared by SDK, core and browser.
// A path is a dotted string of keys ("sinks.42.volume"); "" is the root. Keys must not contain
// "." — use ids, not names, as map keys.

import type { JsonObject, JsonValue } from "./jsonrpc.ts";
import type { StateChange } from "./tool.ts";

export function splitPath(path: string): string[] {
  return path === "" ? [] : path.split(".");
}

export function joinPath(...parts: string[]): string {
  return parts.filter((p) => p !== "").join(".");
}

/** True when `a` equals `b` or is an ancestor of it. */
export function isPrefixPath(a: string, b: string): boolean {
  return a === "" || a === b || b.startsWith(a + ".");
}

/** True when a change at one path can affect a reader of the other. */
export function pathsOverlap(a: string, b: string): boolean {
  return isPrefixPath(a, b) || isPrefixPath(b, a);
}

function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function getPath(state: JsonValue | undefined, path: string): JsonValue | undefined {
  let cur: JsonValue | undefined = state;
  for (const key of splitPath(path)) {
    if (Array.isArray(cur)) cur = cur[Number(key)];
    else if (isObject(cur)) cur = Object.hasOwn(cur, key) ? cur[key] : undefined;
    else return undefined;
  }
  return cur;
}

/**
 * Applies one change in place. `value: null` deletes. Missing or non-object intermediate
 * values are replaced by objects. A change at the root ("") replaces the whole state and must
 * carry an object.
 */
export function applyChange(state: JsonObject, change: StateChange): void {
  const keys = splitPath(change.path);
  if (keys.length === 0) {
    for (const k of Object.keys(state)) delete state[k];
    if (isObject(change.value)) Object.assign(state, change.value);
    return;
  }
  let cur: JsonObject | JsonValue[] = state;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]!;
    const next: JsonValue | undefined = Array.isArray(cur) ? cur[Number(key)] : cur[key];
    if (isObject(next) || Array.isArray(next)) {
      cur = next;
    } else {
      if (change.value === null) return; // deleting below something that isn't there
      const created: JsonObject = {};
      if (Array.isArray(cur)) cur[Number(key)] = created;
      else cur[key] = created;
      cur = created;
    }
  }
  const last = keys[keys.length - 1]!;
  if (Array.isArray(cur)) {
    const i = Number(last);
    if (change.value === null) cur.splice(i, 1);
    else cur[i] = change.value;
  } else if (change.value === null) {
    delete cur[last];
  } else {
    cur[last] = change.value;
  }
}

export function applyChanges(state: JsonObject, changes: readonly StateChange[]): void {
  for (const c of changes) applyChange(state, c);
}

/** Set of stale paths. A stale path covers everything below it. */
export class StaleSet {
  private paths = new Set<string>();

  mark(path: string): void {
    this.paths.add(path);
  }

  /** Marks `path` and everything below it fresh. Ancestors stay stale. */
  clear(path: string): void {
    for (const p of this.paths) if (isPrefixPath(path, p)) this.paths.delete(p);
  }

  clearAll(): void {
    this.paths.clear();
  }

  /** True when `path` or one of its ancestors is stale. */
  isStale(path: string): boolean {
    for (const p of this.paths) if (isPrefixPath(p, path)) return true;
    return false;
  }

  /** Applies the stale bit of a change: stale marks, anything else clears. */
  apply(change: StateChange): void {
    if (change.stale) this.mark(change.path);
    else this.clear(change.path);
  }

  reset(paths: readonly string[] | undefined): void {
    this.paths = new Set(paths ?? []);
  }

  list(): string[] {
    return [...this.paths];
  }

  get size(): number {
    return this.paths.size;
  }
}
