// Generates tools/audio/test/fixtures/{pw-dump.json,pw-dump-monitor.txt,pw-dump-arctis.json}
// in pw-dump 1.0 shapes.
//   node tools/audio/test/fixtures/generate.mjs tools/audio/test/fixtures
// Written from PipeWire 1.0 pw-dump output shapes, not captured on the target machine. If a
// real capture disagrees, fix this generator (and the tests) to match the capture.
import * as fs from "node:fs";
import * as path from "node:path";

const out = process.argv[2];
const PERM = ["r", "w", "x", "m"];
const CM = ["input-ports", "output-ports", "state", "props", "params"];

const fmtAudio = (ch) => ({
  mediaType: "audio",
  mediaSubtype: "raw",
  format: "F32P",
  rate: 48000,
  channels: ch,
  position: ch === 1 ? ["MONO"] : ["FL", "FR"],
});

function propsParam({ ch, vol = 1.0, mute = false, soft = 1.0 }) {
  const map = ch === 1 ? ["MONO"] : ["FL", "FR"];
  return [
    {
      volume: 1.0,
      mute,
      channelVolumes: Array(ch).fill(vol),
      volumeBase: 1.0,
      volumeStep: 0.000015,
      channelMap: map,
      softMute: false,
      softVolumes: Array(ch).fill(soft),
      monitorMute: false,
      monitorVolumes: Array(ch).fill(1.0),
    },
    { params: ["monitor.channel-volumes", false, "channelmix.disable", false, "channelmix.normalize", false, "resample.quality", 4] },
  ];
}

function nodeParams(ch, props) {
  return {
    EnumFormat: [{ mediaType: "audio", mediaSubtype: "raw", format: { default: "F32P", alt1: ["F32P", "F32"] }, rate: { default: 48000, min: 1, max: 2147483647 }, channels: ch }],
    PropInfo: [
      { id: "volume", description: "Volume", type: { default: 1.0, min: 0.0, max: 10.0 } },
      { id: "mute", description: "Mute", type: false },
    ],
    Props: props,
    Format: [fmtAudio(ch)],
    EnumPortConfig: [],
    PortConfig: [],
    Latency: [],
    ProcessLatency: [],
    Tag: [],
  };
}

function node(id, { state = "suspended", inPorts = 0, outPorts = 0, maxIn = 0, maxOut = 0, props, ch = 2, params }) {
  return {
    id,
    type: "PipeWire:Interface:Node",
    version: 3,
    permissions: PERM,
    info: {
      "max-input-ports": maxIn,
      "max-output-ports": maxOut,
      "change-mask": CM,
      "n-input-ports": inPorts,
      "n-output-ports": outPorts,
      state,
      error: null,
      props: { ...props, "object.id": id },
      params: params ?? nodeParams(ch, propsParam({ ch })),
    },
  };
}

const CARD_NAMES = ["HDA Intel PCH", "HDA NVidia", "G435 Wireless Gaming Headset"];

function alsaNode(id, { cls, name, desc, nick, card, dev = 0, profile, profileName = "analog-stereo", deviceId, serial, ch = 2, path: apath, vol = 1.0, mute = false, soft = 1.0, state = "suspended", cardName = CARD_NAMES[card], driver = card === 2 ? "snd_usb_audio" : "snd_hda_intel" }) {
  const playback = cls === "Audio/Sink";
  return node(id, {
    state,
    inPorts: playback ? ch : 0,
    outPorts: ch,
    maxIn: playback ? 65 : 0,
    maxOut: playback ? 0 : 65,
    ch,
    params: nodeParams(ch, propsParam({ ch, vol, mute, soft })),
    props: {
      "alsa.card": card,
      "alsa.card_name": cardName,
      "alsa.class": "generic",
      "alsa.device": dev,
      "alsa.driver_name": driver,
      "alsa.id": nick,
      "alsa.name": nick,
      "alsa.resolution_bits": 16,
      "alsa.subclass": "generic-mix",
      "alsa.subdevice": 0,
      "alsa.subdevice_name": "subdevice #0",
      "api.alsa.card.name": cardName,
      "api.alsa.path": apath,
      "api.alsa.pcm.card": card,
      "api.alsa.pcm.stream": playback ? "playback" : "capture",
      "audio.channels": ch,
      "audio.position": ch === 1 ? "MONO" : "FL,FR",
      "card.profile.device": playback ? 9 : 10,
      "client.id": 33,
      "device.api": "alsa",
      "device.class": "sound",
      "device.id": deviceId,
      "device.profile.description": profile,
      "device.profile.name": profileName,
      "device.routes": 1,
      "factory.id": 18,
      "factory.mode": "merge",
      "factory.name": playback ? "api.alsa.pcm.sink" : "api.alsa.pcm.source",
      "library.name": "audioconvert/libspa-audioconvert",
      "media.class": cls,
      "node.description": desc,
      "node.driver": true,
      "node.name": name,
      "node.nick": nick,
      "node.pause-on-idle": false,
      "object.path": `alsa:pcm:${card}:${apath}:${playback ? "playback" : "capture"}`,
      "object.serial": serial,
      "port.group": playback ? "playback" : "capture",
      "priority.driver": playback ? 1009 : 2009,
      "priority.session": playback ? 1009 : 2009,
    },
  });
}

