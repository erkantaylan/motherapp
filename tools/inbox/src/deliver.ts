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
}

export type DeliveryResult = "submitted" | "submitted: retried" | "not submitted: text not seen in Claude's input box";

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

export async function typeAndSubmit(opts: DeliverOptions, paneId: string, line: string): Promise<Delivery> {
  const { keys, sleep } = opts;
  await keys.sendLiteral(paneId, line);
  await sleep(opts.delayMs);
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
