// Notifications on the client, as plain data (DOM-free, so it's unit-tested without a browser):
// the history the bell panel shows, what counts as unread, and small helpers for Settings.
import { NO_SOUND } from "@motherapp/protocol";
import type { NotificationEntry } from "@motherapp/protocol";

/** As many as the core keeps. */
export const MAX_ENTRIES = 200;

/**
 * The page's copy of the core's history, oldest first. The core is the source of truth: every
 * (re)connect subscribes again and `sync` replaces the list with the backlog, which also covers
 * a restarted core (its history is empty and its seq starts over). Between syncs `add` takes
 * the live pushes and drops what the list already has, by seq.
 */
export class NotificationFeed {
  private list: NotificationEntry[] = [];
  /** Pushes that arrived while a subscribe was on its way; merged in by `sync`. */
  private pending: NotificationEntry[] | undefined;

  get entries(): readonly NotificationEntry[] {
    return this.list;
  }

  /** A subscribe request was sent: hold live pushes until its backlog arrives. */
  beginSync(): void {
    this.pending = [];
  }

  /** The backlog of a subscribe (oldest first). Replaces everything, then adds the held pushes. */
  sync(backlog: readonly NotificationEntry[]): void {
    const held = this.pending ?? [];
    this.pending = undefined;
    this.list = [];
    for (const e of [...backlog].sort((a, b) => a.seq - b.seq)) this.insert(e);
    for (const e of held) this.insert(e);
  }

  /** A live push. Returns true when it is new to the list right now. */
  add(entry: NotificationEntry): boolean {
    if (this.pending) {
      this.pending.push(entry);
      return false;
    }
    return this.insert(entry);
  }

  private insert(e: NotificationEntry): boolean {
    const last = this.list.at(-1);
    if (last && e.seq <= last.seq) return false; // a duplicate
    this.list.push(e);
    if (this.list.length > MAX_ENTRIES) this.list.splice(0, this.list.length - MAX_ENTRIES);
    return true;
  }
}

/**
 * How many entries are newer than `seenTs`, the time of the newest entry the panel has shown
 * (ISO 8601, "" when it never has). Times, not seq: seq starts over when the core restarts.
 */
export function unreadCount(entries: readonly NotificationEntry[], seenTs: string): number {
  if (!seenTs) return entries.length;
  const seen = Date.parse(seenTs);
  if (Number.isNaN(seen)) return entries.length;
  let n = 0;
  for (const e of entries) if (Date.parse(e.ts) > seen) n++;
  return n;
}

/** The time of the newest entry, or `fallback` when there is none. */
export function newestTs(entries: readonly NotificationEntry[], fallback = ""): string {
  return entries.at(-1)?.ts ?? fallback;
}

/** The bell's badge: "" for none, the count, "99+" above 99. */
export function badgeText(count: number): string {
  if (count <= 0) return "";
  return count > 99 ? "99+" : String(count);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n: number) => String(n).padStart(2, "0");

/** "14:32" for today, "9 Nov 14:32" for another day (local time, 24 h). */
export function entryTime(ts: string, now: Date = new Date()): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const time = `${two(d.getHours())}:${two(d.getMinutes())}`;
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? time : `${d.getDate()} ${MONTHS[d.getMonth()]} ${time}`;
}

/**
 * The choices of a kind's sound dropdown: "none", then the core's list. A chosen sound that is
 * no longer in the list (the file was removed) stays as a choice, so the row shows what is saved.
 */
export function soundChoices(sounds: readonly string[], current: string): string[] {
  const all = [NO_SOUND, ...sounds.filter((s) => s !== NO_SOUND)];
  if (current && !all.includes(current)) all.push(current);
  return all;
}

/**
 * Whether this page was opened on the computer motherapp runs on, judged by the address alone:
 * localhost, a *.localhost name, 127.x.x.x or [::1]. A phone on the local network is not.
 * The sound preview plays on that computer, so only a page there offers it.
 */
export function isLocalPage(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}
