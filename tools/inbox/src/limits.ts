// Link options and the fixed safety limits. Imports nothing, so the custom page can load it
// in the browser too.
//
// The only per-link option is the expiry, in hours (the user's decision, 2026-10-20: no
// per-link message count or length). The rest are fixed guards, not options: the body cap
// (http.ts), text cleaning (clean.ts), the per-link rate and the bounded queue below.

/** Default expiry, in hours. */
export const DEFAULT_HOURS = 24;
/** Expiry bounds: 1 minute to 30 days. */
export const BOUNDS = { expiresMs: { min: 60_000, max: 30 * 24 * 3600_000 } } as const;

/** Messages per minute per link (protects the pane from a flood). */
export const RATE_PER_MINUTE = 6;
/** Messages held per link while the pane is busy. */
export const QUEUE_MAX = 10;

const UNIT: Record<string, number> = { s: 1000, m: 60_000, h: 3600_000, d: 86_400_000 };

/** "24h", "90m", "7d", "1h30m", "45s" → ms. Throws on anything else. */
export function parseDuration(s: string): number {
  const t = s.trim().toLowerCase();
  if (!/^(?:\d+[smhd])+$/.test(t)) throw new Error(`bad duration "${s}" (use hours, e.g. 24, or 30m, 7d)`);
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
}

/**
 * Validates options from the page or the CLI. `hours` is a number of hours (number or numeric
 * string, e.g. 24 or "1.5"). `expires` is the same, or a duration like "90m" or "7d".
 */
export function linkOptions(args: { hours?: unknown; expires?: unknown }): LinkOptions {
  const raw = args.hours ?? args.expires;
  let expiresMs = DEFAULT_HOURS * 3600_000;
  if (typeof raw === "number") expiresMs = raw * 3600_000;
  else if (typeof raw === "string" && raw.trim() !== "") {
    const t = raw.trim();
    expiresMs = /^\d+(?:\.\d+)?$/.test(t) ? Number(t) * 3600_000 : parseDuration(t);
  } else if (raw !== undefined && raw !== null && raw !== "") throw new Error("the expiry must be a number of hours, e.g. 24");
  if (!Number.isFinite(expiresMs) || expiresMs < BOUNDS.expiresMs.min || expiresMs > BOUNDS.expiresMs.max) {
    throw new Error("the expiry must be between 1 minute and 30 days (720 hours)");
  }
  return { expiresMs: Math.round(expiresMs) };
}