function pulseStream(id, { app, binary, pid, media, serial, clientId, vol, mute = false, role, extra = {}, state = "running", cls = "Stream/Output/Audio" }) {
  const props = {
    "application.icon_name": binary,
    "application.language": "en_US.UTF-8",
    "application.name": app,
    "application.process.binary": binary,
    "application.process.host": "kappa-desktop",
    "application.process.id": pid,
    "application.process.machine_id": "3f1c0e3a6d7b4a40a2a1e0c3d7b2f9a1",
    "application.process.user": "kappa",
    "client.api": "pipewire-pulse",
    "client.id": clientId,
    "factory.id": 7,
    "media.class": cls,
    "media.name": media,
    "node.latency": "1024/48000",
    "node.name": app,
    "node.rate": "1/48000",
    "object.serial": serial,
    "pulse.server.type": "unix",
    "stream.is-live": true,
    ...extra,
  };
  if (role) props["media.role"] = role;
  return node(id, { state, inPorts: cls === "Stream/Output/Audio" ? 0 : 2, outPorts: cls === "Stream/Output/Audio" ? 2 : 0, ch: 2, params: nodeParams(2, propsParam({ ch: 2, vol, mute })), props });
}

function nativeStream(id, { app, binary, pid, media, serial, clientId, vol, role, mute = false }) {
  const props = {
    "application.name": app,
    "application.process.binary": binary,
    "application.process.host": "kappa-desktop",
    "application.process.id": pid,
    "application.process.user": "kappa",
    "client.id": clientId,
    "factory.id": 7,
    "media.category": "Playback",
    "media.class": "Stream/Output/Audio",
    "media.name": media,
    "media.type": "Audio",
    "node.autoconnect": true,
    "node.name": app.toLowerCase(),
    "object.serial": serial,
    "stream.is-live": false,
  };
  if (role) props["media.role"] = role;
  return node(id, { state: "running", outPorts: 2, ch: 2, params: nodeParams(2, propsParam({ ch: 2, vol, mute })), props });
}

const device = (id, { name, desc, nick, card, bus, serial }) => ({
  id,
  type: "PipeWire:Interface:Device",
  version: 3,
  permissions: PERM,
  info: {
    "change-mask": ["props", "params"],
    props: {
      "alsa.card": card,
      "alsa.card_name": nick,
      "api.alsa.card": card,
      "api.alsa.path": `hw:${card}`,
      "device.api": "alsa",
      "device.bus": bus,
      "device.description": desc,
      "device.name": name,
      "device.nick": nick,
      "factory.id": 14,
      "media.class": "Audio/Device",
      "object.id": id,
      "object.serial": serial,
      "client.id": 33,
    },
    params: { EnumProfile: [], Profile: [{ index: 1, name: "output:analog-stereo+input:analog-stereo", description: "Analog Stereo Duplex", priority: 6565, available: "yes" }], EnumRoute: [], Route: [] },
  },
});

