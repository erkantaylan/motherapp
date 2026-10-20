// Accelerators: parsing and comparing GNOME's syntax, labels, and KeyboardEvent capture.
import { test } from "node:test";
import assert from "node:assert/strict";
import { accelLabel, bindingProblem, bindingWarning, captureKey, normalizeAccel, parseAccel } from "../src/accel.ts";
import type { KeyLike } from "../src/accel.ts";
import { bindingUses, conflictsFor } from "../src/conflicts.ts";

test("parse and normalise: <Primary> = <Control> = <Ctrl>, order and key case don't matter", () => {
  assert.deepEqual(parseAccel("<Control><Shift>F9"), { mods: ["Control", "Shift"], key: "F9" });
  assert.deepEqual(parseAccel("<Primary><Alt><Shift>0"), { mods: ["Control", "Shift", "Alt"], key: "0" });
  const same = ["<Control><Shift>F9", "<Shift><Control>F9", "<Primary><Shift>F9", "<Ctrl><Shift>f9", " <ctrl><shift>F9 ", "<Control><Control><Shift>F9"];
  for (const s of same) assert.equal(normalizeAccel(s), "<Control><Shift>f9", s);
  assert.equal(normalizeAccel("<Super>m"), normalizeAccel("<Mod4>M"));
  assert.equal(normalizeAccel("<Alt>F4"), normalizeAccel("<Mod1>F4"));
  assert.notEqual(normalizeAccel("<Control>F9"), normalizeAccel("<Control><Shift>F9"));
  for (const bad of ["", "disabled", "<Control>", "<Bogus>a", "Control+a", "<Control>a b", "<Control>é"]) assert.equal(parseAccel(bad), null, bad);
});

test("labels", () => {
  const cases: [string, string][] = [
    ["<Control><Shift>F9", "Ctrl+Shift+F9"],
    ["<Super>m", "Super+M"],
    ["<Primary><Alt><Shift>0", "Ctrl+Shift+Alt+0"],
    ["<Control>Page_Up", "Ctrl+Page Up"],
    ["<Super>comma", "Super+,"],
    ["<Super>idotless", "Super+I"],
    ["<Alt>KP_Add", "Alt+Keypad Add"],
    ["XF86AudioMute", "Audio Mute"],
    ["<Control>Up", "Ctrl+↑"],
    ["<Super>U00E9", "Super+É"],
    ["nonsense!", "nonsense!"],
  ];
  for (const [a, l] of cases) assert.equal(accelLabel(a), l, a);
});

