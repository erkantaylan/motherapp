// Sidebar order of the tools (issue #20). Pure functions; the manager applies them.
//
// Rules:
// - With a saved `order`: the tools named there come first, in that order. Every other tool
//   (one installed since) follows, alphabetically by id, so a new tool never reshuffles the rest.
//   Unknown ids in the saved order are skipped (and dropped the next time the order is saved).
// - With no saved order (missing or empty): tools with a manifest `order` hint come first, by
//   hint (ties alphabetically), then the rest alphabetically.

export interface OrderableTool {
  id: string;
  /** Manifest `order` hint; only used while the user hasn't saved an order. */
  order?: number;
}

const byId = (a: OrderableTool, b: OrderableTool): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The default order: hinted tools by hint, then the rest alphabetically. */
export function defaultOrder(tools: readonly OrderableTool[]): string[] {
  const hinted = tools.filter((t) => t.order !== undefined).sort((a, b) => a.order! - b.order! || byId(a, b));
  const rest = tools.filter((t) => t.order === undefined).sort(byId);
  return [...hinted, ...rest].map((t) => t.id);
}

/** The display order of `tools` given the saved order (see the rules above). */
export function mergeOrder(tools: readonly OrderableTool[], saved: readonly string[] | undefined): string[] {
  if (!saved || saved.length === 0) return defaultOrder(tools);
  const known = new Set(tools.map((t) => t.id));
  const out: string[] = [];
  for (const id of saved) if (known.has(id) && !out.includes(id)) out.push(id);
  const placed = new Set(out);
  for (const t of [...tools].sort(byId)) if (!placed.has(t.id)) out.push(t.id);
  return out;
}

/**
 * What to save for an order the browser sent: its known ids, in its order, then any known tool
 * it left out (in the current display order). Unknown ids are dropped here. Throws on input
 * that isn't an array of strings.
 */
export function orderToSave(requested: unknown, current: readonly string[]): string[] {
  if (!Array.isArray(requested) || !requested.every((v) => typeof v === "string")) {
    throw new TypeError("order must be an array of tool ids");
  }
  const known = new Set(current);
  const out: string[] = [];
  for (const id of requested as string[]) if (known.has(id) && !out.includes(id)) out.push(id);
  for (const id of current) if (!out.includes(id)) out.push(id);
  return out;
}
