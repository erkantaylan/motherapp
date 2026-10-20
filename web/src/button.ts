// What a button click does (`ButtonWidget`: confirm → copy → action), and copying to the
// clipboard with fallbacks. DOM-free: the renderer passes in the dialog and clipboard parts,
// so this logic is testable without a browser.
import type { ActionArgs, ButtonWidget, JsonValue } from "@motherapp/protocol";
import { NO_ROW, interpolate } from "./template.ts";
import type { TemplateContext } from "./template.ts";

export interface ButtonDeps {
  /** The row's template context at click time; absent outside a list. */
  template?: (() => TemplateContext) | undefined;
  get(path: string): JsonValue | undefined;
  /** Shows the confirm dialog; resolves true for OK, false for Cancel/Escape. */
  confirm(text: string): Promise<boolean>;
  copy(text: string): Promise<unknown>;
  /** Sends the action (absent when the button has none). */
  send?: ((args: ActionArgs) => void) | undefined;
}

export type ClickOutcome = "cancelled" | "done";

/** The confirm text for a click now, or undefined when the button doesn't ask. */
export function confirmText(w: ButtonWidget, template?: () => TemplateContext): string | undefined {
  return w.confirm === undefined ? undefined : interpolate(w.confirm, template?.() ?? NO_ROW);
}

/** The text to copy for a click now, or undefined when the button doesn't copy. */
export function copyText(w: ButtonWidget, get: (path: string) => JsonValue | undefined, template?: () => TemplateContext): string | undefined {
  if (w.copy === undefined) return undefined;
  if (typeof w.copy === "string") return interpolate(w.copy, template?.() ?? NO_ROW);
  const v = get(w.copy.bind);
  if (v === undefined || v === null) return "";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

/** Buttons that ask first look dangerous unless the tool chose a style. */
export function buttonStyle(w: ButtonWidget): NonNullable<ButtonWidget["style"]> {
  return w.style ?? (w.confirm !== undefined ? "danger" : "default");
}

/** Runs one click. Cancel in the confirm dialog stops everything: nothing is copied or sent. */
export async function clickButton(w: ButtonWidget, deps: ButtonDeps): Promise<ClickOutcome> {
  const question = confirmText(w, deps.template);
  if (question !== undefined && !(await deps.confirm(question))) return "cancelled";
  const text = copyText(w, deps.get, deps.template);
  if (text !== undefined) await deps.copy(text);
  if (w.action !== undefined && deps.send) deps.send(w.args ?? {});
  return "done";
}

/** "copied": it is on the clipboard. "manual": the user was shown the text to copy by hand. */
export type CopyOutcome = "copied" | "manual";

export interface CopyEnv {
  /** `navigator.clipboard.writeText`, when the page has it (secure contexts only). */
  writeText?: ((text: string) => Promise<void>) | undefined;
  /** Hidden textarea + `document.execCommand("copy")`; true when the browser says it copied. */
  execCopy?: ((text: string) => boolean) | undefined;
  /** Last resort: show the text selected, with "press Ctrl+C". */
  manual(text: string): Promise<void>;
}

export async function copyToClipboard(text: string, env: CopyEnv): Promise<CopyOutcome> {
  if (env.writeText) {
    try {
      await env.writeText(text);
      return "copied";
    } catch {
      // denied or unavailable: try the old way
    }
  }
  if (env.execCopy) {
    try {
      if (env.execCopy(text)) return "copied";
    } catch {
      // fall through
    }
  }
  await env.manual(text);
  return "manual";
}