test("problems and warnings", () => {
  assert.match(bindingProblem("")!, /Press a key combination/);
  assert.match(bindingProblem("<Bogus>a")!, /Unknown modifier <Bogus>/);
  assert.match(bindingProblem("Ctrl+a")!, /isn't a GNOME accelerator/);
  assert.equal(bindingProblem("<Control>F9"), null);
  assert.match(bindingWarning("a")!, /would stop you typing/);
  assert.match(bindingWarning("<Shift>comma")!, /would stop you typing/);
  assert.equal(bindingWarning("F9"), null, "a bare F-key is fine");
  assert.equal(bindingWarning("<Control>a"), null);
});

const ev = (key: string, code: string, mods: Partial<Pick<KeyLike, "ctrlKey" | "shiftKey" | "altKey" | "metaKey">> = {}, altGr = false): KeyLike => ({
  key,
  code,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
  getModifierState: (k) => k === "AltGraph" && altGr,
});
const C = { ctrlKey: true };
const CS = { ctrlKey: true, shiftKey: true };
const CAS = { ctrlKey: true, altKey: true, shiftKey: true };
const S = { metaKey: true };

test("capture: a table of key presses", () => {
  // [event, layout-map character for its code (or undefined), expected accelerator]
  const cases: [KeyLike, string | undefined, string][] = [
    [ev("F9", "F9", CS), undefined, "<Control><Shift>F9"],
    [ev("F9", "F9", C), undefined, "<Control>F9"],
    [ev("m", "KeyM", S), undefined, "<Super>m"],
    [ev("M", "KeyM", { metaKey: true, shiftKey: true }), undefined, "<Shift><Super>m"],
    // Shift+0 on a US layout reports ")"; GNOME stores the unshifted key
    [ev(")", "Digit0", CAS), undefined, "<Control><Shift><Alt>0"],
    [ev(")", "Digit0", CAS), "0", "<Control><Shift><Alt>0"],
    // Turkish Q: Shift+0 gives "=", the layout map says the key is "0"
    [ev("=", "Digit0", CS), "0", "<Control><Shift>0"],
    // Turkish Q letters: the key at US "Quote" is "i", the one at US "KeyI" is "ı"
    [ev("i", "Quote", C), "i", "<Control>i"],
    [ev("ı", "KeyI", C), "ı", "<Control>idotless"],
    [ev("ş", "Semicolon", C), "ş", "<Control>scedilla"],
    [ev("ç", "Period", { altKey: true }), "ç", "<Alt>ccedilla"],
    [ev("İ", "Quote", CS), undefined, "<Control><Shift>i"],
    // German: ü and ß
    [ev("ü", "BracketLeft", C), undefined, "<Control>udiaeresis"],
    [ev("ß", "Minus", C), undefined, "<Control>ssharp"],
    // punctuation by name; Shift falls back to the US position without a layout map
    [ev(",", "Comma", S), undefined, "<Super>comma"],
    [ev("<", "Comma", { metaKey: true, shiftKey: true }), undefined, "<Shift><Super>comma"],
    [ev("+", "Equal", CS), undefined, "<Control><Shift>equal"],
    [ev("/", "Slash", C), undefined, "<Control>slash"],
    // CapsLock gives an uppercase key without Shift
    [ev("A", "KeyA", C), undefined, "<Control>a"],
    // named keys
    [ev("ArrowLeft", "ArrowLeft", S), undefined, "<Super>Left"],
    [ev("PageUp", "PageUp", C), undefined, "<Control>Page_Up"],
    [ev("Enter", "Enter", C), undefined, "<Control>Return"],
    [ev(" ", "Space", C), undefined, "<Control>space"],
    [ev("Backspace", "Backspace", { altKey: true }), undefined, "<Alt>BackSpace"],
    [ev("Delete", "Delete", { ctrlKey: true, altKey: true }), undefined, "<Control><Alt>Delete"],
    [ev("F12", "F12", {}), undefined, "F12"],
    [ev("AudioVolumeMute", "AudioVolumeMute", {}), undefined, "XF86AudioMute"],
    [ev("MediaPlayPause", "MediaPlayPause", {}), undefined, "XF86AudioPlay"],
    // keypad by code, with NumLock on and off
    [ev("1", "Numpad1", C), undefined, "<Control>KP_1"],
    [ev("End", "Numpad1", C), undefined, "<Control>KP_End"],
    [ev("+", "NumpadAdd", { altKey: true }), undefined, "<Alt>KP_Add"],
    [ev("Enter", "NumpadEnter", C), undefined, "<Control>KP_Enter"],
    [ev(",", "NumpadDecimal", C), undefined, "<Control>KP_Decimal"],
    // dead keys and unknown keys fall back to the key's position
    [ev("Dead", "BracketRight", C), undefined, "<Control>bracketright"],
    [ev("Unidentified", "KeyQ", C), undefined, "<Control>q"],
    // other scripts: unicode keysym
    [ev("ф", "KeyA", C), undefined, "<Control>U0444"],
  ];
  for (const [e, layoutChar, want] of cases) {
    const r = captureKey(e, layoutChar);
    assert.equal(r.kind === "accel" ? r.accel : `${r.kind}`, want, `${JSON.stringify(e.key)} ${e.code} ${JSON.stringify(layoutChar)}`);
  }
  const r = captureKey(ev("F9", "F9", CS));
  assert.deepEqual(r, { kind: "accel", accel: "<Control><Shift>F9", label: "Ctrl+Shift+F9" });
});

test("capture: modifiers alone, Escape, AltGr, unmappable", () => {
  assert.deepEqual(captureKey(ev("Control", "ControlLeft", {})), { kind: "pending", label: "Ctrl+…" });
  assert.deepEqual(captureKey(ev("Shift", "ShiftLeft", C)), { kind: "pending", label: "Ctrl+Shift+…" });
  assert.deepEqual(captureKey(ev("Meta", "MetaLeft", {})), { kind: "pending", label: "Super+…" });
  assert.deepEqual(captureKey(ev("Escape", "Escape", {})), { kind: "cancel" });
  assert.equal(captureKey(ev("Escape", "Escape", C)).kind, "accel", "Ctrl+Escape can be bound");
  assert.equal(captureKey(ev("@", "KeyQ", {}, true)).kind, "error", "AltGr");
  const r = captureKey(ev("Unidentified", "Lang1", C));
  assert.equal(r.kind, "error");
});

test("conflicts: custom and built-in, <Primary> folded, not with itself", () => {
  const uses = bindingUses(
    [
      { id: "dc-map-toggle", name: "dc-map-toggle", binding: "<Control>F9" },
      { id: "motherapp-x", name: "x", binding: "<Primary>F2" },
      { id: "empty", name: "unbound", binding: "" },
    ],
    [
      { title: "Settings daemon", key: "screensaver", accel: "<Super>l" },
      { title: "Window manager", key: "panel-run-dialog", accel: "<Alt>F2" },
    ],
  );
  assert.deepEqual(conflictsFor("<Primary>F9", uses), ["custom shortcut 'dc-map-toggle'"]);
  assert.deepEqual(conflictsFor("<Ctrl>f9", uses), ["custom shortcut 'dc-map-toggle'"]);
  assert.deepEqual(conflictsFor("<Control>F9", uses, "dc-map-toggle"), []);
  assert.deepEqual(conflictsFor("<Mod4>L", uses), ["Settings daemon: screensaver"]);
  assert.deepEqual(conflictsFor("<Control>F2", uses, "other"), ["custom shortcut 'x'"]);
  assert.deepEqual(conflictsFor("<Control><Shift>F9", uses), []);
  assert.deepEqual(conflictsFor("garbage", uses), []);
});