const port = (id, nodeId, dir, ch, serial) => ({
  id,
  type: "PipeWire:Interface:Port",
  version: 3,
  permissions: PERM,
  info: {
    direction: dir,
    "change-mask": ["props", "params"],
    props: { "format.dsp": "32 bit float mono audio", "node.id": nodeId, "object.id": id, "object.path": `x:${dir}_${ch}`, "object.serial": serial, "port.alias": `x:${dir}_${ch}`, "port.direction": dir === "input" ? "in" : "out", "port.id": 0, "port.name": `${dir === "input" ? "playback" : "monitor"}_${ch}`, "audio.channel": ch },
    params: { EnumFormat: [], Meta: [], IO: [], Format: [], Buffers: [], Latency: [], Tag: [] },
  },
});

const link = (id, outNode, outPort, inNode, inPort, serial) => ({
  id,
  type: "PipeWire:Interface:Link",
  version: 3,
  permissions: PERM,
  info: {
    "output-node-id": outNode,
    "output-port-id": outPort,
    "input-node-id": inNode,
    "input-port-id": inPort,
    "change-mask": ["state", "format", "props"],
    state: "active",
    error: null,
    format: { mediaType: "audio", mediaSubtype: "dsp", format: "F32P" },
    props: { "client.id": 33, "factory.id": 20, "link.input.node": inNode, "link.input.port": inPort, "link.output.node": outNode, "link.output.port": outPort, "object.id": id, "object.serial": serial },
  },
});

const client = (id, name, pid, api, serial) => ({
  id,
  type: "PipeWire:Interface:Client",
  version: 3,
  permissions: PERM,
  info: {
    "change-mask": ["props"],
    props: { "application.name": name, "application.process.id": pid, "client.api": api, "module.id": 2, "object.id": id, "object.serial": serial, "pipewire.protocol": "protocol-native", "pipewire.sec.pid": pid, "pipewire.sec.uid": 1000 },
  },
});

const json = (name) => ({ name });
const meta = (id, name, entries, serial) => ({
  id,
  type: "PipeWire:Interface:Metadata",
  version: 3,
  permissions: PERM,
  props: { "client.id": 33, "factory.id": 13, "metadata.name": name, "object.serial": serial },
  metadata: entries,
});

const ANALOG_OUT = "alsa_output.pci-0000_00_1f.3.analog-stereo";
const ANALOG_IN = "alsa_input.pci-0000_00_1f.3.analog-stereo";
const HDMI_OUT = "alsa_output.pci-0000_01_00.1.hdmi-stereo-extra1";
const USB_OUT = "alsa_output.usb-Logitech_G435_Wireless_Gaming_Headset_V001008005.1-01.analog-stereo";
const USB_IN = "alsa_input.usb-Logitech_G435_Wireless_Gaming_Headset_V001008005.1-01.mono-fallback";

const core = {
  id: 0,
  type: "PipeWire:Interface:Core",
  version: 4,
  permissions: PERM,
  info: { cookie: 1880421, "user-name": "kappa", "host-name": "kappa-desktop", version: "1.0.5", name: "pipewire-0", "change-mask": ["props"], props: { "config.name": "pipewire.conf", "core.daemon": true, "core.name": "pipewire-0", "default.clock.rate": 48000, "object.id": 0, "object.serial": 0 } },
};

const sinkAnalog = alsaNode(48, { cls: "Audio/Sink", name: ANALOG_OUT, desc: "Built-in Audio Analog Stereo", nick: "ALC1220 Analog", card: 0, profile: "Analog Stereo", deviceId: 42, serial: 49, path: "front:0", vol: 0.343, soft: 0.512, state: "running" });
// Master volume (#13): the default output is at 70% (0.343 linear), the default mic at 90%.
const srcAnalog = alsaNode(50, { cls: "Audio/Source", name: ANALOG_IN, desc: "Built-in Audio Analog Stereo", nick: "ALC1220 Analog", card: 0, profile: "Analog Stereo", deviceId: 42, serial: 51, path: "front:0", vol: 0.729 });
const sinkHdmi = alsaNode(52, { cls: "Audio/Sink", name: HDMI_OUT, desc: "GA102 High Definition Audio Controller Digital Stereo (HDMI 2)", nick: "X34 P", card: 1, dev: 7, profile: "Digital Stereo (HDMI 2) Output", deviceId: 43, serial: 53, path: "hdmi:1,1" });

