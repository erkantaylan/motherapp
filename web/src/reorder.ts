// Re-ordering the tools on the Settings page (issue #20), without a DOM: moving an id, where a
// drag drops, the order shown while a save is on its way, and what a screen reader hears.
// settings.ts wires these to the rows, the buttons and Pointer Events.

/** `ids` with the item at `from` moved to index `to` (both clamped). Never mutates `ids`. */
export function moveItem<T>(ids: readonly T[], from: number, to: number): T[] {
  const out = [...ids];
  if (from < 0 || from >= out.length) return out;
  const target = Math.max(0, Math.min(out.length - 1, to));
  const [item] = out.splice(from, 1);
  out.splice(target, 0, item!);
  return out;
}

/**
 * The up/down buttons: `id` moved by `delta` (-1 up, +1 down). Undefined when it can't move
 * (unknown id, already first or last), so the caller does nothing and announces nothing.
 */
export function moveBy(ids: readonly string[], id: string, delta: number): { order: string[]; index: number } | undefined {
  const from = ids.indexOf(id);
  if (from < 0) return undefined;
  const to = from + delta;
  if (to < 0 || to >= ids.length || to === from) return undefined;
  return { order: moveItem(ids, from, to), index: to };
}

export interface RowBox {
  top: number;
  height: number;
}

/**
 * Where the row at `from` belongs while the pointer is at `y`: the number of *other* rows whose
 * middle is above the pointer. Rows are given in display order. Because the dragged row itself
 * doesn't count, the answer stays put once the row has moved there (no flip-flopping).
 */
export function dropIndex(rows: readonly RowBox[], from: number, y: number): number {
  let n = 0;
  rows.forEach((r, i) => {
    if (i !== from && r.top + r.height / 2 < y) n++;
  });
  return n;
}

export function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * The order shown on Settings: the core's, or the user's latest move until the core has caught
 * up with it. Without this, a quick second click could briefly show the first click's result
 * when its broadcast arrives.
 */
export class ReorderModel {
  private pending: string[] | undefined;

  /** The order to show, given the core's current order (`server`). */
  view(server: readonly string[]): string[] {
    if (this.pending && sameOrder(this.pending, server)) this.pending = undefined;
    if (!this.pending) return [...server];
    // Tools that vanished drop out; a tool that appeared meanwhile goes at the end.
    const known = new Set(server);
    const out = this.pending.filter((id) => known.has(id));
    for (const id of server) if (!out.includes(id)) out.push(id);
    return out;
  }

  get hasPending(): boolean {
    return this.pending !== undefined;
  }

  /** Show `order` now (a move or a drag step), before the core confirms it. */
  propose(order: string[]): void {
    this.pending = order;
  }

  /** The core answered the save of `order` (accepted or not): its own order rules again. */
  settle(order: readonly string[]): void {
    if (this.pending === order) this.pending = undefined;
  }

  /** Drop whatever is pending (a cancelled drag). */
  clear(): void {
    this.pending = undefined;
  }
}

/** The aria-live text after a move: "Brightness moved to position 1 of 6". */
export function moveMessage(title: string, index: number, total: number): string {
  return `${title} moved to position ${index + 1} of ${total}`;
}

/**
 * Which of a row's two buttons gets the focus back after a move: the one pressed, unless it is
 * now disabled (the row reached the top or bottom), then the other one.
 */
export function focusTarget(pressed: "up" | "down", index: number, total: number): "up" | "down" {
  if (pressed === "up" && index === 0 && total > 1) return "down";
  if (pressed === "down" && index === total - 1 && total > 1) return "up";
  return pressed;
}
