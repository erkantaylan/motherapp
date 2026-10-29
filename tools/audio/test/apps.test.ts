// App row names: generic library names (Discord's "WEBRTC VoiceEngine") give way to the process
// binary or its desktop entry, and an app's streams group by binary.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { desktopNameLookup, loadDesktopNames, parseDesktopEntry } from "../src/desktop.ts";
import { PwModel, appDisplayName, buildView, isGenericAppName, viewToState } from "../src/pipewire.ts";
import type { PwObject } from "../src/pipewire.ts";
import { realText } from "./fakes.ts";

const viewOf = (objs: unknown, desktopName?: (b: string) => string | undefined) => {
  const m = new PwModel();
  m.apply(objs);
  return buildView(m.objects.values(), desktopName ? { desktopName } : {});
};

test("real graph: Discord's voice stream is 'Discord', not 'WEBRTC VoiceEngine'; Spotify's binary comes from its client", () => {
  const v = viewOf(JSON.parse(realText()));
  // Discord's recStream and discord_capture are capture streams (Stream/Input/Audio): not apps
  assert.deepEqual(
    v.apps.map((a) => [a.key, a.name, a.binary, a.streams.map((s) => [s.id, s.mediaName])]),
    [
      ["Discord", "Discord", "Discord", [[84, "playStream"]]],
      ["Spotify", "Spotify", "spotify", [[85, "Spotify"]]],
    ],
  );
  assert.deepEqual((viewToState(v).apps as any).Discord, { name: "Discord", volume: 97, muted: false, streams: 1, detail: "playStream" });
});

const stream = (id: number, props: Record<string, unknown>) =>
  ({ id, type: "PipeWire:Interface:Node", info: { props: { "media.class": "Stream/Output/Audio", ...props }, params: { Props: [{ channelVolumes: [1, 1] }] } } }) as unknown as PwObject;

test("streams of one binary are one row whatever their application.name; the desktop entry names it", () => {
  const discord = { "application.process.binary": "Discord", "application.process.id": 186541 };
  const objs = [
    stream(1, { ...discord, "application.name": "WEBRTC VoiceEngine", "media.name": "playStream" }),
    stream(2, { ...discord, "application.name": "WEBRTC VoiceEngine", "media.name": "playStream" }),
    stream(3, { "application.name": "ALSA plug-in [speaker-test]", "application.process.binary": "speaker-test" }),
    stream(4, { "application.name": "Chromium", "application.process.binary": "electron-app" }),
    stream(5, { "application.name": "Firefox", "application.process.binary": "firefox-bin", "application.process.id": 1 }),
    stream(6, { "application.name": "Firefox", "application.process.binary": "firefox-bin", "application.process.id": 2 }),
  ];
  const names: Record<string, string> = { discord: "Discord", "electron-app": "Some App" };
  const v = viewOf(objs, (b) => names[b.toLowerCase()]);
  assert.deepEqual(
    v.apps.map((a) => [a.name, a.streams.map((s) => s.id)]),
    [
      ["Firefox", [5, 6]], // two content processes, one row
      ["Discord", [1, 2]],
      ["Some App", [4]],
      ["Speaker-test", [3]],
    ].sort((a, b) => String(a[0]).toLowerCase().localeCompare(String(b[0]).toLowerCase())),
  );
  // a binary and a different app that end up with the same name stay apart
  const twin = viewOf([stream(1, { "application.name": "Discord" }), stream(2, { "application.name": "WEBRTC VoiceEngine", "application.process.binary": "discord" })]);
  assert.deepEqual(twin.apps.map((a) => a.key).sort(), ["Discord", "Discord-discord"]);
});

test("generic names and the display-name rule", () => {
  for (const n of ["WEBRTC VoiceEngine", "ALSA plug-in [aplay]", "PipeWire ALSA [mpv]", "Chromium", "Chromium input", "", undefined]) assert.ok(isGenericAppName(n), String(n));
  for (const n of ["Firefox", "Spotify", "discord_capture", "Chromium Web Browser"]) assert.ok(!isGenericAppName(n), n);
  assert.equal(appDisplayName(["WEBRTC VoiceEngine", "Discord"], "Discord"), "Discord");
  assert.equal(appDisplayName(["WEBRTC VoiceEngine"], "spotify"), "Spotify");
  assert.equal(appDisplayName(["WEBRTC VoiceEngine"], "Discord", () => "Discord Canary"), "Discord Canary");
  assert.equal(appDisplayName(["WEBRTC VoiceEngine"], undefined), "WEBRTC VoiceEngine");
});

test("desktop entries: by file id, StartupWMClass, or an Exec program only one app uses", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ma-desktop-"));
  try {
    const w = (f: string, body: string) => fs.writeFileSync(path.join(dir, f), body);
    w("discord.desktop", "[Desktop Entry]\nName=Discord\nExec=/usr/bin/discord\nStartupWMClass=discord\n");
    w("spotify_spotify.desktop", "[Desktop Entry]\nName=Spotify\nExec=/snap/bin/spotify %U\nStartupWMClass=spotify\n");
    w("tg.desktop", "[Desktop Entry]\nName=Telegram\nExec=env QT=1 /opt/telegram-desktop -- %u\n[Desktop Action new]\nName=New Window\n");
    w("game1.desktop", "[Desktop Entry]\nName=Game One\nExec=steam steam://rungameid/1\n");
    w("game2.desktop", "[Desktop Entry]\nName=Game Two\nExec=steam steam://rungameid/2\n");
    w("gone.desktop", "[Desktop Entry]\nName=Gone\nHidden=true\n");
    const names = loadDesktopNames([dir, path.join(dir, "missing")]);
    assert.equal(names.get("discord"), "Discord");
    assert.equal(names.get("spotify"), "Spotify");
    assert.equal(names.get("telegram-desktop"), "Telegram");
    assert.equal(names.get("steam"), undefined); // two games run steam: not a name for it
    assert.equal(names.get("gone"), undefined);
    let loads = 0;
    const lookup = desktopNameLookup(() => (loads++, names));
    assert.equal(lookup("Discord"), "Discord");
    assert.equal(lookup("SPOTIFY"), "Spotify");
    assert.equal(loads, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(parseDesktopEntry("x", "[Desktop Action a]\nName=Nope\n"), undefined);
});