const dummy = node(28, { props: { "factory.name": "support.node.driver", "node.name": "Dummy-Driver", "node.group": "pipewire.dummy", "priority.driver": 200000, "object.serial": 28, "node.driver": true }, params: {} });
const freewheel = node(29, { props: { "factory.name": "support.node.driver", "node.name": "Freewheel-Driver", "node.freewheel": true, "node.group": "pipewire.freewheel", "priority.driver": 190000, "object.serial": 29, "node.driver": true }, params: {} });
const midi = node(37, { outPorts: 1, inPorts: 1, props: { "api.alsa.path": "hw:0", "factory.name": "api.alsa.seq.bridge", "media.class": "Midi/Bridge", "node.description": "Midi-Bridge", "node.name": "Midi-Bridge", "object.serial": 37, "priority.session": 100 }, params: {} });
const webcam = node(60, { outPorts: 1, props: { "api.v4l2.path": "/dev/video0", "device.api": "v4l2", "factory.name": "api.v4l2.source", "media.class": "Video/Source", "media.role": "Camera", "node.description": "HD Pro Webcam C920 (V4L2)", "node.name": "v4l2_input.pci-0000_00_14.0-usb-0_2_1.0", "node.nick": "HD Pro Webcam C920", "object.serial": 60, "priority.session": 1000 }, params: {} });
// A monitor-ish virtual source (e.g. from a loopback/echo-cancel module) must be skipped.
const virtualSrc = node(61, { outPorts: 2, props: { "factory.name": "support.null-audio-sink", "media.class": "Audio/Source/Virtual", "node.description": "Echo-Cancel Source", "node.name": "echo-cancel-source", "object.serial": 61, "audio.position": "FL,FR" } });

const ffA = pulseStream(101, { app: "Firefox", binary: "firefox", pid: 4321, media: "AudioStream", serial: 1203, clientId: 87, vol: 0.343 });
const ffB = pulseStream(102, { app: "Firefox", binary: "firefox", pid: 4321, media: "AudioStream", serial: 1207, clientId: 87, vol: 0.343 });
const spotify = pulseStream(110, { app: "Spotify", binary: "spotify", pid: 5550, media: "Spotify", serial: 1301, clientId: 92, vol: 1.0, extra: { "window.x11.display": ":0" } });
const mpv = nativeStream(115, { app: "mpv", binary: "mpv", pid: 6001, media: "Daft Punk - Veridis Quo.flac", serial: 1402, clientId: 95, vol: 0.729, role: "Movie" });
const chromeIn = pulseStream(120, { app: "Google Chrome input", binary: "chrome", pid: 7002, media: "RecordStream", serial: 1500, clientId: 96, vol: 1.0, cls: "Stream/Input/Audio" });

const defaultMeta = meta(
  34,
  "default",
  [
    { subject: 0, key: "default.configured.audio.sink", type: "Spa:String:JSON", value: json(ANALOG_OUT) },
    { subject: 0, key: "default.audio.sink", type: "Spa:String:JSON", value: json(ANALOG_OUT) },
    { subject: 0, key: "default.audio.source", type: "Spa:String:JSON", value: json(ANALOG_IN) },
    { subject: 0, key: "default.video.source", type: "Spa:String:JSON", value: json("v4l2_input.pci-0000_00_14.0-usb-0_2_1.0") },
  ],
  34,
);
const settingsMeta = meta(
  33,
  "settings",
  [
    { subject: 0, key: "log.level", type: "", value: 2 },
    { subject: 0, key: "clock.rate", type: "", value: 48000 },
    { subject: 0, key: "clock.allowed-rates", type: "", value: "[ 48000 ]" },
    { subject: 0, key: "clock.quantum", type: "", value: 1024 },
  ],
  33,
);

