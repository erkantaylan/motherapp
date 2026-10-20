// Which control a list row's title and subtitle select (issue #14), without a DOM.
//
// A row whose widgets hold exactly one radio, and that radio is the one-button form (`value`,
// no `options`, e.g. "default device"), renders its labels as `<label for=…>` that radio: a
// click on the title or subtitle checks it and sends its action, natively. The row's other
// controls sit outside the label, so a click on a button, slider or toggle never selects the row.
import type { Widget } from "@motherapp/protocol";

/** Index in `widgets` of the radio the row's labels select, or undefined if there is none. */
export function rowSelectRadio(widgets: readonly Widget[]): number | undefined {
  let found: number | undefined;
  for (const [i, w] of widgets.entries()) {
    if (w.type !== "radio") continue;
    if (w.options !== undefined || w.value === undefined || found !== undefined) return undefined; // a group, or ambiguous
    found = i;
  }
  return found;
}
