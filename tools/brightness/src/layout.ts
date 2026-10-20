// The brightness page (docs/extension-contract.md § 4): a linked "All monitors" slider, then
// one slider per monitor. Text rows bound to keys that are absent when there is nothing to say.
//
// Nothing between the sliders may appear or vanish while one is dragged (issue #12): text that
// changes while the sliders move (`allNote`) goes at the bottom, and bound texts keep their line.
import type { Widget } from "@motherapp/tool-sdk";

export const layout: Widget[] = [
  // Set when libddcutil couldn't be loaded and the ddcutil command is used instead. Changes only
  // when the tool starts, so it takes no space while absent.
  { type: "text", bind: "warning", style: "body", reserve: false },
  // "Looking for monitors…", "No monitors with DDC/CI found…", detection errors. Only set while
  // there are no monitor rows, so it takes no space while absent.
  { type: "text", bind: "status", style: "muted", reserve: false },
  { type: "slider", label: "All monitors", bind: "all.brightness", action: "setAll", min: 0, max: 100, step: 1, unit: "%" },
  {
    type: "list",
    label: "Monitors",
    bind: "monitors",
    sort: "title",
    empty: "No monitors yet.",
    item: {
      label: "{title}",
      // One line, always (the renderer cuts it with an ellipsis): connector plus an optional note.
      sublabel: "{subtitle}",
      widgets: [
        { type: "slider", bind: "monitors.{key}.brightness", action: "setBrightness", args: { id: "{key}" }, min: 0, max: 100, step: 1, unit: "%" },
      ],
    },
  },
  { type: "button", label: "Re-detect monitors", action: "redetect" },
  { type: "text", bind: "backend", style: "muted" },
  // Set while the monitors differ: says that the linked slider shows the average. It comes and
  // goes while sliders are dragged, so it sits last, where nothing below it can move.
  { type: "text", bind: "allNote", style: "muted" },
];
