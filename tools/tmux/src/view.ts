// Display helpers for the page, kept here so they can be tested without a browser. Imports
// nothing: the page loads this through a relative import.

export interface Bar {
  /** 0..1 of the minute it was busy. */
  level: number;
  waiting: boolean;
  /** No data for this minute. */
  empty: boolean;
}

/** Decodes the timeline string (timeline.ts), oldest minute first. */
export function timelineBars(encoded: string): Bar[] {
  return [...encoded].map((c) => {
    if (c === "w") return { level: 1, waiting: true, empty: false };
    if (c === "-") return { level: 0, waiting: false, empty: true };
    return { level: Number(c) / 9, waiting: false, empty: false };
  });
}

/** "12 busy min, 3 waiting, last hour", for the timeline's hover text. */
export function timelineText(encoded: string): string {
  const bars = timelineBars(encoded);
  const known = bars.filter((b) => !b.empty).length;
  if (known === 0) return "No history yet";
  const busy = bars.filter((b) => !b.waiting && b.level > 0).length;
  const waiting = bars.filter((b) => b.waiting).length;
  const span = known >= 60 ? "the last hour" : `the last ${known} min`;
  return `Busy in ${busy} of ${known} min, waited on you in ${waiting}, over ${span}`;
}

/** 1234 → "1.2k", 245000 → "245k", 1200000 → "1.2M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** 12 s, 1 min, 1 h 5 min, 25 h. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h >= 24 || m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export const MONO_RATIO = 0.6;
export const MIN_FONT_PX = 8;
export const MAX_FONT_PX = 14;

/** A font size that fits `cols` into `widthPx`, within reason; below the minimum the box scrolls. */
export function previewFontPx(widthPx: number, cols: number): number {
  if (cols <= 0 || widthPx <= 0) return MAX_FONT_PX;
  const fit = widthPx / (cols * MONO_RATIO);
  return Math.max(MIN_FONT_PX, Math.min(MAX_FONT_PX, Math.floor(fit * 10) / 10));
}
