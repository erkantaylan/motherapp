// The brightness page (docs/extension-contract.md § 4): a linked "All monitors" slider, then
// one slider per monitor. Text rows bound to keys that are absent when there is nothing to say.
import type { Widget } from "@motherapp/tool-sdk";

export const layout: Widget[] = [
  // Set when libddcutil couldn't be loaded and the ddcutil command is used instead.
  { type: "text", bind: "warning", style: "body" },
  // "Looking for monitors…", "No monitors with DDC/CI found…", detection errors.
  { type: "text", bind: "status", style: "muted" },
  { type: "slider", label: "All monitors", bind: "all.brightness", action: "setAll", min: 0, max: 100, step: 1, unit: "%" },
  // Set while the monitors differ: says that the linked slider shows the average.
  { type: "text", bind: "allNote", style: "muted" },
  {
    type: "list",
    label: "Monitors",
    bind: "monitors",
    sort: "title",
    empty: "No monitors yet.",
    item: {
      label: "{title}",
      sublabel: "{subtitle}",
      widgets: [
        { type: "slider", bind: "monitors.{key}.brightness", action: "setBrightness", args: { id: "{key}" }, min: 0, max: 100, step: 1, unit: "%" },
      ],
    },
  },
  { type: "button", label: "Re-detect monitors", action: "redetect" },
  { type: "text", bind: "backend", style: "muted" },
];
