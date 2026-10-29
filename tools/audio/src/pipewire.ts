// The PipeWire object graph as `pw-dump` describes it, and what the audio tool derives from it:
// output/input devices, the defaults and one entry per app that is playing sound.
//
// Shapes (PipeWire 1.0 `pw-dump`):
// - a node:      { id, type: "PipeWire:Interface:Node", info: { props: {...}, params: { Props: [...] } } }
// - metadata:    { id, type: "PipeWire:Interface:Metadata", props: { "metadata.name": "default" },
//                  metadata: [{ subject, key, type, value }] }
// - a removal (`--monitor` only): { id, info: null }

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Dict = { [k: string]: Json };

export interface MetadataEntry {
  subject: number;
  key: string;
  type?: string | null;
  value: Json;
}

export interface PwObject {
  id: number;
  type?: string;
  info?: Dict | null;
  props?: Dict;
  metadata?: MetadataEntry[];
  [k: string]: unknown;
}

export const NODE = "PipeWire:Interface:Node";
export const METADATA = "PipeWire:Interface:Metadata";
export const DEVICE = "PipeWire:Interface:Device";
export const CLIENT = "PipeWire:Interface:Client";

const isDict = (v: unknown): v is Dict => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The object graph, kept up to date from `pw-dump --monitor` batches. Updates are merged:
 * `info.props` and each `info.params.<Name>` replace the old ones when present (pw-dump sends
 * them whole), and metadata entries are merged by (subject, key), `value: null` deleting one.
 */
export class PwModel {
  readonly objects = new Map<number, PwObject>();

  clear(): void {
    this.objects.clear();
  }

  /** Applies one batch (one JSON array from pw-dump). Returns false if nothing was usable. */
  apply(batch: unknown): boolean {
    const items = Array.isArray(batch) ? batch : [batch];
    let any = false;
    for (const raw of items) {
      if (!isDict(raw) || typeof raw.id !== "number") continue;
      any = true;
      const obj = raw as unknown as PwObject;
      if ("info" in obj && obj.info === null) {
        this.objects.delete(obj.id);
        continue;
      }
      const old = this.objects.get(obj.id);
      this.objects.set(obj.id, old && old.type === obj.type ? merge(old, obj) : normalise(obj));
    }
    return any;
  }
}

function normalise(obj: PwObject): PwObject {
  if (obj.type !== METADATA || !Array.isArray(obj.metadata)) return obj;
  // A first sighting can't delete anything; drop null entries so state never holds them.
  return { ...obj, metadata: obj.metadata.filter((e) => e.value !== null) };
}

function merge(old: PwObject, upd: PwObject): PwObject {
  const out: PwObject = { ...old, ...upd };
  if (isDict(old.info) && isDict(upd.info)) {
    const info: Dict = { ...old.info, ...upd.info };
    if (isDict(old.info.params) && isDict(upd.info.params)) info.params = { ...old.info.params, ...upd.info.params };
    out.info = info;
  }
  if (old.type === METADATA && Array.isArray(upd.metadata)) {
    const entries = new Map<string, MetadataEntry>();
    for (const e of old.metadata ?? []) entries.set(`${e.subject}\u0000${e.key}`, e);
    for (const e of upd.metadata) {
      const k = `${e.subject}\u0000${e.key}`;
      if (e.value === null) entries.delete(k);
      else entries.set(k, e);
    }
    out.metadata = [...entries.values()];
  }
  return out;
}

// ---- volume ----
//
// pw-dump's `channelVolumes` are linear amplitude factors. wpctl (and pulse, and GNOME's
// sliders) use a cubic scale: wpctl shows cbrt(linear) and `wpctl set-volume X 0.5` stores
// 0.5³ = 0.125. The tool presents the number `wpctl get-volume` prints, as a percentage.

/** Linear channel volume → the percentage `wpctl get-volume` shows (0.343 → 70). */
export function linearToPercent(linear: number): number {
  if (!Number.isFinite(linear) || linear <= 0) return 0;
  return Math.round(Math.cbrt(linear) * 100);
}

