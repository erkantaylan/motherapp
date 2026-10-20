// Which shortcuts already use a key combination. Browser-safe (page.ts checks while you
// capture), so it imports only accel.ts.
import { normalizeAccel } from "./accel.ts";

/** One key combination something already uses. */
export interface BindingUse {
  /** normalizeAccel() of the binding. */
  accel: string;
  /** "custom shortcut 'CopyQ'", "GNOME Shell: toggle-overview". */
  what: string;
  /** State id of the custom shortcut, so editing one doesn't conflict with itself. */
  id?: string;
}

export interface CustomLike {
  id: string;
  name: string;
  binding: string;
}

export interface BuiltinLike {
  title: string; // "GNOME Shell"
  key: string; // "toggle-overview"
  accel: string; // as stored
}

export function bindingUses(custom: readonly CustomLike[], builtins: readonly BuiltinLike[]): BindingUse[] {
  const out: BindingUse[] = [];
  for (const c of custom) {
    const a = normalizeAccel(c.binding);
    if (a) out.push({ accel: a, what: `custom shortcut '${c.name}'`, id: c.id });
  }
  for (const b of builtins) {
    const a = normalizeAccel(b.accel);
    if (a) out.push({ accel: a, what: `${b.title}: ${b.key}` });
  }
  return out;
}

/** What else uses `binding` (none for an unparsable one), not counting the shortcut `selfId`. */
export function conflictsFor(binding: string, uses: readonly BindingUse[], selfId?: string): string[] {
  const a = normalizeAccel(binding);
  if (!a) return [];
  const seen = new Set<string>();
  for (const u of uses) if (u.accel === a && (selfId === undefined || u.id !== selfId)) seen.add(u.what);
  return [...seen];
}
