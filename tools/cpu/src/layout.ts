// The CPU tool's declarative page: header, one row per CCX, one row per physical core, the
// sensors, and the two saved profiles (underclock, overclock) with the active one,
// read-only. Nothing on it writes to the hardware.
import type { Widget } from "@motherapp/tool-sdk";
import { NOT_AVAILABLE_TEXT } from "./model.ts";

export const layout: Widget[] = [
  { type: "text", bind: "cpu.model", style: "heading" },
  { type: "text", bind: "cpu.summary" },
  // Something under /sys couldn't be read; absent normally. No controls on the page, so it
  // can come and go without moving anything under a pointer.
  { type: "text", bind: "status", style: "muted", reserve: false },
  {
    type: "list",
    label: "Core complexes",
    bind: "ccx",
    sort: "order",
    empty: "No CCX found.",
    item: {
      label: "{name}",
      sublabel: "{detail}",
      widgets: [
        { type: "meter", bind: "ccx.{key}.fraction" },
        { type: "text", bind: "ccx.{key}.value" },
      ],
    },
  },
  {
    type: "list",
    label: "Cores",
    bind: "cores",
    sort: "order",
    empty: "No cores found.",
    item: {
      label: "{name}",
      sublabel: "{detail}",
      widgets: [
        { type: "meter", bind: "cores.{key}.fraction" },
        { type: "text", bind: "cores.{key}.value" },
      ],
    },
  },
  {
    type: "list",
    label: "Temperatures and fans",
    bind: "sensors",
    sort: "order",
    empty: "No k10temp or asusec sensors found.",
    item: { label: "{name}", sublabel: "{detail}", widgets: [{ type: "text", bind: "sensors.{key}.value" }] },
  },
  { type: "text", text: NOT_AVAILABLE_TEXT, style: "muted" },
  {
    type: "list",
    label: "Saved profiles (reference)",
    bind: "profiles",
    sort: "order",
    empty: "No profiles saved.",
    item: { label: "{name}", sublabel: "{detail}", widgets: [{ type: "text", bind: "profiles.{key}.value" }] },
  },
  { type: "text", bind: "profilesActive" },
  { type: "text", bind: "profilesNote", style: "muted" },
  { type: "text", bind: "profilesStatus", style: "muted", reserve: false },
];