/** Percentage → linear channel volume (70 → 0.343). */
export function percentToLinear(percent: number): number {
  return Math.pow(Math.max(0, percent) / 100, 3);
}

/** Percentage → the argument for `wpctl set-volume` (cubic scale, 70 → "0.70"). */
export function percentToWpctl(percent: number): string {
  return (Math.max(0, percent) / 100).toFixed(2);
}

export const MAX_APP_VOLUME = 150;

/** The `Props` param of a node that carries the mixer values (there can be more than one). */
function mixerProps(node: PwObject): Dict | undefined {
  const params = isDict(node.info) && isDict(node.info.params) ? node.info.params : undefined;
  const props = params?.Props;
  if (!Array.isArray(props)) return undefined;
  return props.find((p): p is Dict => isDict(p) && Array.isArray(p.channelVolumes)) ?? props.find(isDict);
}

/** Average linear channel volume, like WirePlumber's mixer API; undefined if not known yet. */
export function nodeLinearVolume(node: PwObject): number | undefined {
  const p = mixerProps(node);
  const ch = p?.channelVolumes;
  if (Array.isArray(ch)) {
    const nums = ch.filter((x): x is number => typeof x === "number");
    if (nums.length > 0) return nums.reduce((a, b) => a + b, 0) / nums.length;
  }
  return typeof p?.volume === "number" ? p.volume : undefined;
}

export function nodeMuted(node: PwObject): boolean {
  return mixerProps(node)?.mute === true;
}

// ---- derived view ----

export interface Device {
  id: number;
  kind: "sink" | "source";
  /** node.name: what `pw-play/pw-record --target` and the default metadata use. */
  name: string;
  /** Row title: node.description, as `wpctl status` and GNOME show it (see deviceTitles). */
  title: string;
  /** Second line: node.nick when it adds something to the title (e.g. an HDMI monitor's name), else "". */
  subtitle: string;
  /** Linear average channel volume from the node's Props, if it has reported one. */
  linear?: number;
  muted: boolean;
  /** The card (PipeWire Device object) and its card.profile.device this node belongs to. */
  card?: number;
  cardDevice?: number;
}

/** A sound card (a PipeWire Device with media.class Audio/Device). */
export interface Card {
  id: number;
  name: string;
  description: string;
  api: string;
  /** Index of the active profile, if known. */
  profile?: number;
  /** Active route index per card.profile.device, from the Route param. */
  routes: Map<number, number>;
}

/**
 * An output or input the card offers but that has no node right now: an EnumRoute (a port, in
 * GNOME's words) whose profile isn't active, or that isn't the active route of its device.
 * Selecting it switches the card's profile (and/or route), waits for the node, then makes the
 * node the default. GNOME lists these too: it shows one entry per available port.
 */
export interface RouteOption {
  /** State key and CLI id: "route-<card>-<route index>". */
  key: string;
  kind: "sink" | "source";
  card: number;
  route: number;
  routeName: string;
  /** The profiles the route is part of; any of them being active counts. */
  profiles: number[];
  /** card.profile.device the node will have. */
  device: number;
  /** Profile to switch to; undefined when the route is on the active profile (only set-route). */
  profile?: number;
  /** "<port description> – <card description>", as GNOME titles it. */
  title: string;
  subtitle: string;
}

export interface AppStream {
  id: number;
  /** Linear average channel volume, if the stream has reported one. */
  linear?: number;
  muted: boolean;
  mediaName?: string;
}

export interface AppGroup {
  /** State key: the app name escaped so it's a safe path segment. */
  key: string;
  name: string;
  binary?: string;
  streams: AppStream[];
}

export interface AudioView {
  sinks: Device[];
  sources: Device[];
  /** Outputs/inputs a card can switch to that have no node yet (see RouteOption). */
  sinkRoutes: RouteOption[];
  sourceRoutes: RouteOption[];
  cards: Card[];
  defaultSinkName?: string;
  defaultSourceName?: string;
  apps: AppGroup[];
}

