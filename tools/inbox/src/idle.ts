// Is a Claude Code pane idle at its prompt? Decided from `capture-pane -p` (plain text) plus
// `#{pane_in_mode}`. Conservative on purpose: anything it doesn't recognise counts as busy,
// and the message waits. A wrong "busy" only delays a message; a wrong "idle" could mix it
// into what the user is typing, or type it into a permission dialog.
//
// The pane is idle only when ALL of these hold:
// 1. it isn't in copy mode or another tmux mode;
// 2. Claude Code's input box is on screen, near the bottom: a prompt line starting with `>`
//    (optionally inside `│ … │`), with a horizontal rule (`───`, optionally `╭…╮`) directly
//    above it and another below it (after any wrapped input lines), and at most
//    FOOTER_MAX non-empty lines under the box (the mode/shortcut hints);
// 3. the input is empty (or only Claude Code's dim placeholder, `Try "…"`);
// 4. no "esc to interrupt" / "ctrl+c to interrupt" in the few lines just above the box or in
//    the footer: that is the spinner line Claude Code shows while it works.
// A permission or choice dialog replaces the input box (its `❯ 1. Yes` lines aren't a `>`
// prompt under a rule), so rule 2 fails and the message waits.
//
// Written from how Claude Code 2.x draws its screen, NOT checked against the real TUI (see
// docs/lessons/2026-10-20-inbox-tool.md). Fixtures: test/fixtures/screens/.

export type Idle = { idle: true } | { idle: false; reason: string };

export interface Screen {
  /** The input box was found. */
  box: boolean;
  /** Text in the input box (wrapped lines joined), "" when empty. */
  input: string;
  /** The input shows only the placeholder. */
  placeholder: boolean;
  /** The "… to interrupt" spinner hint is near the box. */
  working: boolean;
}

/** How far up from the bottom the prompt line may be. */
const SEARCH_LINES = 20;
/** Non-empty lines allowed under the box (Claude Code's hints, usually 1–2). */
const FOOTER_MAX = 4;
/** Lines above the box searched for the spinner. */
const ABOVE_LINES = 6;
/** Wrapped input lines allowed between the prompt line and the bottom rule. */
const INPUT_LINES_MAX = 12;

const RULE = /^\s*[╭┌]?[─━]{8,}[╮┐]?\s*$|^\s*[╰└]?[─━]{8,}[╯┘]?\s*$/;
const PROMPT = /^\s*(?:│\s?)?>(?:[\s\u00A0]|$)/;
const WORKING = /\b(?:esc|ctrl\+c) to interrupt\b/i;
const PLACEHOLDER = /^Try "[^"]*"(?:\s*…)?$/;

const isRule = (l: string) => RULE.test(l);

/** A line's text inside the box: without `│` borders and outer spaces. */
function inner(line: string): string {
  return line
    .replace(/^\s*│/, "")
    .replace(/│\s*$/, "")
    .replace(/[\s\u00A0]+$/u, "")
    .replace(/^[\s\u00A0]+/u, "");
}

export function analyseScreen(capture: string): Screen {
  const lines = capture.replace(/\r/g, "").split("\n");
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  const none: Screen = { box: false, input: "", placeholder: false, working: false };
  const lowest = Math.max(1, lines.length - SEARCH_LINES);
  for (let p = lines.length - 1; p >= lowest; p--) {
    const line = lines[p]!;
    if (!PROMPT.test(line) || !isRule(lines[p - 1] ?? "")) continue;
    let b = p + 1;
    while (b < lines.length && b - p <= INPUT_LINES_MAX && !isRule(lines[b]!)) b++;
    if (b >= lines.length || !isRule(lines[b]!)) return none;
    const footer = lines.slice(b + 1);
    if (footer.filter((l) => l.trim() !== "").length > FOOTER_MAX) return none;
    const first = inner(line).replace(/^>[\s\u00A0]?/u, "");
    const rest = lines.slice(p + 1, b).map(inner);
    const input = [first, ...rest].filter((s) => s !== "").join(" ").trim();
    const above = lines.slice(Math.max(0, p - 1 - ABOVE_LINES), p - 1);
    const working = [...above, ...footer].some((l) => WORKING.test(l));
    const placeholder = PLACEHOLDER.test(input);
    return { box: true, input: placeholder ? "" : input, placeholder, working };
  }
  return none;
}

/** The decision, with a reason a person can read on the page when it says no. */
export function idleState(capture: string, inMode: boolean): Idle {
  if (inMode) return { idle: false, reason: "the pane is in copy mode" };
  const s = analyseScreen(capture);
  if (!s.box) return { idle: false, reason: "Claude's input box isn't on screen (a dialog, or not Claude's prompt)" };
  if (s.working) return { idle: false, reason: "Claude is working" };
  if (s.input !== "") return { idle: false, reason: "someone is typing in the pane" };
  return { idle: true };
}

/** After typing: does the input box hold our line? (Whitespace ignored: the box wraps it.) */
export function inputHas(capture: string, needle: string): boolean {
  const s = analyseScreen(capture);
  if (!s.box) return false;
  const squash = (x: string) => x.replace(/[\s\u00A0]+/gu, "");
  return squash(s.input).includes(squash(needle));
}