const initial = [
  core,
  client(32, "WirePlumber", 1712, "pipewire-native", 32),
  client(87, "Firefox", 4321, "pipewire-pulse", 88),
  client(92, "Spotify", 5550, "pipewire-pulse", 93),
  client(95, "mpv", 6001, "pipewire-native", 96),
  dummy,
  freewheel,
  settingsMeta,
  defaultMeta,
  midi,
  device(42, { name: "alsa_card.pci-0000_00_1f.3", desc: "Built-in Audio", nick: "HDA Intel PCH", card: 0, bus: "pci", serial: 42 }),
  device(43, { name: "alsa_card.pci-0000_01_00.1", desc: "GA102 High Definition Audio Controller", nick: "HDA NVidia", card: 1, bus: "pci", serial: 43 }),
  sinkAnalog,
  srcAnalog,
  sinkHdmi,
  webcam,
  virtualSrc,
  port(200, 48, "input", "FL", 200),
  port(201, 48, "input", "FR", 201),
  ffA,
  ffB,
  spotify,
  mpv,
  chromeIn,
  port(210, 101, "output", "FL", 210),
  link(300, 101, 210, 48, 200, 300),
];

const clone = (x) => structuredClone(x);
function withVolume(n, vol, extra = {}) {
  const c = clone(n);
  c.info.params.Props[0].channelVolumes = c.info.params.Props[0].channelVolumes.map(() => vol);
  Object.assign(c.info.params.Props[0], extra);
  c.info["change-mask"] = ["params"];
  return c;
}
function withState(n, state) {
  const c = clone(n);
  c.info.state = state;
  c.info["change-mask"] = ["state"];
  return c;
}
const removed = (id) => ({ id, info: null });

const usbDev = device(70, { name: "alsa_card.usb-Logitech_G435_Wireless_Gaming_Headset_V001008005.1-01", desc: "G435 Wireless Gaming Headset", nick: "G435 Wireless Gaming Headset", card: 2, bus: "usb", serial: 1600 });
const usbSink = alsaNode(71, { cls: "Audio/Sink", name: USB_OUT, desc: "G435 Wireless Gaming Headset Analog Stereo", nick: "G435 Wireless Gaming Headset", card: 2, profile: "Analog Stereo", deviceId: 70, serial: 1601, path: "front:2", vol: 0.512 });
const usbSrc = alsaNode(72, { cls: "Audio/Source", name: USB_IN, desc: "G435 Wireless Gaming Headset Mono", nick: "G435 Wireless Gaming Headset", card: 2, profile: "Mono Input", deviceId: 70, serial: 1602, path: "hw:2", ch: 1 });

const eventStream = pulseStream(130, { app: "GNOME Shell", binary: "gnome-shell", pid: 2100, media: "message-new-instant", serial: 1700, clientId: 98, vol: 1.0, role: "event", extra: { "event.id": "message-new-instant", "event.description": "Message received", "media.filename": "/usr/share/sounds/Yaru/stereo/message-new-instant.oga" } });
const notifStream = nativeStream(131, { app: "Telegram Desktop", binary: "telegram-desktop", pid: 8100, media: "Notification", serial: 1701, clientId: 99, vol: 1.0, role: "Notification" });

