// Declarative page vocabulary (DESIGN.md § 4.1): list, radio, slider, toggle, meter, button, text.
//
// Bindings: `bind` is an absolute dotted state path ("level", "sinks.42.volume").
// Templates: inside a list item, any string field may contain `{key}` (the item's key),
// `{path}` (the item's absolute state path) or `{field}` (a top-level field of the item), e.g.
// `bind: "sinks.{key}.volume"` or `label: "{description}"`.
// Actions: controls call `action` with `{ ...args, value }` where `value` is the new control
// value (toggle: boolean, slider: number, radio: the option value). Buttons send `args` only.

import type { JsonValue } from "./jsonrpc.ts";

export type ActionArgs = { [key: string]: JsonValue };

export interface TextWidget {
  type: "text";
  /** Static text (template). Shown when `bind` is absent or its value is missing. */
  text?: string;
  /** State path whose value is shown. */
  bind?: string;
  style?: "heading" | "body" | "muted";
}

export interface ButtonWidget {
  type: "button";
  label: string;
  action: string;
  args?: ActionArgs;
  style?: "default" | "primary" | "danger";
}

export interface ToggleWidget {
  type: "toggle";
  label?: string;
  bind: string;
  action: string;
  args?: ActionArgs;
}

export interface SliderWidget {
  type: "slider";
  label?: string;
  bind: string;
  action: string;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  args?: ActionArgs;
}

export interface RadioOption {
  value: string | number;
  label: string;
}

/**
 * Two forms:
 * - with `options`: a radio group, checked option = value at `bind`;
 * - with `value` (typical inside a list item): one radio button, checked when the value at
 *   `bind` equals `value`. All buttons sharing a `bind` form one group.
 */
export interface RadioWidget {
  type: "radio";
  label?: string;
  bind: string;
  action: string;
  options?: RadioOption[];
  value?: string | number;
  args?: ActionArgs;
}

/**
 * A level bar. Value source is either a stream (opened only while the meter is shown, or while
 * the user has switched it on when `manual` is true) or a state path. Values outside
 * [min, max] (default 0..1) are clamped.
 */
export interface MeterWidget {
  type: "meter";
  label?: string;
  stream?: string;
  bind?: string;
  min?: number;
  max?: number;
  /** Show an on/off button; the stream is only open while it is on. */
  manual?: boolean;
}

export interface ListItemTemplate {
  /** Row title (template). */
  label?: string;
  /** Smaller second line (template). */
  sublabel?: string;
  /** Controls shown on the row, after the labels. */
  widgets?: Widget[];
}

/**
 * A keyed list. The value at `bind` must be an object map `{ [key]: item }`; rows are keyed by
 * the map key and updated in place (never rebuilt) when items change, appear or vanish.
 * Order: map order, or ascending by the item field named in `sort`.
 */
export interface ListWidget {
  type: "list";
  label?: string;
  bind: string;
  sort?: string;
  empty?: string;
  item: ListItemTemplate;
}

export type Widget =
  | TextWidget
  | ButtonWidget
  | ToggleWidget
  | SliderWidget
  | RadioWidget
  | MeterWidget
  | ListWidget;

export type WidgetType = Widget["type"];

/** Status of a value as shown in the UI. */
export type ValueStatus = "fresh" | "stale";

/** Status dot of a control (DESIGN.md § 4.7). */
export type ControlStatus = "idle" | "setting" | "set" | "failed";
