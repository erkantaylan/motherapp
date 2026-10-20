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
  defaultSinkName?: string;
  defaultSourceName?: string;
  apps: AppGroup[];
}

export interface ViewOptions {
  /** Streams from these process ids are hidden (the tool's own test sounds). */
  isOwnPid?: (pid: number) => boolean;
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

export function buildView(objects: Iterable<PwObject>, opts: ViewOptions = {}): AudioView {
  const view: AudioView = { sinks: [], sources: [], apps: [] };
  const apps = new Map<string, AppGroup>();
  for (const o of objects) {
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
      const dev: Device = { id: o.id, kind: cls === "Audio/Sink" ? "sink" : "source", name, title, subtitle };
      (dev.kind === "sink" ? view.sinks : view.sources).push(dev);
    } else if (cls === "Stream/Output/Audio") {
      const role = str(p["media.role"]);
      if (role && SKIPPED_ROLES.has(role.toLowerCase())) continue;
      const pid = Number(p["application.process.id"]);
      if (Number.isInteger(pid) && opts.isOwnPid?.(pid)) continue;
      const binary = str(p["application.process.binary"]);
      const name = str(p["application.name"]) ?? binary ?? str(p["node.name"]) ?? `Stream ${o.id}`;
      const key = escapeKey(name);
      let app = apps.get(key);
      if (!app) {
        app = { key, name, streams: [] };
        if (binary) app.binary = binary;
        apps.set(key, app);
      }
      const s: AppStream = { id: o.id, muted: nodeMuted(o) };
      const lin = nodeLinearVolume(o);
      if (lin !== undefined) s.linear = lin;
      const media = str(p["media.name"]);
      if (media) s.mediaName = media;
      app.streams.push(s);
    }
  }
  const byTitle = (a: Device, b: Device) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()) || a.id - b.id;
  view.sinks.sort(byTitle);
  view.sources.sort(byTitle);
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

/** The tool state: maps keyed by PipeWire id (devices) or escaped app name (apps). */
export function viewToState(view: AudioView): DerivedState {
  const sinks: Dict = {};
  for (const d of view.sinks) sinks[String(d.id)] = deviceItem(d);
  const sources: Dict = {};
  for (const d of view.sources) sources[String(d.id)] = deviceItem(d);
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
