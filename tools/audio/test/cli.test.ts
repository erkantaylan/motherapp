// The plain subcommands (no core): one-shot pw-dump, then wpctl / pw-play.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { parsePercent, runCli } from "../src/cli.ts";
import { FakeRunner, dumpText } from "./fakes.ts";

async function cli(...argv: string[]) {
  const runner = new FakeRunner();
  runner.behave = (p) => {
    if (p.cmd === "pw-dump") p.stdout.write(dumpText());
    p.exit(0);
  };
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (c) => (out += c));
  stderr.on("data", (c) => (err += c));
  const code = await runCli(argv, { runner, stdout, stderr, ops: { testSounds: [] } });
  return { code, out, err, lines: runner.lines() };
}

test("list: outputs and inputs with the default marked, apps with volume", async () => {
  const r = await cli("list");
  assert.equal(r.code, 0);
  assert.deepEqual(r.lines, ["pw-dump"]);
  assert.equal(
    r.out,
    [
      "Outputs",
      "  *   48  ALC1220 Analog  (Built-in Audio Analog Stereo)",
      "      52  X34 P  (GA102 High Definition Audio Controller Digital Stereo (HDMI 2))",
      "Inputs",
      "  *   50  ALC1220 Analog  (Built-in Audio Analog Stereo)",
      "Apps",
      "    Firefox   70%  (2 streams)",
      "    mpv       90%",
      "    Spotify  100%",
      "",
    ].join("\n"),
  );
  const j = JSON.parse((await cli("list", "--json")).out);
  assert.equal(j.defaultSink, "48");
  assert.equal(j.apps.Firefox.volume, 70);
});

test("set-default, app-volume, app-mute and test-output build the right commands", async () => {
  let r = await cli("set-default", "hdmi");
  assert.equal(r.code, 0);
  assert.deepEqual(r.lines, ["pw-dump", "wpctl set-default 52"]);
  assert.equal(r.out, "default output: X34 P\n");

  r = await cli("app-volume", "firefox", "+5");
  assert.deepEqual(r.lines.slice(1), ["wpctl set-volume 101 0.75", "wpctl set-volume 102 0.75"]);
  assert.equal(r.out, "Firefox: 75%\n");
  r = await cli("app-volume", "spotify", "40%");
  assert.deepEqual(r.lines.slice(1), ["wpctl set-volume 110 0.40"]);

  r = await cli("app-mute", "Firefox", "toggle");
  assert.deepEqual(r.lines.slice(1), ["wpctl set-mute 101 1", "wpctl set-mute 102 1"]);
  r = await cli("app-mute", "mpv", "off");
  assert.deepEqual(r.lines.slice(1), ["wpctl set-mute 115 0"]);

  r = await cli("test-output", "48");
  assert.equal(r.code, 0);
  assert.deepEqual(r.lines, ["pw-dump"]); // no sounds configured in this test
});

test("errors: usage problems exit 2, failures exit 1, with a message on stderr", async () => {
  let r = await cli("bogus");
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown command "bogus"[\s\S]*usage: audioctl/);
  r = await cli("app-mute", "firefox", "maybe");
  assert.equal(r.code, 2);
  r = await cli("set-default", "Built-in");
  assert.equal(r.code, 1);
  assert.match(r.err, /matches several devices/);
  r = await cli("test-output", "50");
  assert.equal(r.code, 1);
  assert.match(r.err, /No output with id 50/);
  r = await cli();
  assert.equal(r.code, 2);
  assert.equal((await cli("help")).code, 0);
});

test("parsePercent: absolute, relative, clamped", () => {
  assert.equal(parsePercent("70", 10), 70);
  assert.equal(parsePercent("70%", 10), 70);
  assert.equal(parsePercent("+5", 70), 75);
  assert.equal(parsePercent("-5%", 3), 0);
  assert.equal(parsePercent("200", 0), 150);
  assert.throws(() => parsePercent("loud", 0), /percentage/);
});