export interface ViewOptions {
  /** Streams from these process ids are hidden (the tool's own test sounds). */
  isOwnPid?: (pid: number) => boolean;
  /** The Name= of the desktop entry for a process binary, if one is known (see desktop.ts). */
  desktopName?: (binary: string) => string | undefined;
}

/**
 * application.name values that name a library, not the app: Discord's voice streams are
 * "WEBRTC VoiceEngine" (GNOME shows that too), ALSA and Chromium-based apps send generic names.
 */
const GENERIC_APP_NAME = /^(WEBRTC VoiceEngine|ALSA plug-in \[.*\]|PipeWire ALSA \[.*\]|Chromium( input)?)$/i;

export const isGenericAppName = (name: string | undefined): boolean => !name || GENERIC_APP_NAME.test(name.trim());

/**
 * An app row's name: the first application.name that isn't generic; else the desktop entry's
 * Name= for the binary; else the binary, capitalised ("spotify" → "Spotify").
 */
export function appDisplayName(names: readonly string[], binary: string | undefined, desktopName?: (binary: string) => string | undefined): string | undefined {
  const good = names.find((n) => !isGenericAppName(n));
  if (good) return good;
  if (binary) return desktopName?.(binary) ?? binary.charAt(0).toUpperCase() + binary.slice(1);
  return names[0];
}

/** media.role values of short-lived streams that would make rows flicker (event sounds). */
const SKIPPED_ROLES = new Set(["event", "notification"]);

const str = (v: Json | undefined): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

function nodeProps(o: PwObject): Dict | undefined {
  return isDict(o.info) && isDict(o.info.props) ? o.info.props : undefined;
}

/** State keys must not contain "." (and stay readable in paths): escape everything but [A-Za-z0-9-]. */
export function escapeKey(name: string): string {
  let out = "";
  for (const ch of name) {
    if (/[A-Za-z0-9-]/.test(ch)) out += ch;
    else out += [...Buffer.from(ch, "utf8")].map((b) => "_" + b.toString(16).padStart(2, "0")).join("");
  }
  return out || "_";
}

/** The default metadata stores `{"name": "<node.name>"}` (parsed by pw-dump, or as a JSON string). */
function metadataName(v: Json): string | undefined {
  if (isDict(v)) return str(v.name);
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v) as unknown;
      if (isDict(parsed) && typeof parsed.name === "string") return parsed.name;
    } catch {
      return v || undefined;
    }
  }
  return undefined;
}

/**
 * ALSA PCM names that end up in node.nick when there is nothing better. They say nothing about
 * the device: "USB Audio #1" is the second PCM of any USB card (issue #5).
 */
const GENERIC_NICK = /^(USB Audio|HDMI|DisplayPort|Digital|Analog|S\/PDIF|IEC958)( #?\d+)?$|^subdevice #\d+$/i;

/**
 * Title and second line of an output or input. The title is node.description, which is what
 * `wpctl status` and GNOME show, and which tells a headset's Chat and Game PCMs apart.
 * audio-switch titled rows with node.nick because it is shorter and, on HDMI, names the monitor
 * ("X34 P"). But on a USB card with several PCMs the nick is the card name on one PCM and a
 * generic PCM name ("USB Audio #1") on the next. So the nick only becomes the second line, and
 * only when it isn't generic and isn't already part of the title.
 */
export function deviceTitles(p: Dict, name: string): { title: string; subtitle: string } {
  const nick = str(p["node.nick"]);
  const useful = nick !== undefined && !GENERIC_NICK.test(nick.trim()) ? nick : undefined;
  const title = str(p["node.description"]) ?? useful ?? name;
  const subtitle = useful !== undefined && !title.toLowerCase().includes(useful.toLowerCase()) ? useful : "";
  return { title, subtitle };
}

// ---- cards, profiles and routes ----
//
// A card (Device object) has profiles (EnumProfile, one active in Profile) and routes
// (EnumRoute, the active ones in Route). Only the active profile has nodes, so a Bluetooth
// headset in A2DP has no HFP node, and an HDA card with S/PDIF active has no Line Out node.
// GNOME lists every route whose `available` isn't "no"; so does the tool.

/** Bluetooth profile families. Codec variants (a2dp-sink-sbc_xq, headset-head-unit-msbc) share one. */
export function bluezMode(profileName: string | undefined): string {
  if (!profileName) return "";
  if (/^a2dp/.test(profileName)) return "A2DP: high fidelity";
  if (/^(headset-head-unit|hsp|hfp|audio-gateway)/.test(profileName)) return "HFP: headset with mic";
  return "";
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) ? v : undefined);
const nums = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : []);
const params = (o: PwObject, name: string): Dict[] => {
  const p = isDict(o.info) && isDict(o.info.params) ? o.info.params[name] : undefined;
  return Array.isArray(p) ? p.filter(isDict) : [];
};

