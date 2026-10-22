// Smallest set of `{ path, value }` changes (value null = delete) that turns one state value
// into another (a copy of tools/tmux/src/diff.ts: tools don't import each other).
// Objects are compared key by key; anything else is replaced whole.
import type { JsonValue } from "@motherapp/tool-sdk";

export interface Change {
  path: string;
  value: JsonValue;
}

const isObj = (v: unknown): v is { [k: string]: JsonValue } => typeof v === "object" && v !== null && !Array.isArray(v);

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  return ak.length === bk.length && ak.every((k) => Object.hasOwn(b, k) && equal((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

export function diffState(path: string, prev: JsonValue | undefined, next: JsonValue | undefined, out: Change[] = []): Change[] {
  if (equal(prev, next)) return out;
  if (isObj(prev) && isObj(next)) {
    for (const k of Object.keys(prev)) if (!Object.hasOwn(next, k)) out.push({ path: `${path}.${k}`, value: null });
    for (const [k, v] of Object.entries(next)) diffState(`${path}.${k}`, prev[k], v, out);
    return out;
  }
  out.push({ path, value: next === undefined ? null : next });
  return out;
}
