// cpu.json: defaults written when missing, validation, a broken file left alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defaultSettings, loadSettings, parseSettings, settingsFile } from "../src/settings.ts";

function tmp(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ma-cpu-cfg-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "motherapp", "cpu.json");
}

test("settingsFile follows XDG_CONFIG_HOME", () => {
  assert.equal(settingsFile({ XDG_CONFIG_HOME: "/c" }), "/c/motherapp/cpu.json");
  assert.match(settingsFile({}), /\.config\/motherapp\/cpu\.json$/);
});

test("missing file: created with both profiles (underclock unset), active null, applyOnStart true", (t) => {
  const file = tmp(t);
  assert.deepEqual(loadSettings(file), { settings: defaultSettings(), problems: [] }, "without create nothing is written");
  assert.equal(fs.existsSync(file), false);
  const r = loadSettings(file, { create: true });
  assert.equal(r.created, true);
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /"ccx": \[4250, 4250, 4125, 4100\]/);
  assert.deepEqual(JSON.parse(text), {
    version: 1,
    active: null,
    applyOnStart: true,
    profiles: {
      underclock: { name: "Underclock", ccx: null, vcore: null },
      overclock: { name: "Overclock (CTR)", ccx: [4250, 4250, 4125, 4100], vcore: 1.25, cinebenchR20: 6916, powerW: 137 },
    },
  });
  // read back: the same settings, nothing created this time
  const again = loadSettings(file, { create: true });
  assert.deepEqual(again, { settings: defaultSettings(), problems: [] });
  assert.equal(fs.readdirSync(path.dirname(file)).length, 1, "no temp file left");
});

test("a broken file is reported and never overwritten", (t) => {
  const file = tmp(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ not json");
  const r = loadSettings(file, { create: true });
  assert.match(r.problems[0]!, /isn't valid JSON .*: fix or delete it$/);
  assert.deepEqual(r.settings.profiles.map((p) => [p.id, p.ccx, p.vcore]), [["underclock", null, null], ["overclock", null, null]], "nothing invented");
  assert.equal(fs.readFileSync(file, "utf8"), "{ not json");
});

test("validation: bad fields become 'not set' with a problem; unknown profiles ignored", () => {
  const r = parseSettings({
    active: "turbo",
    applyOnStart: "yes",
    profiles: {
      underclock: { name: "Quiet", ccx: [3600, 3600, 3600, 3600], vcore: 1.05 },
      overclock: { ccx: [4250, 99999], vcore: 3 },
      extra: {},
    },
  });
  assert.deepEqual(r.settings.profiles[0], { id: "underclock", name: "Quiet", ccx: [3600, 3600, 3600, 3600], vcore: 1.05 });
  assert.deepEqual(r.settings.profiles[1], { id: "overclock", name: "Overclock (CTR)", ccx: null, vcore: null });
  assert.equal(r.settings.active, null);
  assert.equal(r.settings.applyOnStart, true);
  assert.deepEqual(r.problems, [
    '"overclock": "ccx" must be null or list 1 to 16 frequencies in MHz (400-7000)',
    '"overclock": "vcore" must be null or volts (0.5-2.0)',
    'profile "extra" ignored: only "underclock" and "overclock" exist',
    '"active" must be "underclock", "overclock" or null; treated as null',
    '"applyOnStart" must be true or false; treated as true',
  ]);
});

test("active must point at a profile with values; applyOnStart false is kept", () => {
  const r = parseSettings({ active: "underclock", applyOnStart: false, profiles: { underclock: { ccx: null, vcore: null } } });
  assert.equal(r.settings.active, "underclock");
  assert.equal(r.settings.applyOnStart, false);
  assert.deepEqual(r.problems, ['the active profile "underclock" has no values yet']);
  assert.deepEqual(parseSettings({ active: "overclock", profiles: { overclock: defaultSettings().profiles[1] } }).problems, []);
  assert.deepEqual(parseSettings([]).problems, ["it isn't a JSON object"]);
});