/**
 * The card.profile.devices a profile has for a media class. ALSA writes `classes` as
 * [count, [class, n, "card.profile.devices", [ids]], …], bluez5 without the leading count.
 */
export function profileDevices(profile: Dict, cls: string): number[] {
  const classes = profile.classes;
  if (!Array.isArray(classes)) return [];
  for (const c of classes) {
    if (!Array.isArray(c) || c[0] !== cls) continue;
    const i = c.indexOf("card.profile.devices");
    return i >= 0 ? nums(c[i + 1]) : [];
  }
  return [];
}

const UNUSABLE_PROFILES = new Set(["off", "pro-audio"]);

/**
 * Where selecting a route leads: the profile to switch to (none when the route is on the active
 * profile) and the card.profile.device its node will have. Among the route's profiles, prefer
 * one that keeps the card's other direction as it is (switching to Line Out keeps the analog
 * mic of a duplex card), then the highest EnumProfile priority, as WirePlumber does.
 */
export function routeTarget(
  route: Dict,
  profiles: Dict[],
  active: Dict | undefined,
  kind: "sink" | "source",
): { profile?: number; device: number } | undefined {
  const cls = kind === "sink" ? "Audio/Sink" : "Audio/Source";
  const other = kind === "sink" ? "Audio/Source" : "Audio/Sink";
  const routeProfiles = nums(route.profiles);
  const routeDevices = nums(route.devices);
  const deviceIn = (p: Dict) => {
    const devs = profileDevices(p, cls);
    return routeDevices.find((d) => devs.includes(d));
  };
  if (active && routeProfiles.includes(num(active.index) ?? -1)) {
    const device = deviceIn(active) ?? routeDevices[0];
    return device === undefined ? undefined : { device };
  }
  const keep = active ? profileDevices(active, other) : [];
  const candidates = profiles
    .filter((p) => routeProfiles.includes(num(p.index) ?? -1) && p.available !== "no" && !UNUSABLE_PROFILES.has(String(p.name)))
    .map((p) => {
      const otherDevs = profileDevices(p, other);
      return { p, device: deviceIn(p), keeps: keep.every((d) => otherDevs.includes(d)) ? 1 : 0, prio: num(p.priority) ?? 0 };
    })
    .filter((c) => c.device !== undefined)
    .sort((a, b) => b.keeps - a.keeps || b.prio - a.prio || (num(a.p.index) ?? 0) - (num(b.p.index) ?? 0));
  const best = candidates[0];
  return best ? { profile: num(best.p.index)!, device: best.device! } : undefined;
}

