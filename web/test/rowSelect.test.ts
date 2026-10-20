// A list row's title and subtitle select its single radio (issue #14). The renderer makes
// `.row-labels` a <label for> that radio, and the row's other controls live outside that label,
// so the browser routes a label click to the radio and a button click to the button only. Which
// radio the label targets is decided here, without a DOM; the clicks themselves were checked in
// Chromium (see docs/lessons/2026-10-20-ui-polish.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Widget } from "@motherapp/protocol";
import { rowSelectRadio } from "../src/rowSelect.ts";
import { interpolateWidget } from "../src/template.ts";

const radio: Widget = { type: "radio", bind: "defaultSink", value: "{key}", action: "setDefault", args: { id: "{key}" } };
const testButton: Widget = { type: "button", label: "Test L/R", action: "testOutput", args: { id: "{key}" } };
const slider: Widget = { type: "slider", bind: "sinks.{key}.volume", action: "setVolume", min: 0, max: 1.5 };
const toggle: Widget = { type: "toggle", bind: "sinks.{key}.mute", action: "setMute" };

test("a click on the row label checks the single radio; a click on a row button doesn't", () => {
  const row = [radio, slider, testButton, toggle].map((w) => interpolateWidget(w, { key: "42", path: "sinks.42", item: {} }));
  // the label points at the radio and nothing else
  assert.equal(rowSelectRadio(row), 0);
  assert.equal(rowSelectRadio([testButton, slider, radio]), 2);
  // rows without a single radio: the labels stay plain text
  assert.equal(rowSelectRadio([testButton, slider, toggle]), undefined);
  assert.equal(rowSelectRadio([]), undefined);
});

test("row labels don't select a radio group, two radios, or a radio without a value", () => {
  const group: Widget = { type: "radio", bind: "mode", action: "setMode", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] };
  assert.equal(rowSelectRadio([group, testButton]), undefined);
  assert.equal(rowSelectRadio([radio, { ...radio, bind: "defaultSource" }]), undefined);
  assert.equal(rowSelectRadio([{ type: "radio", bind: "x", action: "y" }]), undefined);
});
