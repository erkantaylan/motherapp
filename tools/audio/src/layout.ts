// The audio tool's declarative page (docs/extension-contract.md § 4): Outputs, Inputs, Apps.
import type { Widget } from "@motherapp/tool-sdk";
import { MAX_APP_VOLUME, MAX_MASTER_VOLUME } from "./pipewire.ts";
import { RECORD_SECONDS } from "./ops.ts";

export const layout: Widget[] = [
  // Master volume and mute: two fixed rows (Output, Mic) that follow the defaults. The caption
  // ("Acts on: <device>") is always one line, so nothing moves while a slider is dragged.
  // Nothing that comes and goes may sit above these rows (#12).
  {
    type: "list",
    bind: "master",
    sort: "order",
    item: {
      label: "{role}",
      sublabel: "{caption}",
      widgets: [
        { type: "slider", label: "{role} volume", bind: "master.{key}.volume", action: "setMasterVolume", args: { kind: "{key}" }, min: 0, max: MAX_MASTER_VOLUME, step: 1, unit: "%" },
        { type: "toggle", label: "Mute", bind: "master.{key}.muted", action: "setMasterMute", args: { kind: "{key}" } },
      ],
    },
  },
  // Shown only while PipeWire can't be read (the key is absent otherwise). Below the master
  // rows, so its coming and going never moves them.
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