function readCard(o: PwObject): { card: Card; options: RouteOption[] } | undefined {
  const p = nodeProps(o);
  if (!p || p["media.class"] !== "Audio/Device") return undefined;
  const name = str(p["device.name"]) ?? `card ${o.id}`;
  const description = str(p["device.description"]) ?? str(p["device.nick"]) ?? name;
  const api = str(p["device.api"]) ?? "";
  const profiles = params(o, "EnumProfile");
  const activeIndex = num(params(o, "Profile")[0]?.index);
  const active = profiles.find((x) => num(x.index) === activeIndex) ?? params(o, "Profile")[0];
  const card: Card = { id: o.id, name, description, api, routes: new Map() };
  if (activeIndex !== undefined) card.profile = activeIndex;
  const activeRoutes = new Set<number>();
  for (const r of params(o, "Route")) {
    const idx = num(r.index);
    const dev = num(r.device);
    if (idx === undefined) continue;
    activeRoutes.add(idx);
    if (dev !== undefined) card.routes.set(dev, idx);
  }
  const options: RouteOption[] = [];
  for (const r of params(o, "EnumRoute")) {
    const idx = num(r.index);
    if (idx === undefined || activeRoutes.has(idx) || r.available === "no") continue;
    const kind = r.direction === "Output" ? "sink" : r.direction === "Input" ? "source" : undefined;
    if (!kind) continue;
    const target = routeTarget(r, profiles, active, kind);
    if (!target) continue;
    const routeName = str(r.name) ?? `route ${idx}`;
    const portDesc = str(r.description) ?? routeName;
    const targetProfile = target.profile === undefined ? active : profiles.find((x) => num(x.index) === target.profile);
    const opt: RouteOption = {
      key: `route-${o.id}-${idx}`,
      kind,
      card: o.id,
      route: idx,
      routeName,
      profiles: nums(r.profiles),
      device: target.device,
      title: `${portDesc} – ${description}`,
      subtitle: api === "bluez5" ? bluezMode(str(targetProfile?.name)) : "",
    };
    if (target.profile !== undefined) opt.profile = target.profile;
    options.push(opt);
  }
  return { card, options };
}

/** The node a route option leads to, once its profile is active (undefined until then). */
export function routeNode(view: AudioView, opt: RouteOption): Device | undefined {
  const card = view.cards.find((c) => c.id === opt.card);
  if (!card || card.profile === undefined || !opt.profiles.includes(card.profile)) return undefined;
  const list = opt.kind === "sink" ? view.sinks : view.sources;
  return list.find((d) => d.card === opt.card && d.cardDevice === opt.device);
}

