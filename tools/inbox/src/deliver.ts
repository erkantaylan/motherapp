// Typing one message into a Claude Code pane so that it is submitted.
//
// Text and Enter in ONE send-keys call does not submit in Claude Code: the newline becomes part
// of the input (docs/lessons/2026-10-20-tmux-send-enter.md). So, as separate tmux calls:
//   1. send-keys -t <pane> -l -- "<line>"     literal text, never a newline
//   2. wait `delayMs` (default 200 ms)
//   3. capture-pane: is our line in the input box? If not, stop WITHOUT pressing Enter (the keys
//      went somewhere else, e.g. a dialog that just opened; Enter could confirm it)
//   4. send-keys -t <pane> Enter
//   5. wait `verifyDelayMs`, capture-pane again: if our line is still in the input box, press
//      Enter once more and record "submitted: retried". Never more than that.
//
// "Deliver now" (`force`, a person's override on the page when the idle check says busy): the
// same two calls, but the input box may not be recognised, so step 3 instead checks that the
// start of our line appears on screen more often than before typing, and there is no retry in
// step 5 (a submitted line stays visible in the transcript, so it can't tell).
import { analyseScreen } from "./idle.ts";

export interface KeySender {
  capture(paneId: string): Promise<string>;
  sendLiteral(paneId: string, text: string): Promise<void>;
  sendEnter(paneId: string): Promise<void>;
}

export interface DeliverOptions {
  keys: KeySender;
  sleep: (ms: number) => Promise<void>;
  delayMs: number;
  verifyDelayMs: number;
  /** false: type, wait, press Enter, without reading the screen (settings.checkScreen). */
  checkScreen?: boolean;
  /** "Deliver now": don't rely on recognising the input box (see above). */
  force?: boolean;
}

export type DeliveryResult =
  | "submitted"
  | "submitted: retried"
  | "sent (screen not checked)"
  | "submitted (delivered now by hand)"
  | "not submitted: text not seen in Claude's input box"
  | "not submitted: text not seen on screen (delivered now by hand)";

export interface Delivery {
  result: DeliveryResult;
  /** Enter was pressed at least once. */
  submitted: boolean;
}

/** Our line (or Claude Code's collapsed "[Pasted text #1 …]" for it) is in the input box. */
export function showsOurLine(capture: string): boolean {
  const s = analyseScreen(capture);
  if (!s.box) return false;
  const squashed = s.input.replace(/[\s\u00A0]+/gu, "");
  return squashed.includes("[inbox:") || /^\[Pasted text #\d+/.test(s.input);
}

const squash = (s: string) => s.replace(/[\s\u00A0│]+/gu, "");

/** How often the start of `line` (whitespace and box borders ignored) appears in `capture`. */
export function countOnScreen(capture: string, line: string): number {
  const needle = squash(line).slice(0, 40);
  if (needle === "") return 0;
  const hay = squash(capture);
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

async function forceSubmit(opts: DeliverOptions, paneId: string, line: string): Promise<Delivery> {
  const { keys, sleep } = opts;
  const before = countOnScreen(await keys.capture(paneId), line);
  await keys.sendLiteral(paneId, line);
  await sleep(opts.delayMs);
  if (countOnScreen(await keys.capture(paneId), line) <= before) {
    return { result: "not submitted: text not seen on screen (delivered now by hand)", submitted: false };
  }
  await keys.sendEnter(paneId);
  return { result: "submitted (delivered now by hand)", submitted: true };
}

export async function typeAndSubmit(opts: DeliverOptions, paneId: string, line: string): Promise<Delivery> {
  if (opts.force) return forceSubmit(opts, paneId, line);
  const { keys, sleep } = opts;
  await keys.sendLiteral(paneId, line);
  await sleep(opts.delayMs);
  if (opts.checkScreen === false) {
    await keys.sendEnter(paneId);
    return { result: "sent (screen not checked)", submitted: true };
  }
  if (!showsOurLine(await keys.capture(paneId))) {
    return { result: "not submitted: text not seen in Claude's input box", submitted: false };
  }
  await keys.sendEnter(paneId);
  await sleep(opts.verifyDelayMs);
  if (showsOurLine(await keys.capture(paneId))) {
    await keys.sendEnter(paneId);
    return { result: "submitted: retried", submitted: true };
  }
  return { result: "submitted", submitted: true };
}
