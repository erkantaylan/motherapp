// Discovery (DESIGN.md § 4.8): tools/*/manifest.json.
import * as fs from "node:fs";
import * as path from "node:path";
import type { NotificationKind, ToolManifest } from "@motherapp/protocol";

export interface DiscoveredTool {
  manifest: ToolManifest;
  /** Absolute tool directory; `serve` and `page` are relative to it. */
  dir: string;
}

export interface DiscoveryResult {
  tools: DiscoveredTool[];
  errors: { dir: string; error: string }[];
}

const ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
const KIND_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** A file name in the sound theme without its extension (or "none"), never a path. */
const SOUND_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Validates a parsed manifest; returns an error string or the typed manifest. */
export function validateManifest(raw: unknown): ToolManifest | string {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "manifest must be an object";
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== "string" || !ID_RE.test(m.id)) return "id must match " + ID_RE.source;
  if (m.id === "core") return 'id "core" is reserved';
  if (typeof m.title !== "string" || m.title === "") return "title must be a non-empty string";
  if (m.icon !== undefined && typeof m.icon !== "string") return "icon must be a string";
  if (!Array.isArray(m.serve) || m.serve.length === 0 || !m.serve.every((s) => typeof s === "string")) {
    return "serve must be a non-empty array of strings";
  }
  if (m.page !== undefined && typeof m.page !== "string") return "page must be a string";
  if (m.page !== undefined && (path.isAbsolute(m.page) || m.page.split(/[\\/]/).includes(".."))) {
    return "page must be a relative path inside the tool directory";
  }
  if (m.defaultEnabled !== undefined && typeof m.defaultEnabled !== "boolean") return "defaultEnabled must be a boolean";
  if (m.order !== undefined && (typeof m.order !== "number" || !Number.isFinite(m.order))) return "order must be a number";
  if (m.wide !== undefined && typeof m.wide !== "boolean") return "wide must be a boolean";
  if (m.localActions !== undefined && (!Array.isArray(m.localActions) || !m.localActions.every((a) => typeof a === "string"))) return "localActions must be an array of strings";
  let notifications: NotificationKind[] | undefined;
  if (m.notifications !== undefined) {
    if (!Array.isArray(m.notifications)) return "notifications must be an array";
    notifications = [];
    for (const raw of m.notifications as unknown[]) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "notifications: each kind must be an object";
      const k = raw as Record<string, unknown>;
      if (typeof k.id !== "string" || !KIND_RE.test(k.id)) return "notifications: a kind's id must match " + KIND_RE.source;
      if (notifications.some((n) => n.id === k.id)) return `notifications: duplicate kind "${k.id}"`;
      if (typeof k.label !== "string" || k.label === "") return `notifications: kind "${k.id}" needs a label`;
      if (k.sound !== undefined && (typeof k.sound !== "string" || !SOUND_RE.test(k.sound))) return `notifications: kind "${k.id}": sound must be a sound name or "none"`;
      notifications.push({ id: k.id, label: k.label, ...(k.sound !== undefined ? { sound: k.sound as string } : {}) });
    }
  }
  const out: ToolManifest = { id: m.id, title: m.title, serve: m.serve as string[] };
  if (m.icon !== undefined) out.icon = m.icon;
  if (m.page !== undefined) out.page = m.page;
  if (m.defaultEnabled !== undefined) out.defaultEnabled = m.defaultEnabled;
  if (m.order !== undefined) out.order = m.order;
  if (m.wide !== undefined) out.wide = m.wide;
  if (m.localActions !== undefined) out.localActions = m.localActions as string[];
  if (notifications !== undefined) out.notifications = notifications;
  return out;
}

export function discoverTools(toolsDir: string): DiscoveryResult {
  const result: DiscoveryResult = { tools: [], errors: [] };
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(toolsDir, { withFileTypes: true });
  } catch (e) {
    result.errors.push({ dir: toolsDir, error: (e as Error).message });
    return result;
  }
  const seen = new Set<string>();
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(toolsDir, entry.name);
    const file = path.join(dir, "manifest.json");
    if (!fs.existsSync(file)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      result.errors.push({ dir, error: `manifest.json: ${(e as Error).message}` });
      continue;
    }
    const m = validateManifest(raw);
    if (typeof m === "string") {
      result.errors.push({ dir, error: `manifest.json: ${m}` });
      continue;
    }
    if (seen.has(m.id)) {
      result.errors.push({ dir, error: `duplicate tool id "${m.id}"` });
      continue;
    }
    seen.add(m.id);
    result.tools.push({ manifest: m, dir });
  }
  return result;
}