export function buildView(objects: Iterable<PwObject>, opts: ViewOptions = {}): AudioView {
  const view: AudioView = { sinks: [], sources: [], sinkRoutes: [], sourceRoutes: [], cards: [], apps: [] };
  const apps = new Map<string, AppGroup>();
  const groups = new Map<string, { names: string[]; binary?: string; nodeName?: string; firstId?: number; streams: AppStream[] }>();
  const all = [...objects];
  const clients = new Map<number, Dict>();
  for (const o of all) if (o.type === CLIENT && isDict(o.info) && isDict(o.info.props)) clients.set(o.id, o.info.props);
  for (const o of all) {
    if (o.type === DEVICE) {
      const c = readCard(o);
      if (!c) continue;
      view.cards.push(c.card);
      for (const opt of c.options) (opt.kind === "sink" ? view.sinkRoutes : view.sourceRoutes).push(opt);
      continue;
    }
    if (o.type === METADATA) {
      if (o.props?.["metadata.name"] !== "default") continue;
      for (const e of o.metadata ?? []) {
        if (e.subject !== 0) continue;
        if (e.key === "default.audio.sink") view.defaultSinkName = metadataName(e.value);
        else if (e.key === "default.audio.source") view.defaultSourceName = metadataName(e.value);
      }
      continue;
    }
    if (o.type !== NODE) continue;
    const p = nodeProps(o);
    if (!p) continue;
    const cls = p["media.class"];
    // Exact classes only, like audio-switch: that skips monitors and virtual sources.
    if (cls === "Audio/Sink" || cls === "Audio/Source") {
      const name = str(p["node.name"]);
      if (!name) continue;
      const { title, subtitle } = deviceTitles(p, name);
      const dev: Device = { id: o.id, kind: cls === "Audio/Sink" ? "sink" : "source", name, title, subtitle, muted: nodeMuted(o) };
      const lin = nodeLinearVolume(o);
      if (lin !== undefined) dev.linear = lin;
      const card = num(Number(p["device.id"]));
      const cardDevice = num(Number(p["card.profile.device"]));
      if (card !== undefined && p["device.id"] !== undefined) dev.card = card;
      if (cardDevice !== undefined && p["card.profile.device"] !== undefined) dev.cardDevice = cardDevice;
      // A Bluetooth node's second line names its mode, so A2DP and HFP read apart.
      if (p["device.api"] === "bluez5" && dev.subtitle === "") dev.subtitle = bluezMode(str(p["api.bluez5.profile"]));
      (dev.kind === "sink" ? view.sinks : view.sources).push(dev);
    } else if (cls === "Stream/Output/Audio") {
      const role = str(p["media.role"]);
      if (role && SKIPPED_ROLES.has(role.toLowerCase())) continue;
      // A stream node may lack the application.* props its client has (Spotify's does).
      const client = clients.get(Number(p["client.id"]));
      const prop = (k: string) => str(p[k]) ?? str(client?.[k]);
      const pid = Number(p["application.process.id"] ?? client?.["application.process.id"]);
      if (Number.isInteger(pid) && opts.isOwnPid?.(pid)) continue;
      const binary = prop("application.process.binary");
      const appName = prop("application.name");
      // Streams group by process binary when there is one, so Discord's "WEBRTC VoiceEngine"
      // and any other stream it plays make one row; otherwise by name, as before.
      const group = binary ? `bin:${binary.toLowerCase()}` : `name:${appName ?? str(p["node.name"]) ?? `Stream ${o.id}`}`;
      let g = groups.get(group);
      if (!g) {
        g = { names: [], streams: [] };
        if (binary) g.binary = binary;
        const fallback = str(p["node.name"]);
        if (fallback) g.nodeName = fallback;
        g.firstId = o.id;
        groups.set(group, g);
      }
      if (appName) g.names.push(appName);
      const s: AppStream = { id: o.id, muted: nodeMuted(o) };
      const lin = nodeLinearVolume(o);
      if (lin !== undefined) s.linear = lin;
      const media = str(p["media.name"]);
      if (media) s.mediaName = media;
      g.streams.push(s);
    }
  }
  for (const g of groups.values()) {
    const name = appDisplayName(g.names, g.binary, opts.desktopName) ?? g.nodeName ?? `Stream ${g.firstId}`;
    let key = escapeKey(name);
    if (apps.has(key)) key = `${key}-${escapeKey(g.binary ?? String(g.firstId))}`;
    const app: AppGroup = { key, name, streams: g.streams };
    if (g.binary) app.binary = g.binary;
    apps.set(key, app);
  }
  const byTitle = (a: Device, b: Device) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()) || a.id - b.id;
  view.sinks.sort(byTitle);
  view.sources.sort(byTitle);
  const optByTitle = (a: RouteOption, b: RouteOption) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()) || a.key.localeCompare(b.key);
  view.sinkRoutes.sort(optByTitle);
  view.sourceRoutes.sort(optByTitle);
  view.apps = [...apps.values()].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  for (const a of view.apps) a.streams.sort((x, y) => x.id - y.id);
  return view;
}

// ---- view → tool state ----

/** What an app row shows: the loudest stream, and muted only when every stream is. */
export function appVolume(app: AppGroup): number {
  const known = app.streams.map((s) => s.linear).filter((x): x is number => x !== undefined);
  return known.length === 0 ? 100 : linearToPercent(Math.max(...known));
}

export function appMuted(app: AppGroup): boolean {
  return app.streams.length > 0 && app.streams.every((s) => s.muted);
}

function appDetail(app: AppGroup): string {
  if (app.streams.length !== 1) return `${app.streams.length} streams`;
  const m = app.streams[0]!.mediaName;
  return m && m !== app.name ? m : "";
}

