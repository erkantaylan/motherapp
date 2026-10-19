// Keyed list that updates rows in place (DESIGN.md § 2, § 4.11): existing rows are kept and
// told about their new item, new keys get a row, vanished keys lose theirs, and rows are only
// moved when their position changed. Nothing is ever rebuilt. DOM-free: the host abstracts
// the parent node so the logic is testable without a browser.

export interface RowHost<N> {
  /** Insert or move `node` before `ref` (append when ref is null). */
  insertBefore(node: N, ref: N | null): void;
  remove(node: N): void;
  nextSibling(node: N): N | null;
}

export interface Row<T, N> {
  readonly node: N;
  update(item: T): void;
  destroy(): void;
}

export class KeyedList<T, N> {
  private host: RowHost<N>;
  private create: (key: string, item: T) => Row<T, N>;
  private rows = new Map<string, Row<T, N>>();

  constructor(host: RowHost<N>, create: (key: string, item: T) => Row<T, N>) {
    this.host = host;
    this.create = create;
  }

  get size(): number {
    return this.rows.size;
  }

  row(key: string): Row<T, N> | undefined {
    return this.rows.get(key);
  }

  keys(): string[] {
    return [...this.rows.keys()];
  }

  /** Reconciles to `entries` (in display order). Duplicate keys: the first one wins. */
  update(entries: readonly (readonly [string, T])[]): void {
    const seen = new Set<string>();
    const wanted: (readonly [string, T])[] = [];
    for (const e of entries) {
      if (seen.has(e[0])) continue;
      seen.add(e[0]);
      wanted.push(e);
    }
    for (const [key, row] of this.rows) {
      if (!seen.has(key)) {
        this.host.remove(row.node);
        row.destroy();
        this.rows.delete(key);
      }
    }
    // Walk backwards so each row's successor is already in place.
    let ref: N | null = null;
    for (let i = wanted.length - 1; i >= 0; i--) {
      const [key, item] = wanted[i]!;
      let row = this.rows.get(key);
      if (row) {
        row.update(item);
        if (this.host.nextSibling(row.node) !== ref) this.host.insertBefore(row.node, ref);
      } else {
        row = this.create(key, item);
        this.rows.set(key, row);
        this.host.insertBefore(row.node, ref);
      }
      ref = row.node;
    }
    // Keep map iteration order equal to display order (for keys()).
    if (wanted.some(([k], i) => this.keys()[i] !== k)) {
      const reordered = new Map<string, Row<T, N>>();
      for (const [k] of wanted) reordered.set(k, this.rows.get(k)!);
      this.rows = reordered;
    }
  }

  clear(): void {
    this.update([]);
  }
}

/** Entries of an object-map list value, optionally sorted by an item field. */
export function listEntries(value: unknown, sortField?: string): [string, unknown][] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const entries = Object.entries(value as Record<string, unknown>);
  if (sortField) {
    const field = (v: unknown): unknown =>
      typeof v === "object" && v !== null ? (v as Record<string, unknown>)[sortField] : undefined;
    entries.sort((a, b) => compare(field(a[1]), field(b[1])) || compare(a[0], b[0]));
  }
  return entries;
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (a === undefined) return b === undefined ? 0 : 1;
  if (b === undefined) return -1;
  return String(a).localeCompare(String(b));
}
