// The plain subcommands (no core): one-shot pw-dump, then wpctl / pw-play.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { parseMasterArgs, parseMasterPercent, parsePercent, runCli } from "../src/cli.ts";
import { FakeRunner, arctisText, dumpText } from "./fakes.ts";

let dump = dumpText;

async function cli(...argv: string[]) {
  const runner = new FakeRunner();
  runner.behave = (p) => {
    if (p.cmd === "pw-dump") p.stdout.write(dump());
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
      "  *   48  Built-in Audio Analog Stereo  (ALC1220 Analog)",
      "      52  GA102 High Definition Audio Controller Digital Stereo (HDMI 2)  (X34 P)",
      "Inputs",
      "  *   50  Built-in Audio Analog Stereo  (ALC1220 Analog)",
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

test("list: a headset's Chat and Game outputs read like wpctl status (issue #5)", async () => {
  dump = arctisText;
  try {
    const r = await cli("list");
    assert.equal(r.code, 0);
    assert.equal(
      r.out,
      [
        "Outputs",
        "      40  Arctis Pro Wireless Chat",
        "  *   41  Arctis Pro Wireless Game",
        "Inputs",
        "  *   43  Arctis Pro Wireless Chat",
        "Apps",
        "    (none playing sound)",
        "",
      ].join("\n"),
    );
    assert.equal((await cli("set-default", "game")).out, "default output: Arctis Pro Wireless Game\n");
  } finally {
    dump = dumpText;
  }
});

test("set-default, app-volume, app-mute and test-output build the right commands", async () => {
  let r = await cli("set-default", "hdmi");
  assert.equal(r.code, 0);
  assert.deepEqual(r.lines, ["pw-dump", "wpctl set-default 52"]);
  assert.equal(r.out, "default output: GA102 High Definition Audio Controller Digital Stereo (HDMI 2)\n");

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

test("volume / mute: print the default output's (or --input's) value; set quietly by id", async () => {
  // no value: print it, plainly, for scripts
  let r = await cli("volume");
  assert.deepEqual([r.code, r.out, r.err, r.lines], [0, "70\n", "", ["pw-dump"]]);
  r = await cli("volume", "--input");
  assert.equal(r.out, "90\n");
  r = await cli("mute");
  assert.equal(r.out, "off\n");
  r = await cli("mute", "--input");
  assert.equal(r.out, "off\n");

  // with a value: one wpctl on the default's id, nothing printed
  const set = async (...argv: string[]) => {
    const x = await cli(...argv);
    assert.deepEqual([x.code, x.out, x.err], [0, "", ""], argv.join(" "));
    assert.equal(x.lines[0], "pw-dump");
    return x.lines.slice(1);
  };
  assert.deepEqual(await set("volume", "+5"), ["wpctl set-volume 48 0.75"]);
  assert.deepEqual(await set("volume", "-10%"), ["wpctl set-volume 48 0.60"]);
  assert.deepEqual(await set("volume", "42"), ["wpctl set-volume 48 0.42"]);
  assert.deepEqual(await set("volume", "120%"), ["wpctl set-volume 48 1.20"]);
  assert.deepEqual(await set("volume", "--input", "+5"), ["wpctl set-volume 50 0.95"]);
  assert.deepEqual(await set("volume", "+50", "--input"), ["wpctl set-volume 50 1.00"]); // +N stops at 100
  assert.deepEqual(await set("mute", "toggle"), ["wpctl set-mute 48 toggle"]);
  assert.deepEqual(await set("mute", "on"), ["wpctl set-mute 48 1"]);
  assert.deepEqual(await set("mute", "--input", "off"), ["wpctl set-mute 50 0"]);
  assert.deepEqual(await set("mute", "--input", "toggle"), ["wpctl set-mute 50 toggle"]);
});

test("volume / mute: usage errors exit 2 before touching PipeWire, failures exit 1", async () => {
  for (const argv of [["volume", "loud"], ["volume", "5", "6"], ["volume", "--input", "x%"], ["mute", "maybe"], ["mute", "--input", "on", "off"]]) {
    const r = await cli(...argv);
    assert.equal(r.code, 2, argv.join(" "));
    assert.deepEqual(r.lines, [], argv.join(" "));
    assert.match(r.err, /^audioctl: .*\n\nusage: audioctl/);
  }
  // no default output (PipeWire restarting): exit 1 with a message, no wpctl
  const noDefault = JSON.stringify((JSON.parse(dumpText()) as any[]).filter((o) => o.type !== "PipeWire:Interface:Metadata"));
  dump = () => noDefault;
  try {
    for (const argv of [["volume"], ["volume", "+5"], ["mute", "toggle"], ["mute", "--input"]]) {
      const r = await cli(...argv);
      assert.equal(r.code, 1, argv.join(" "));
      assert.deepEqual(r.lines, ["pw-dump"]);
      assert.match(r.err, /^audioctl: there is no default (output|input) right now\n$/);
    }
  } finally {
    dump = dumpText;
  }
});

test("parseMasterPercent: like parsePercent, but +N stops at 100 unless already above", () => {
  assert.equal(parseMasterPercent("+5", 98), 100);
  assert.equal(parseMasterPercent("+5", 100), 100);
  assert.equal(parseMasterPercent("+5", 120), 125);
  assert.equal(parseMasterPercent("+50", 140), 150);
  assert.equal(parseMasterPercent("-5", 120), 115);
  assert.equal(parseMasterPercent("130", 10), 130);
  assert.equal(parseMasterPercent("-5", 2), 0);
  assert.throws(() => parseMasterPercent("+", 0), /percentage/);
  assert.deepEqual(parseMasterArgs("volume", ["--input"]), { kind: "input" });
  assert.deepEqual(parseMasterArgs("volume", ["-5", "--input"]), { kind: "input", value: "-5" });
  assert.deepEqual(parseMasterArgs("mute", []), { kind: "output" });
});

test("parsePercent: absolute, relative, clamped", () => {
  assert.equal(parsePercent("70", 10), 70);
  assert.equal(parsePercent("70%", 10), 70);
  assert.equal(parsePercent("+5", 70), 75);
  assert.equal(parsePercent("-5%", 3), 0);
  assert.equal(parsePercent("150", 0), 150);
  assert.equal(parsePercent("+200", 0), 150); // relative: clamped
  assert.throws(() => parsePercent("200", 0), /^Error: volume must be 0-150 \(got 200\)$/);
  assert.throws(() => parsePercent("150.5", 0), /must be 0-150/);
  assert.throws(() => parsePercent("loud", 0), /percentage/);
});

test("#28: an absolute volume above 150 is a usage error before PipeWire; relative still clamps", async () => {
  // 150 is fine
  let r = await cli("volume", "150");
  assert.deepEqual([r.code, r.err, r.lines], [0, "", ["pw-dump", "wpctl set-volume 48 1.50"]]);
  // 151 and 1000: exit 2, the message, and no pw-dump or wpctl at all
  for (const argv of [["volume", "151"], ["volume", "1000"], ["volume", "--input", "151%"], ["app-volume", "firefox", "151"], ["app-volume", "firefox", "1000%"]]) {
    r = await cli(...argv);
    assert.equal(r.code, 2, argv.join(" "));
    assert.deepEqual(r.lines, [], argv.join(" "));
    const got = argv.at(-1)!.replace("%", "");
    assert.ok(r.err.startsWith(`audioctl: volume must be 0-150 (got ${got})\n`), r.err);
  }
  // +200 on the master stops at 100 (from 70)
  r = await cli("volume", "+200");
  assert.deepEqual([r.code, r.lines], [0, ["pw-dump", "wpctl set-volume 48 1.00"]]);
  // app-volume +N clamps to 150
  r = await cli("app-volume", "spotify", "+200");
  assert.equal(r.code, 0);
  assert.match(r.out, /: 150%\n$/);
});
