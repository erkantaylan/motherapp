// Typing text into a session, for the page's Send box and `tmuxctl send`. The one thing this tool
// does that isn't read-only or housekeeping (the user's decision, 2026-11-10, DESIGN.md § 3).
//
// Enter is never part of the text. It is its own, second tmux call, after a pause:
//   1. display-message -p -t '$3:'       which pane (the session's active one), and is it in copy mode
//   2. the text, never a line break at its end:
//        one line:       send-keys -t %7 -l -- <text>               literal keys
//        several lines, a tab, or over 2000 characters:
//                        set-buffer -b <name> -- <text>, then
//                        paste-buffer -p -d -b <name> -t %7         a bracketed paste
//   3. wait ENTER_DELAY_MS
//   4. send-keys -t %7 Enter
// Why (measured 2026-11-10 on Claude Code 2.1.322 and tmux 3.6a, docs/lessons/2026-11-10-tmux-send.md):
// - A "\n" sent with the text does not submit in Claude Code and isn't a line break either:
//   `send-keys -l` with "a\nb" arrives as "ab". The Enter key (a carriage return) submits.
// - A bracketed paste keeps the lines in Claude's input box and in a shell's (bash, zsh) without
//   running anything; the Enter after it submits or runs the whole text once.
//
// The text can hold secrets, like the preview: it goes to tmux and nowhere else. Never into
// state, never into a log (only the session and the length are logged).
import type { Tmux } from "./tmux.ts";
import { CHUNK_CHARS, TmuxError } from "./tmux.ts";

/** Between the text and Enter. The inbox tool's value (tools/inbox/src/settings.ts); see the lesson. */
export const ENTER_DELAY_MS = 200;
/** UTF-16 units, before cleaning. A guard, not a feature: a prompt is far below it. */
export const MAX_SEND_CHARS = 32_000;

export const NOTHING_TO_SEND = "There is no text to send.";
export const COPY_MODE = "That pane is in copy mode (scrolled back in tmux). Leave it with q, then send again.";

/**
 * What is typed: line ends as "\n", no control characters other than "\n" and tab (an ESC could
 * end a bracketed paste early or be read as a key), and no line breaks at the end, since Enter
 * is not the text's business.
 */
export function cleanSendText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
    .replace(/\n+$/, "");
}

/**
 * Needs a paste: typed as keys, a line break would be lost or run a line, and a tab would
 * complete. So does text too long for one tmux command: typed in parts, Claude showed each part
 * as a "[Pasted text]" of its own; pasted, it is one.
 */
export const needsPaste = (text: string): boolean => /[\n\t]/.test(text) || text.length > CHUNK_CHARS;

export interface SendOptions {
  /** Press Enter after the text. */
  enter: boolean;
  sleep: (ms: number) => Promise<void>;
  delayMs?: number;
}

export interface Sent {
  /** Pane id the text went to. */
  pane: string;
  /** Length of what was typed, in characters (code points). Safe to log; the text is not. */
  chars: number;
  pasted: boolean;
  enter: boolean;
}

export const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Types `raw` into the active pane of the session with this id ("$3"), then presses Enter if asked. */
export async function sendToSession(tmux: Tmux, id: string, raw: string, opts: SendOptions): Promise<Sent> {
  if (raw.length > MAX_SEND_CHARS) throw new TmuxError(`That text is too long to send (${raw.length} characters, at most ${MAX_SEND_CHARS}).`);
  const text = cleanSendText(raw);
  if (text === "") throw new TmuxError(NOTHING_TO_SEND);
  // The pane is fixed here, so the text and Enter can't land in two different panes.
  const target = await tmux.activePane(id);
  if (target.inMode) throw new TmuxError(COPY_MODE);
  const pasted = needsPaste(text);
  if (pasted) await tmux.paste(target.pane, text);
  else await tmux.typeLiteral(target.pane, text);
  if (opts.enter) {
    await opts.sleep(opts.delayMs ?? ENTER_DELAY_MS);
    await tmux.pressEnter(target.pane);
  }
  return { pane: target.pane, chars: [...text].length, pasted, enter: opts.enter };
}