const batches = [
  initial,
  // 1: Spotify's volume changes (100% -> 50%, linear 0.125); the sink switches state too.
  [withVolume(spotify, 0.125), withState(sinkAnalog, "idle")],
  // 2: USB headset plugged in; WirePlumber makes it the default output (only changed keys).
  [usbDev, usbSink, usbSrc, port(220, 71, "input", "FL", 1610), port(221, 71, "input", "FR", 1611),
    meta(34, "default", [{ subject: 0, key: "default.audio.sink", type: "Spa:String:JSON", value: json(USB_OUT) }], 34)],
  // 3: two event sounds start (must not show up as apps).
  [eventStream, notifStream, client(98, "GNOME Shell", 2100, "pipewire-pulse", 1699)],
  // 4: one Firefox tab stops, the event sounds end.
  [removed(102), removed(130), removed(131), removed(98)],
  // 5: Spotify quits; Firefox gets muted.
  [removed(110), removed(92), withVolume(ffA, 0.343, { mute: true })],
  // 6: headset unplugged; the default falls back to the built-in output.
  [removed(220), removed(221), removed(71), removed(72), removed(70),
    meta(34, "default", [{ subject: 0, key: "default.audio.sink", type: "Spa:String:JSON", value: json(ANALOG_OUT) }], 34)],
  // Master volume (#13), changed outside the tool (GNOME, the keyboard volume keys):
  // 7: the default output goes 70% -> 50% (linear 0.125).
  [withVolume(sinkAnalog, 0.125)],
  // 8: the default output is muted; the mic goes 90% -> 60% (linear 0.216) and is muted.
  [withVolume(sinkAnalog, 0.125, { mute: true }), withVolume(srcAnalog, 0.216, { mute: true })],
  // 9: the default output disappears (PipeWire/WirePlumber restarting): the node is removed
  //    and the default metadata entry deleted, with no new default yet.
  [removed(48), meta(34, "default", [{ subject: 0, key: "default.audio.sink", type: null, value: null }], 34)],
  // 10: it comes back at 70%, unmuted, and is the default again.
  [sinkAnalog, meta(34, "default", [{ subject: 0, key: "default.audio.sink", type: "Spa:String:JSON", value: json(ANALOG_OUT) }], 34)],
];

// pw-dump-arctis.json: a SteelSeries Arctis Pro Wireless (issue #5). The node.name, node.nick,
// node.description, device.id and card props of sinks 40 and 41 are as the local tester read
// them on the machine; the rest, and the source (43), are filled in from the same pattern
// (WirePlumber's gaming-headset profile set: mono-chat is PCM 0 in both directions, stereo-game
// is PCM 1 playback only). A USB card with two PCMs: the second PCM's nick is the generic
// "USB Audio #1", and the first one's nick is just the card name.
const ARCTIS = "usb-SteelSeries_Arctis_Pro_Wireless-00";
const ARCTIS_CHAT = `alsa_output.${ARCTIS}.mono-chat`;
const ARCTIS_GAME = `alsa_output.${ARCTIS}.stereo-game`;
const ARCTIS_MIC = `alsa_input.${ARCTIS}.mono-chat`;
const arctisCard = { card: 3, cardName: "Arctis Pro Wireless", driver: "snd_usb_audio", deviceId: 52 };
const arctis = [
  core,
  device(52, { name: `alsa_card.${ARCTIS}`, desc: "Arctis Pro Wireless", nick: "Arctis Pro Wireless", card: 3, bus: "usb", serial: 52 }),
  alsaNode(40, { ...arctisCard, cls: "Audio/Sink", name: ARCTIS_CHAT, desc: "Arctis Pro Wireless Chat", nick: "Arctis Pro Wireless", dev: 0, profile: "Chat Output", profileName: "mono-chat", serial: 40, path: "hw:3,0", ch: 1 }),
  alsaNode(41, { ...arctisCard, cls: "Audio/Sink", name: ARCTIS_GAME, desc: "Arctis Pro Wireless Game", nick: "USB Audio #1", dev: 1, profile: "Game Output", profileName: "stereo-game", serial: 41, path: "hw:3,1", state: "running" }),
  alsaNode(43, { ...arctisCard, cls: "Audio/Source", name: ARCTIS_MIC, desc: "Arctis Pro Wireless Chat", nick: "Arctis Pro Wireless", dev: 0, profile: "Chat Input", profileName: "mono-chat", serial: 43, path: "hw:3,0", ch: 1 }),
  meta(
    34,
    "default",
    [
      { subject: 0, key: "default.audio.sink", type: "Spa:String:JSON", value: json(ARCTIS_GAME) },
      { subject: 0, key: "default.audio.source", type: "Spa:String:JSON", value: json(ARCTIS_MIC) },
    ],
    34,
  ),
];

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "pw-dump.json"), JSON.stringify(initial, null, 2) + "\n");
fs.writeFileSync(path.join(out, "pw-dump-arctis.json"), JSON.stringify(arctis, null, 2) + "\n");
fs.writeFileSync(path.join(out, "pw-dump-monitor.txt"), batches.map((b) => JSON.stringify(b, null, 2)).join("\n") + "\n");
console.log("wrote", batches.length, "batches");