/** The keys of the tool state that come from PipeWire. */
export const DERIVED_KEYS = ["sinks", "sources", "defaultSink", "defaultSource", "apps"] as const;

export type DerivedState = { [K in (typeof DERIVED_KEYS)[number]]: Json };

function deviceItem(d: Device): Dict {
  return { name: d.name, title: d.title, subtitle: d.subtitle };
}

/** A route with no node yet: same row shape, no node name. */
function routeItem(r: RouteOption): Dict {
  return { name: "", title: r.title, subtitle: r.subtitle };
}

/** The tool state: maps keyed by PipeWire id (devices) or escaped app name (apps). */
export function viewToState(view: AudioView): DerivedState {
  const sinks: Dict = {};
  for (const d of view.sinks) sinks[String(d.id)] = deviceItem(d);
  for (const r of view.sinkRoutes) sinks[r.key] = routeItem(r);
  const sources: Dict = {};
  for (const d of view.sources) sources[String(d.id)] = deviceItem(d);
  for (const r of view.sourceRoutes) sources[r.key] = routeItem(r);
  const apps: Dict = {};
  for (const a of view.apps) {
    const item: Dict = { name: a.name, volume: appVolume(a), muted: appMuted(a), streams: a.streams.length, detail: appDetail(a) };
    apps[a.key] = item;
  }
  const idOf = (list: Device[], name: string | undefined) => String(list.find((d) => d.name === name)?.id ?? "");
  return {
    sinks,
    sources,
    defaultSink: idOf(view.sinks, view.defaultSinkName),
    defaultSource: idOf(view.sources, view.defaultSourceName),
    apps,
  };
}

// ---- master volume: the default output and input ----
//
// State key "master": { output: {...}, input: {...} }, rendered as a two-row list at the top of
// the page: a slider and a mute toggle per row, with a one-line "Acts on: <device>" caption.
// Each item follows whichever device is the default. The caption is never empty, so nothing
// on the page appears or vanishes while a slider is dragged (#12).

export type MasterKind = "output" | "input";
export const MASTER_KINDS: readonly MasterKind[] = ["output", "input"];
export const MAX_MASTER_VOLUME = MAX_APP_VOLUME;

const MASTER_ROLE: Record<MasterKind, { role: string; order: number; none: string }> = {
  output: { role: "Output", order: 0, none: "No default output" },
  input: { role: "Mic", order: 1, none: "No default input" },
};

/** The device the default metadata names, if it is in the graph. */
export function defaultDevice(view: AudioView, kind: MasterKind): Device | undefined {
  const [list, name] = kind === "output" ? [view.sinks, view.defaultSinkName] : [view.sources, view.defaultSourceName];
  return name === undefined ? undefined : list.find((d) => d.name === name);
}

/** The percentage `wpctl get-volume` shows for a device (100 until its Props are known). */
export function deviceVolume(d: Device): number {
  return d.linear === undefined ? 100 : linearToPercent(d.linear);
}

/** A master row for this device; `undefined` device = the placeholder shown before any default is known. */
export function masterItem(kind: MasterKind, d: Device | undefined): Dict {
  const r = MASTER_ROLE[kind];
  if (!d) return { role: r.role, order: r.order, id: "", caption: r.none, volume: 0, muted: false };
  return { role: r.role, order: r.order, id: String(d.id), caption: `Acts on: ${d.title}`, volume: deviceVolume(d), muted: d.muted };
}

/** The master rows for the defaults present in the graph; a kind with no default is left out. */
export function masterState(view: AudioView): Partial<Record<MasterKind, Dict>> {
  const out: Partial<Record<MasterKind, Dict>> = {};
  for (const k of MASTER_KINDS) {
    const d = defaultDevice(view, k);
    if (d) out[k] = masterItem(k, d);
  }
  return out;
}

// ---- lookups for the CLI and actions ----

