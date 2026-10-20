// What a `text` widget shows, without a DOM (issue #12). A bound text reserves one line
// (`.w-text.reserve`, min-height: 1lh in styles.scss) whether or not its value is present, so a
// value that comes and goes never moves what's below it.
import type { JsonValue, TextWidget } from "@motherapp/protocol";

export interface TextView {
  text: string;
  /** Keep one line of height even when `text` is empty. */
  reserve: boolean;
}

function display(v: JsonValue | undefined): string {
  if (v === undefined || v === null) return "";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

/** `value` is the current value at `w.bind` (undefined when absent or unbound). */
export function textView(w: TextWidget, value: JsonValue | undefined): TextView {
  return {
    text: value !== undefined ? display(value) : (w.text ?? ""),
    reserve: w.bind !== undefined && w.reserve !== false,
  };
}
