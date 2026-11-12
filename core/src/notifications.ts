// The notification service (DESIGN.md § 3 "Notifications"). Every tool notifies through here:
// a tool sends `notify { kind, title, body? }`, and the core decides whether it goes out (the
// user's settings, which the tool never sees), adds the tool's id, name and icon, keeps it in
// the history, shows the popup and plays the sound.
//
//   tool or kind turned off   dropped: no history, no popup, no sound
//   "mute all" on             recorded (`muted: true`) and pushed to pages; no popup, no sound
//   MOTHERAPP_NOTIFY=off      recorded and pushed to pages; no popup, no sound (delivery off)
//   too many                  more than RATE_MAX per tool in RATE_WINDOW_MS are dropped
import { NO_SOUND } from "@motherapp/protocol";
import type {
  JsonObject,
  LogLevel,
  NotificationEntry,
  NotificationKind,
  NotificationSettings,
  NotificationToolSettings,
} from "@motherapp/protocol";
import { RingBuffer } from "./logService.ts";
import { popupBody } from "./notifyDelivery.ts";
import type { Delivery } from "./notifyDelivery.ts";

export const HISTORY_SIZE = 200;
/** A tool may send this many notifications in any RATE_WINDOW_MS; the rest are dropped. */
export const RATE_MAX = 10;
export const RATE_WINDOW_MS = 10_000;
export const TITLE_MAX = 200;
export const BODY_MAX = 1000;

const KIND_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SOUND_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** config.json `notifications`. Only what the user changed is stored; the rest is defaults. */
export interface NotificationsConfig {
  /** Mute all. Default false. */
  muted: boolean;
  tools: Record<string, NotificationToolConfig>;
}

export interface NotificationToolConfig {
  /** Default true. */
  enabled?: boolean;
  kinds?: Record<string, { enabled?: boolean; sound?: string }>;
}