export function findDevice(view: AudioView, query: string, kind?: "sink" | "source"): Device {
  const all = [...(kind !== "source" ? view.sinks : []), ...(kind !== "sink" ? view.sources : [])];
  const what = kind === "sink" ? "output" : kind === "source" ? "input" : "device";
  const q = query.trim();
  if (/^\d+$/.test(q)) {
    const d = all.find((x) => x.id === Number(q));
    if (d) return d;
    throw new Error(`No ${what} with id ${q}`);
  }
  const lower = q.toLowerCase();
  const tiers: ((d: Device) => boolean)[] = [
    (d) => d.name === q,
    (d) => d.title.toLowerCase() === lower || d.subtitle.toLowerCase() === lower,
    (d) => [d.name, d.title, d.subtitle].some((s) => s.toLowerCase().includes(lower)),
  ];
  for (const t of tiers) {
    const hits = all.filter(t);
    if (hits.length === 1) return hits[0]!;
    if (hits.length > 1) {
      throw new Error(`"${q}" matches several ${what}s: ${hits.map((d) => `${d.id} (${d.title})`).join(", ")}`);
    }
  }
  throw new Error(`No ${what} matches "${q}"`);
}

/** What `set-default` and the radio can select: a node, or a route that has no node yet. */
export type Target = { device: Device } | { route: RouteOption };

/**
 * Like findDevice, but also matches routes with no node (by key "route-<card>-<index>", title
 * or a unique part of it), so `audioctl set-default "Line Out"` switches the card's profile.
 */
export function findTarget(view: AudioView, query: string, kind?: "sink" | "source"): Target {
  const q = query.trim();
  const routes = [...(kind !== "source" ? view.sinkRoutes : []), ...(kind !== "sink" ? view.sourceRoutes : [])];
  if (/^\d+$/.test(q)) return { device: findDevice(view, q, kind) };
  const exactRoute = routes.find((r) => r.key === q);
  if (exactRoute) return { route: exactRoute };
  const what = kind === "sink" ? "output" : kind === "source" ? "input" : "device";
  const all = [...(kind !== "source" ? view.sinks : []), ...(kind !== "sink" ? view.sources : [])];
  interface Hit {
    label: string;
    target: Target;
    exact: boolean;
    texts: string[];
  }
  const lowered = (xs: string[]) => xs.filter(Boolean).map((x) => x.toLowerCase());
  const hits: Hit[] = [
    ...all.map((d) => ({ label: `${d.id} (${d.title})`, target: { device: d }, exact: d.name === q, texts: lowered([d.name, d.title, d.subtitle]) })),
    ...routes.map((r) => ({ label: `${r.key} (${r.title})`, target: { route: r }, exact: false, texts: lowered([r.title, r.subtitle, r.routeName]) })),
  ];
  const lower = q.toLowerCase();
  const tiers: ((h: Hit) => boolean)[] = [
    (h) => h.exact,
    (h) => h.texts.includes(lower),
    (h) => h.texts.some((x) => x.includes(lower)),
  ];
  for (const tier of tiers) {
    const found = hits.filter(tier);
    if (found.length === 1) return found[0]!.target;
    if (found.length > 1) throw new Error(`"${q}" matches several ${what}s: ${found.map((h) => h.label).join(", ")}`);
  }
  throw new Error(`No ${what} matches "${q}"`);
}

export function findApp(view: AudioView, query: string): AppGroup {
  const q = query.trim();
  const lower = q.toLowerCase();
  const tiers: ((a: AppGroup) => boolean)[] = [
    (a) => a.key === q,
    (a) => a.name.toLowerCase() === lower || a.binary?.toLowerCase() === lower,
    (a) => a.name.toLowerCase().includes(lower) || (a.binary?.toLowerCase().includes(lower) ?? false),
  ];
  for (const t of tiers) {
    const hits = view.apps.filter(t);
    if (hits.length === 1) return hits[0]!;
    if (hits.length > 1) throw new Error(`"${q}" matches several apps: ${hits.map((a) => a.name).join(", ")}`);
  }
  throw new Error(`No app playing sound matches "${q}"`);
}
