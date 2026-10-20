// A stand-in for Claude Code's TUI in a real tmux pane:   node fake-claude.ts
// - sets process.title = "claude", as Claude Code does, so `#{pane_current_command}` is "claude";
// - draws a screen shaped like Claude Code 2.x: history, an optional spinner line, the input
//   box between two rules, a hint line under it;
// - like the real one, an Enter that arrives in the same read as other keys (text + Enter in ONE
//   send-keys call) becomes part of the input instead of submitting it;
// - a lone Enter submits: the line is appended to $FAKE_CLAUDE_LOG and the pane "works" for
//   $FAKE_CLAUDE_WORK_MS (default 300 ms), showing "esc to interrupt";
// - $FAKE_CLAUDE_SWALLOW=N ignores the first N lone Enters (to exercise the one retry).
import * as fs from "node:fs";

process.title = "claude";
const log = process.env.FAKE_CLAUDE_LOG;
const workMs = Number(process.env.FAKE_CLAUDE_WORK_MS ?? 300);
let swallow = Number(process.env.FAKE_CLAUDE_SWALLOW ?? 0);
let input = "";
let working = false;
const history: string[] = ["● Ready."];

function draw(): void {
  const width = Math.max(20, process.stdout.columns || 80);
  const rule = "─".repeat(width);
  const rows = process.stdout.rows || 24;
  const box = [...(working ? ["✻ Working… (1s · esc to interrupt)", ""] : [""]), rule, `> ${input}`, rule, "  ? for shortcuts"];
  const room = Math.max(0, rows - box.length - 1);
  const lines = [...history.slice(-room), ...box];
  process.stdout.write("\x1b[2J\x1b[H" + lines.map((l) => l.slice(0, width)).join("\r\n"));
}

process.stdin.setRawMode?.(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  if (chunk === "\r" || chunk === "\n") {
    if (swallow > 0) {
      swallow--;
    } else if (input !== "") {
      history.push(`> ${input}`);
      if (log) fs.appendFileSync(log, input + "\n");
      input = "";
      working = true;
      setTimeout(() => {
        working = false;
        history.push("● Done.");
        draw();
      }, workMs);
    }
  } else if (chunk === "\x7f") {
    input = input.slice(0, -1);
  } else if (chunk === "\x15") {
    input = "";
  } else if (chunk === "\x03") {
    process.exit(0);
  } else {
    // Text, possibly with a newline in it: the newline stays in the input, as in Claude Code.
    input += chunk.replace(/\r\n?|\n/g, "↵");
  }
  draw();
});
process.stdout.on("resize", draw);
draw();
