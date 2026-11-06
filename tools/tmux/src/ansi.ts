// Turns `tmux capture-pane -e` output into styled runs for the preview. Shared by the page, so it
// imports nothing. Only SGR (colours, bold, …) is understood; any other escape is dropped. The
// result is data for textContent and style properties, never HTML.
export const DEFAULT_FG = "#d7dae0";
export const DEFAULT_BG = "#14161a";

export interface Run {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
}

const BASE = ["#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5", "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff"];
const hex = (n: number) => n.toString(16).padStart(2, "0");
const rgb = (r: number, g: number, b: number) => `#${hex(r)}${hex(g)}${hex(b)}`;

export function color256(n: number): string | undefined {
  if (!Number.isInteger(n) || n < 0 || n > 255) return undefined;
  if (n < 16) return BASE[n];
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return rgb(v, v, v);
  }
  const level = (i: number) => (i === 0 ? 0 : 55 + i * 40);
  const i = n - 16;
  return rgb(level(Math.floor(i / 36)), level(Math.floor(i / 6) % 6), level(i % 6));
}

interface Pen {
  fg?: string | undefined;
  bg?: string | undefined;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  reverse?: boolean;
}

/** 38;5;n or 38;2;r;g;b, starting at codes[i] (the 5 or 2). Returns the colour and codes used. */
function extended(codes: number[], i: number): [string | undefined, number] {
  if (codes[i] === 5) return [color256(codes[i + 1] ?? -1), 2];
  if (codes[i] === 2) {
    const [r, g, b] = [codes[i + 1], codes[i + 2], codes[i + 3]];
    return [r !== undefined && g !== undefined && b !== undefined ? rgb(r & 255, g & 255, b & 255) : undefined, 4];
  }
  return [undefined, 0];
}

function applySgr(pen: Pen, params: string): void {
  // "4:3" (curly underline) and the like: the first number says what it is.
  const parts = params === "" ? ["0"] : params.split(";");
  const codes = parts.map((p) => Number(p.split(":")[0] || "0"));
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i]!;
    if (c === 0) {
      for (const k of Object.keys(pen)) delete pen[k as keyof Pen];
    } else if (c === 1) pen.bold = true;
    else if (c === 2) pen.dim = true;
    else if (c === 3) pen.italic = true;
    else if (c === 4) pen.underline = true;
    else if (c === 7) pen.reverse = true;
    else if (c === 9) pen.strike = true;
    else if (c === 22) pen.bold = pen.dim = false;
    else if (c === 23) pen.italic = false;
    else if (c === 24) pen.underline = false;
    else if (c === 27) pen.reverse = false;
    else if (c === 29) pen.strike = false;
    else if (c >= 30 && c <= 37) pen.fg = BASE[c - 30];
    else if (c >= 90 && c <= 97) pen.fg = BASE[c - 90 + 8];
    else if (c >= 40 && c <= 47) pen.bg = BASE[c - 40];
    else if (c >= 100 && c <= 107) pen.bg = BASE[c - 100 + 8];
    else if (c === 39) pen.fg = undefined;
    else if (c === 49) pen.bg = undefined;
    else if (c === 38 || c === 48) {
      const [value, used] = extended(codes, i + 1);
      if (c === 38) pen.fg = value;
      else pen.bg = value;
      i += used;
    }
  }
}

function runOf(text: string, pen: Pen): Run {
  const r: Run = { text };
  const fg = pen.reverse ? (pen.bg ?? DEFAULT_BG) : pen.fg;
  const bg = pen.reverse ? (pen.fg ?? DEFAULT_FG) : pen.bg;
  if (fg) r.fg = fg;
  if (bg) r.bg = bg;
  if (pen.bold) r.bold = true;
  if (pen.dim) r.dim = true;
  if (pen.italic) r.italic = true;
  if (pen.underline) r.underline = true;
  if (pen.strike) r.strike = true;
  return r;
}

// CSI, OSC (hyperlinks; ended by BEL or ST), and any other two-byte escape.
const ESCAPE = /\x1b(?:\[([0-9;:?<=>]*)([@-~])|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[^[\]])/g;

/** One array of runs per line. The pen carries across lines, as it does on a terminal. */
export function parseAnsi(input: string): Run[][] {
  const pen: Pen = {};
  const lines: Run[][] = [];
  for (const line of input.replace(/\n$/, "").split("\n")) {
    const runs: Run[] = [];
    let at = 0;
    const push = (end: number) => {
      if (end > at) runs.push(runOf(line.slice(at, end), pen));
    };
    for (const m of line.matchAll(ESCAPE)) {
      push(m.index);
      at = m.index + m[0].length;
      if (m[2] === "m") applySgr(pen, m[1] ?? "");
    }
    push(line.length);
    lines.push(runs);
  }
  return lines;
}
