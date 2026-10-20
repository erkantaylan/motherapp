// Bound text widgets keep their line while the value comes and goes (issue #12).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { TextWidget } from "@motherapp/protocol";
import { textView } from "../src/textWidget.ts";

test("a text widget whose bound value comes and goes keeps its height", () => {
  const w: TextWidget = { type: "text", bind: "allNote", style: "muted" };
  const seen = [textView(w, "The monitors differ…"), textView(w, undefined), textView(w, "again"), textView(w, undefined)];
  assert.deepEqual(
    seen.map((v) => v.text),
    ["The monitors differ…", "", "again", ""],
  );
  assert.ok(seen.every((v) => v.reserve), "the line is reserved with and without a value");
  // ... and the class it sets really holds one line open.
  const scss = readFileSync(new URL("../src/styles.scss", import.meta.url), "utf8");
  assert.match(scss, /\.w-text\.reserve\s*\{\s*min-height:\s*1lh;?\s*\}/);
});

test("reserve: false opts out; a static text reserves nothing", () => {
  assert.equal(textView({ type: "text", bind: "warning", reserve: false }, undefined).reserve, false);
  assert.deepEqual(textView({ type: "text", text: "Hello" }, undefined), { text: "Hello", reserve: false });
  // a bound text falls back to its static text while the value is absent
  assert.deepEqual(textView({ type: "text", bind: "n", text: "–" }, undefined), { text: "–", reserve: true });
  assert.equal(textView({ type: "text", bind: "n" }, 3).text, "3");
  assert.equal(textView({ type: "text", bind: "o" }, { a: 1 }).text, '{"a":1}');
});
