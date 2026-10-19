// The audio tool's declarative page (docs/extension-contract.md § 4): Outputs, Inputs, Apps.
import type { Widget } from "@motherapp/tool-sdk";
import { MAX_APP_VOLUME } from "./pipewire.ts";
import { RECORD_SECONDS } from "./ops.ts";

export const layout: Widget[] = [
  // Shown only while PipeWire can't be read (the key is absent otherwise).
  { type: "text", bind: "status", style: "muted" },
  {
    type: "list",
    label: "Outputs",
    bind: "sinks",
    sort: "title",
    empty: "No output devices.",
    item: {
      label: "{title}",
      sublabel: "{subtitle}",
      widgets: [
        { type: "radio", bind: "defaultSink", value: "{key}", action: "setDefault", args: { id: "{key}" } },
        { type: "button", label: "Test L/R", action: "testOutput", args: { id: "{key}" } },
      ],
    },
  },
  {
    type: "list",
    label: "Inputs",
    bind: "sources",
    sort: "title",
    empty: "No input devices.",
    item: {
      label: "{title}",
      sublabel: "{subtitle}",
      widgets: [
        { type: "radio", bind: "defaultSource", value: "{key}", action: "setDefault", args: { id: "{key}" } },
        { type: "meter", stream: "level/{key}", manual: true },
        { type: "button", label: `Record ${RECORD_SECONDS} s + play back`, action: "recordTest", args: { id: "{key}" } },
      ],
    },
  },
  {
    type: "list",
    label: "Apps",
    bind: "apps",
    sort: "name",
    empty: "No apps are playing sound.",
    item: {
      label: "{name}",
      sublabel: "{detail}",
      widgets: [
        { type: "slider", bind: "apps.{key}.volume", action: "setAppVolume", args: { app: "{key}" }, min: 0, max: MAX_APP_VOLUME, step: 1, unit: "%" },
        { type: "toggle", label: "Mute", bind: "apps.{key}.muted", action: "setAppMute", args: { app: "{key}" } },
      ],
    },
  },
];
