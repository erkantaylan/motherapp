// Minimal state deltas: compares the published state with a newly derived one and returns the
// smallest set of `{ path, value }` changes (value null = delete) that turns one into the other.
import type { Json } from "./pipewire.ts";

export interface Change {
  path: string;
  value: Json;
}

const isObj = (v: unknown): v is { [k: string]: Json } => typeof v === "object" && v !== null && !Array.isArray(v);

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => deepEqual(x, bb[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  if (ak.length !== Object.keys(bo).length) return false;
  return ak.every((k) => k in bo && deepEqual(ao[k], bo[k]));
}

/**
 * Changes that turn `prev` into `next` at `path`. Objects are compared key by key (a new or
 * changed leaf is one change, a vanished key is `null`); anything else is replaced whole.
 */
export function diffState(path: string, prev: Json | undefined, next: Json | undefined, out: Change[] = []): Change[] {
  if (deepEqual(prev, next)) return out;
  if (isObj(prev) && isObj(next)) {
    for (const k of Object.keys(prev)) if (!(k in next)) out.push({ path: `${path}.${k}`, value: null });
    for (const [k, v] of Object.entries(next)) diffState(`${path}.${k}`, prev[k], v, out);
    return out;
  }
  out.push({ path, value: next === undefined ? null : next });
  return out;
}
