// GVariant text: what gsettings prints, and what we hand to `gsettings set`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GVariantError, parseGVariant, parseString, parseStringArray, printString, printStringArray } from "../src/gvariant.ts";
import { gvPrint } from "./fake-gnome-core.ts";

test("arrays: empty with its type, quotes of both kinds, spacing", () => {
  assert.deepEqual(parseStringArray("@as []"), []);
  assert.deepEqual(parseStringArray("[]"), []);
  assert.deepEqual(parseStringArray("@as []\n"), []);
  assert.deepEqual(parseStringArray("['/a/', '/b c/', \"/it's/\"]"), ["/a/", "/b c/", "/it's/"]);
  assert.deepEqual(parseStringArray("[ '/a/' ,'/b/' ]"), ["/a/", "/b/"]);
  assert.deepEqual(parseGVariant("['<Super>n']"), ["<Super>n"]);
  assert.throws(() => parseStringArray("['a', 1]"), GVariantError);
  assert.throws(() => parseStringArray("'a'"), GVariantError);
});

test("strings: escapes as gsettings prints them (seen in the container)", () => {
  // exact outputs of gsettings 2.80 under LC_ALL=C.UTF-8
  assert.equal(parseString(`'tab\\tnl\\nbell\\a\\u0001 é ü 🚀 \\\\ end'`), "tab\tnl\nbell\x07\x01 é ü 🚀 \\ end");
  assert.equal(parseString(`"both ' and \\""`), `both ' and "`);
  assert.equal(parseString(`"sh -c 'a\\\\b'"`), "sh -c 'a\\b'");
  assert.equal(parseString("''"), "");
  assert.equal(parseString("'\\U0001f680'"), "🚀");
  assert.equal(parseString("'\\b\\f\\r\\v'"), "\b\f\r\v");
  assert.throws(() => parseString("'unterminated"), /unterminated string/);
  assert.throws(() => parseString("'a' 'b'"), /trailing text/);
  assert.throws(() => parseString("'\\u12'"), /bad \\u escape/);
});

test("other values gsettings prints for keybinding schemas", () => {
  assert.equal(parseGVariant("uint32 30"), 30);
  assert.equal(parseGVariant("true"), true);
  assert.equal(parseGVariant("-5"), -5);
  assert.equal(parseGVariant("@s 'x'"), "x");
  assert.throws(() => parseGVariant("<'x'>"), GVariantError);
});

test("printString: single quotes, escapes, everything non-ASCII as \\u", () => {
  assert.equal(printString("CopyQ"), "'CopyQ'");
  assert.equal(printString("it's"), "'it\\'s'");
  assert.equal(printString("a\\b"), "'a\\\\b'");
  assert.equal(printString('"q"'), `'"q"'`);
  assert.equal(printString("é\n🚀"), "'\\u00e9\\n\\U0001f680'");
  assert.equal(printString("<Control><Shift>F9"), "'<Control><Shift>F9'");
  assert.equal(printStringArray([]), "@as []");
  assert.equal(printStringArray(["/a/", "/it's/"]), "['/a/', '/it\\'s/']");
});

test("round trips: print → parse, and the fake's gsettings-style print → parse", () => {
  const cases = ["", "plain", "it's", 'say "hi"', `both ' and "`, "back\\slash", "tab\tnl\n", "\x01\x7f", "é ü ı ş 🚀", "{key}"];
  for (const s of cases) {
    assert.equal(parseString(printString(s)), s, `printString ${JSON.stringify(s)}`);
    assert.equal(parseString(gvPrint(s)), s, `gvPrint ${JSON.stringify(s)}`);
  }
  assert.deepEqual(parseStringArray(printStringArray(cases)), cases);
  assert.deepEqual(parseStringArray(gvPrint(cases)), cases);
});
