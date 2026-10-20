// Link options: defaults, bounds and the duration syntax. Imports nothing, so the custom page
// can load it in the browser too.

export const DEFAULTS = {
  expiresMs: 24 * 3600_000,
  maxUses: 20,
  maxLen: 500,
} as const;

export const BOUNDS = {
  expiresMs: { min: 60_000, max: 30 * 24 * 3600_000 },
  maxUses: { min: 1, max: 1000 },
  maxLen: { min: 20, max: 2000 },
} as const;

/** Messages per minute per link. */
export const RATE_PER_MINUTE = 6;
/** Messages held per link while the pane is busy. */
export const QUEUE_MAX = 10;

const UNIT: Record<string, number> = { s: 1000, m: 60_000, h: 3600_000, d: 86_400_000 };

/** "24h", "90m", "7d", "1h30m", "45s" → ms. Throws on anything else. */
export function parseDuration(s: string): number {
  const t = s.trim().toLowerCase();
  if (!/^(?:\d+[smhd])+$/.test(t)) throw new Error(`bad duration "${s}" (use e.g. 30m, 24h, 7d)`);
  let ms = 0;
  for (const m of t.matchAll(/(\d+)([smhd])/g)) ms += Number(m[1]) * UNIT[m[2]!]!;
  return ms;
}

/** "23 h", "5 min", "40 s", "3 d" until `at`. */
export function remaining(at: number, now: number): string {
  const s = Math.max(0, Math.round((at - now) / 1000));
  if (s < 90) return `${s} s`;
  if (s < 90 * 60) return `${Math.round(s / 60)} min`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}

export interface LinkOptions {
  expiresMs: number;
  maxUses: number;
  maxLen: number;
}

function intIn(v: unknown, name: string, b: { min: number; max: number }, dflt: number): number {
  if (v === undefined || v === null || v === "") return dflt;
  const n = typeof v === "string" ? Number(v.trim()) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < b.min || n > b.max) throw new Error(`${name} must be a whole number from ${b.min} to ${b.max}`);
  return n;
}

/** Validates options from the page or the CLI. `expires` may be ms (number) or "24h". */
export function linkOptions(args: { expires?: unknown; maxUses?: unknown; maxLen?: unknown }): LinkOptions {
  let expiresMs: number = DEFAULTS.expiresMs;
  if (typeof args.expires === "string" && args.expires.trim() !== "") expiresMs = parseDuration(args.expires);
  else if (typeof args.expires === "number") expiresMs = args.expires;
  else if (args.expires !== undefined && args.expires !== null && args.expires !== "") throw new Error("expires must be a duration like 24h");
  if (!Number.isFinite(expiresMs) || expiresMs < BOUNDS.expiresMs.min || expiresMs > BOUNDS.expiresMs.max) {
    throw new Error("expires must be between 1 minute and 30 days");
  }
  return {
    expiresMs,
    maxUses: intIn(args.maxUses, "max uses", BOUNDS.maxUses, DEFAULTS.maxUses),
    maxLen: intIn(args.maxLen, "max length", BOUNDS.maxLen, DEFAULTS.maxLen),
  };
}