export function defaultNotificationsConfig(): NotificationsConfig {
  return { muted: false, tools: {} };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A saved `notifications`: well-formed parts only. */
export function normalizeNotifications(raw: unknown): NotificationsConfig {
  const cfg = defaultNotificationsConfig();
  if (!isObj(raw)) return cfg;
  if (raw.muted === true) cfg.muted = true;
  if (!isObj(raw.tools)) return cfg;
  for (const [id, t] of Object.entries(raw.tools)) {
    if (!isObj(t)) continue;
    const tool: NotificationToolConfig = {};
    if (typeof t.enabled === "boolean") tool.enabled = t.enabled;
    if (isObj(t.kinds)) {
      for (const [kind, k] of Object.entries(t.kinds)) {
        if (!isObj(k) || !KIND_RE.test(kind)) continue;
        const out: { enabled?: boolean; sound?: string } = {};
        if (typeof k.enabled === "boolean") out.enabled = k.enabled;
        if (typeof k.sound === "string" && SOUND_RE.test(k.sound)) out.sound = k.sound;
        if (Object.keys(out).length > 0) (tool.kinds ??= {})[kind] = out;
      }
    }
    if (Object.keys(tool).length > 0) cfg.tools[id] = tool;
  }
  return cfg;
}

/** What the service needs to know about a tool; the manager builds it (the tool can't forge it). */
export interface NotifyingTool {
  id: string;
  title: string;
  icon?: string;
  iconUrl?: string;
  /** The manifest's `notifications`. */
  kinds: NotificationKind[];
}

export interface NotificationStore {
  get(): NotificationsConfig;
  /** Persists the whole `notifications` value; throws when it can't be saved. */
  save(next: NotificationsConfig): void;
}

export interface NotificationServiceOptions {
  store: NotificationStore;
  /** Every tool, in display order. */
  tools(): NotifyingTool[];
  delivery: Delivery;
  log(level: LogLevel, msg: string, fields?: JsonObject, tool?: string): void;
  now?: () => number;
  historySize?: number;
}

export class NotificationError extends Error {}

export class NotificationService {
  private opts: NotificationServiceOptions;
  private ring: RingBuffer<NotificationEntry>;
  private seq = 0;
  private listeners = new Set<(entry: NotificationEntry) => void>();
  private settingsListeners = new Set<(s: NotificationSettings) => void>();
  /** Per tool: when its recent notifications were accepted (ms), for the rate limit. */
  private recent = new Map<string, number[]>();
  private limited = new Set<string>();
  private warnedKinds = new Set<string>();

  constructor(opts: NotificationServiceOptions) {
    this.opts = opts;
    this.ring = new RingBuffer(opts.historySize ?? HISTORY_SIZE);
  }

  // ---- from a tool ----

  /** A tool's `notify`. Returns the recorded entry, or undefined when it was dropped. */
  submit(tool: NotifyingTool, params: unknown): NotificationEntry | undefined {
    const log = (level: LogLevel, msg: string, fields?: JsonObject) => this.opts.log(level, msg, fields, tool.id);
    if (!isObj(params) || typeof params.kind !== "string" || !KIND_RE.test(params.kind) || typeof params.title !== "string") {
      log("debug", "ignoring a notify without a valid kind and title");
      return undefined;
    }
    const kind = params.kind;
    const title = oneLine(params.title).slice(0, TITLE_MAX);
    if (title === "") {
      log("debug", "ignoring a notify with an empty title", { kind });
      return undefined;
    }
    const body = typeof params.body === "string" ? params.body.trim().slice(0, BODY_MAX) : "";

    const declared = tool.kinds.find((k) => k.id === kind);
    if (!declared && !this.warnedKinds.has(`${tool.id}\0${kind}`)) {
      this.warnedKinds.add(`${tool.id}\0${kind}`);
      log("warn", `notification kind "${kind}" isn't in the manifest's "notifications"; delivered without a sound and without a row in Settings`, { kind });
    }
    const cfg = this.opts.store.get();
    const t = cfg.tools[tool.id];
    if (t?.enabled === false || t?.kinds?.[kind]?.enabled === false) return undefined;

    const now = (this.opts.now ?? Date.now)();
    if (!this.allow(tool.id, now)) {
      if (!this.limited.has(tool.id)) {
        this.limited.add(tool.id);
        log("warn", `too many notifications: more than ${RATE_MAX} in ${RATE_WINDOW_MS / 1000} s; dropping the rest until it slows down`);
      }
      return undefined;
    }
    this.limited.delete(tool.id);

    const entry: NotificationEntry = { seq: ++this.seq, ts: new Date(now).toISOString(), tool: tool.id, toolTitle: tool.title, kind, title };
    if (tool.icon !== undefined) entry.toolIcon = tool.icon;
    if (tool.iconUrl !== undefined) entry.toolIconUrl = tool.iconUrl;
    if (body !== "") entry.body = body;
    if (cfg.muted) entry.muted = true;
    this.ring.push(entry);
    log("debug", `notification (${kind})${cfg.muted ? ", muted" : ""}`, { kind, seq: entry.seq });

    if (!cfg.muted) {
      this.opts.delivery.popup(title, popupBody(tool.title, entry.body));
      this.opts.delivery.play(t?.kinds?.[kind]?.sound ?? declared?.sound ?? NO_SOUND);
    }
    for (const l of [...this.listeners]) {
      try {
        l(entry);
      } catch {
        // a broken listener must not stop the others
      }
    }
    return entry;
  }

  private allow(id: string, now: number): boolean {
    const times = (this.recent.get(id) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    const ok = times.length < RATE_MAX;
    if (ok) times.push(now);
    this.recent.set(id, times);
    return ok;
  }

  // ---- history ----

  /** Oldest first; with `limit`, the newest `limit`. */
  backlog(limit?: number): NotificationEntry[] {
    return this.ring.toArray(limit !== undefined && Number.isInteger(limit) && limit >= 0 ? limit : undefined);
  }

  subscribe(l: (entry: NotificationEntry) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  // ---- settings ----

  settings(): NotificationSettings {
    const cfg = this.opts.store.get();
    const tools: NotificationToolSettings[] = [];
    for (const tool of this.opts.tools()) {
      if (tool.kinds.length === 0) continue;
      const t = cfg.tools[tool.id];
      const out: NotificationToolSettings = {
        id: tool.id,
        title: tool.title,
        enabled: t?.enabled !== false,
        kinds: tool.kinds.map((k) => {
          const defaultSound = k.sound ?? NO_SOUND;
          return { id: k.id, label: k.label, enabled: t?.kinds?.[k.id]?.enabled !== false, sound: t?.kinds?.[k.id]?.sound ?? defaultSound, defaultSound };
        }),
      };
      if (tool.icon !== undefined) out.icon = tool.icon;
      if (tool.iconUrl !== undefined) out.iconUrl = tool.iconUrl;
      tools.push(out);
    }
    return { muted: cfg.muted, tools, sounds: this.opts.delivery.sounds(), delivery: this.opts.delivery.enabled };
  }

  onSettings(l: (s: NotificationSettings) => void): () => void {
    this.settingsListeners.add(l);
    return () => this.settingsListeners.delete(l);
  }

  private change(patch: (cfg: NotificationsConfig) => void): NotificationSettings {
    const next = structuredClone(this.opts.store.get());
    patch(next);
    this.opts.store.save(next);
    const s = this.settings();
    for (const l of [...this.settingsListeners]) l(s);
    return s;
  }

  setMuted(muted: boolean): NotificationSettings {
    this.opts.log("info", muted ? "notifications muted" : "notifications unmuted");
    return this.change((cfg) => {
      cfg.muted = muted;
    });
  }

  private tool(id: string): NotifyingTool {
    const tool = this.opts.tools().find((t) => t.id === id);
    if (!tool) throw new NotificationError(`unknown tool: ${id}`);
    return tool;
  }

  setTool(id: string, enabled: boolean): NotificationSettings {
    this.tool(id);
    this.opts.log("info", `notifications ${enabled ? "on" : "off"}`, undefined, id);
    return this.change((cfg) => {
      (cfg.tools[id] ??= {}).enabled = enabled;
    });
  }

  setKind(id: string, kind: string, change: { enabled?: boolean; sound?: string }): NotificationSettings {
    if (!this.tool(id).kinds.some((k) => k.id === kind)) throw new NotificationError(`${id} has no notification kind "${kind}"`);
    if (change.sound !== undefined && change.sound !== NO_SOUND && !this.opts.delivery.sounds().includes(change.sound)) {
      throw new NotificationError("unknown sound");
    }
    this.opts.log("info", `notification kind "${kind}" changed`, { kind, ...(change.enabled !== undefined ? { enabled: change.enabled } : {}), ...(change.sound !== undefined ? { sound: change.sound } : {}) }, id);
    return this.change((cfg) => {
      const k = (((cfg.tools[id] ??= {}).kinds ??= {})[kind] ??= {});
      if (change.enabled !== undefined) k.enabled = change.enabled;
      if (change.sound !== undefined) k.sound = change.sound;
    });
  }

  /** The Settings play button. Plays even while muted: the user asked to hear it. */
  previewSound(sound: string): void {
    if (!this.opts.delivery.sounds().includes(sound)) throw new NotificationError("unknown sound");
    this.opts.delivery.play(sound, { preview: true });
  }
}

/** Newlines and other control characters become spaces: a title is one line. */
function oneLine(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
}
