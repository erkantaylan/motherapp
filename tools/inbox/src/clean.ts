// Cleaning text a link holder sends before it is typed into a Claude pane. The result is one
// line of printable characters: no control characters, no escape sequences, no bidi or other
// format characters, no newlines or tabs (both folded to spaces), whitespace collapsed.
//
// Order matters: escape sequences are removed first (so their parameters don't survive as
// text once ESC is gone), then whitespace of every kind becomes a space, then every remaining
// character in Unicode category C (Cc control, Cf format incl. bidi overrides and zero-width
// characters, Cs lone surrogates, Co private use, Cn unassigned) is dropped.

/**
 * Escape sequences, 7-bit and 8-bit forms:
 * - CSI: ESC [ or 0x9B, parameters 0x30–0x3F, intermediates 0x20–0x2F, final 0x40–0x7E;
 * - OSC/DCS/SOS/PM/APC: ESC ] P X ^ _ or 0x9D 0x90 0x98 0x9E 0x9F, up to BEL, ST (ESC \ or
 *   0x9C) or the end of the text (an unterminated string swallows the rest: conservative);
 * - any other ESC: intermediates, then one final byte.
 */
const ESCAPES =
  /\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]?|\x9b[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]?|(?:\x1b[\]PX^_]|[\x90\x98\x9d\x9e\x9f])[\s\S]*?(?:\x07|\x1b\\|\x9c|$)|\x1b[\x20-\x2f]*[\x30-\x7e]?/g;

/** Every kind of whitespace and line break, plus the C0 separators tmux or a TUI might act on. */
const SPACES = /[\t\n\v\f\r\x1c-\x1f\x85\p{Zs}\p{Zl}\p{Zp}]/gu;

/** Unicode "other": control, format (bidi, zero-width, BOM, soft hyphen), surrogate, private, unassigned. */
const OTHER = /\p{C}/gu;

/** Number of code points (what the length limit counts). */
export function codePoints(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** Cuts to at most `max` code points (never splits a surrogate pair). */
export function capCodePoints(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = "";
  let n = 0;
  for (const ch of s) {
    if (n++ >= max) break;
    out += ch;
  }
  return out;
}

/**
 * One clean line. `max` caps the length in code points (after cleaning); omit it to get the
 * whole cleaned text, e.g. to check it against a limit first.
 */
export function cleanText(raw: string, max?: number): string {
  let s = String(raw).normalize("NFC");
  s = s.replace(ESCAPES, "");
  s = s.replace(SPACES, " ");
  s = s.replace(OTHER, "");
  // Removing a character between a letter and its combining mark can make a new NFC pair.
  s = s.normalize("NFC");
  s = s.replace(/ {2,}/g, " ").trim();
  if (max !== undefined) s = capCodePoints(s, max).trim();
  return s;
}

export const LABEL_MAX = 32;

/**
 * A link label: cleaned, then only letters, digits, space and `. _ # @ / : + -` (no brackets,
 * so a label can't close the `[inbox: …]` prefix early), at most 32 code points.
 */
export function cleanLabel(raw: string): string {
  const s = cleanText(raw)
    .replace(/[^\p{L}\p{N} ._#@/:+-]/gu, "")
    .replace(/ {2,}/g, " ")
    .trim();
  return capCodePoints(s, LABEL_MAX).trim() || "peer";
}

/** The optional `ref` of a message: an issue, PR or commit, e.g. "#10", "abc1234", "PR 12". */
export function cleanRef(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return capCodePoints(
    cleanText(raw)
      .replace(/[^\p{L}\p{N} ._#@/:+-]/gu, "")
      .trim(),
    40,
  ).trim();
}

/**
 * The line typed into the pane. The prefix is always first, so the text can never start a
 * Claude Code slash command (`/`), bash mode (`!`) or memory shortcut (`#`).
 */
export function deliveredLine(label: string, text: string, ref = ""): string {
  return `[inbox: ${label}]${ref ? ` (re ${ref})` : ""} ${text}`;
}

/**
 * tmux reads an argument that ends in `;` as a command separator and drops the `;` (checked
 * against tmux 3.4: `send-keys -l -- 'hello;'` types "hello"); a trailing `\;` becomes `;`.
 * So a text ending in `;` is sent ending in `\;`, which tmux turns back into exactly the text.
 */
export function tmuxLiteralArg(text: string): string {
  return text.endsWith(";") ? `${text.slice(0, -1)}\\;` : text;
}
