// The client's notification history (what the bell panel lists), the unread count, the time
// text, and the Settings helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { NotificationEntry } from "@motherapp/protocol";
import { trayText } from "../src/trayText.ts";
import { MAX_ENTRIES, NotificationFeed, badgeText, entryTime, isLocalPage, newestTs, soundChoices, unreadCount } from "../src/notifications.ts";

const at = (seq: number, ts: string, title = `n${seq}`): NotificationEntry => ({ seq, ts, tool: "tmux", toolTitle: "tmux", toolIcon: "🖥️", kind: "finished", title });
const seqs = (f: NotificationFeed) => f.entries.map((e) => e.seq);

test("feed: a backlog, then live pushes, oldest first; a repeated seq is dropped", () => {
  const f = new NotificationFeed();
  f.beginSync();
  f.sync([at(1, "2026-11-10T10:00:00.000Z"), at(2, "2026-11-10T10:01:00.000Z")]);
  assert.equal(f.add(at(3, "2026-11-10T10:02:00.000Z")), true);
  assert.equal(f.add(at(3, "2026-11-10T10:02:00.000Z")), false, "the same push twice");
  assert.equal(f.add(at(2, "2026-11-10T10:01:00.000Z")), false, "one the backlog already had");
  assert.deepEqual(seqs(f), [1, 2, 3]);
});

test("feed: a reconnect replaces the list with the new backlog, so nothing shows twice", () => {
  const f = new NotificationFeed();
  f.beginSync();
  f.sync([at(1, "2026-11-10T10:00:00.000Z"), at(2, "2026-11-10T10:01:00.000Z")]);
  f.add(at(3, "2026-11-10T10:02:00.000Z"));
  // Disconnected; 4 was sent meanwhile. The same core answers the new subscribe.
  f.beginSync();
  f.sync([at(1, "2026-11-10T10:00:00.000Z"), at(2, "2026-11-10T10:01:00.000Z"), at(3, "2026-11-10T10:02:00.000Z"), at(4, "2026-11-10T10:03:00.000Z")]);
  assert.deepEqual(seqs(f), [1, 2, 3, 4]);
});

test("feed: a push that arrives before the subscribe's answer is held, then merged once", () => {
  const f = new NotificationFeed();
  f.beginSync();
  assert.equal(f.add(at(5, "2026-11-10T10:05:00.000Z")), false, "held, not listed yet");
  assert.equal(f.add(at(6, "2026-11-10T10:06:00.000Z")), false);
  assert.deepEqual(seqs(f), []);
  f.sync([at(4, "2026-11-10T10:04:00.000Z"), at(5, "2026-11-10T10:05:00.000Z")]); // the backlog has 5 too
  assert.deepEqual(seqs(f), [4, 5, 6]);
});

test("feed: a restarted core starts over at seq 1 with an empty history", () => {
  const f = new NotificationFeed();
  f.beginSync();
  f.sync([at(7, "2026-11-10T10:00:00.000Z"), at(8, "2026-11-10T10:01:00.000Z")]);
  f.beginSync();
  f.sync([]); // the new core remembers nothing
  assert.deepEqual(seqs(f), []);
  assert.equal(f.add(at(1, "2026-11-10T11:00:00.000Z", "after the restart")), true, "seq 1 is new, not a duplicate of the old run");
  assert.deepEqual(f.entries.map((e) => e.title), ["after the restart"]);
});

test("feed: keeps the newest 200", () => {
  const f = new NotificationFeed();
  f.beginSync();
  f.sync([]);
  for (let i = 1; i <= MAX_ENTRIES + 5; i++) f.add(at(i, new Date(Date.UTC(2026, 10, 10, 10, 0, i)).toISOString()));
  assert.equal(f.entries.length, MAX_ENTRIES);
  assert.equal(f.entries[0]!.seq, 6);
  assert.equal(f.entries.at(-1)!.seq, MAX_ENTRIES + 5);
});

test("unread: entries newer than the newest one the panel has shown; by time, not seq", () => {
  const entries = [at(1, "2026-11-10T10:00:00.000Z"), at(2, "2026-11-10T10:01:00.000Z"), at(3, "2026-11-10T10:02:00.000Z")];
  assert.equal(unreadCount(entries, ""), 3, "the panel was never open in this browser");
  assert.equal(unreadCount(entries, "2026-11-10T10:00:00.000Z"), 2);
  assert.equal(unreadCount(entries, "2026-11-10T10:02:00.000Z"), 0);
  assert.equal(unreadCount(entries, "not a date"), 3);
  // After a core restart seq starts over, below what was seen before; the time still tells.
  assert.equal(unreadCount([at(1, "2026-11-10T12:00:00.000Z")], "2026-11-10T10:02:00.000Z"), 1);
  assert.equal(newestTs(entries), "2026-11-10T10:02:00.000Z");
  assert.equal(newestTs([], "2026-11-10T09:00:00.000Z"), "2026-11-10T09:00:00.000Z", "an empty history keeps what was seen");
});

test("badge text: nothing for zero, the count, 99+ above", () => {
  assert.equal(badgeText(0), "");
  assert.equal(badgeText(1), "1");
  assert.equal(badgeText(99), "99");
  assert.equal(badgeText(100), "99+");
});

test("entry time: the clock time today, with the day for another day", () => {
  const now = new Date(2026, 10, 10, 18, 0, 0);
  assert.equal(entryTime(new Date(2026, 10, 10, 14, 32, 5).toISOString(), now), "14:32");
  assert.equal(entryTime(new Date(2026, 10, 10, 9, 5, 0).toISOString(), now), "09:05");
  assert.equal(entryTime(new Date(2026, 10, 9, 23, 59, 0).toISOString(), now), "9 Nov 23:59");
  assert.equal(entryTime(new Date(2025, 10, 10, 14, 32, 0).toISOString(), now), "10 Nov 14:32", "the same date a year ago is another day");
  assert.equal(entryTime("nonsense", now), "");
});

test("sound choices: none first, then the core's list; a saved sound that is gone stays listed", () => {
  assert.deepEqual(soundChoices(["bell", "message"], "bell"), ["none", "bell", "message"]);
  assert.deepEqual(soundChoices(["bell", "message"], "none"), ["none", "bell", "message"]);
  assert.deepEqual(soundChoices(["bell"], "removed-sound"), ["none", "bell", "removed-sound"]);
  assert.deepEqual(soundChoices([], "none"), ["none"]);
});

test("local page: only an address of this computer offers the sound preview", () => {
  for (const h of ["localhost", "LOCALHOST", "ana.localhost", "127.0.0.1", "127.1.2.3", "[::1]", "::1"]) assert.equal(isLocalPage(h), true, h);
  for (const h of ["192.168.1.20", "desktop.local", "example.com", "localhost.example.com", "1127.0.0.1", ""]) assert.equal(isLocalPage(h), false, h);
});

test("tray row text: never shown here, failed with the reason, running, off", () => {
  assert.equal(trayText(undefined), "…");
  assert.match(trayText({ enabled: true, available: false, state: "off" }), /never shows one/);
  assert.equal(trayText({ enabled: true, available: true, state: "failed", message: "no tray on this desktop" }), "Couldn't show it: no tray on this desktop");
  assert.equal(trayText({ enabled: true, available: true, state: "starting" }), "Starting…");
  assert.match(trayText({ enabled: true, available: true, state: "running" }), /^An icon in the tray/);
  assert.equal(trayText({ enabled: false, available: true, state: "off" }), "No icon in the tray");
});
