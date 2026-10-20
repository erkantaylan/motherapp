// The tab's watch state: a tool page that is visible watches that tool; anything else watches
// nothing. Only changes are sent, and a reconnect tells the core again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WatchTracker } from "../src/watch.ts";

function tracker(visibility = "visible") {
  const sent: (string | null)[] = [];
  const w = new WatchTracker((t) => sent.push(t), visibility);
  return { w, sent };
}

test("route and visibility decide what the tab watches; only changes are sent", () => {
  const { w, sent } = tracker();
  w.setRoute("tmux");
  w.setRoute("tmux"); // the same page again
  assert.deepEqual(sent, ["tmux"]);
  w.setVisibility("hidden"); // tab switched away / window minimized
  w.setVisibility("hidden");
  assert.deepEqual(sent, ["tmux", null]);
  w.setRoute("audio"); // navigating while hidden sends nothing
  assert.deepEqual(sent, ["tmux", null]);
  w.setVisibility("visible");
  assert.deepEqual(sent, ["tmux", null, "audio"]);
  w.setRoute(null); // Logs or Settings
  assert.equal(w.current, null);
  w.setRoute("audio");
  w.hide(); // pagehide (unload, back/forward cache)
  w.setVisibility("visible"); // pageshow from the back/forward cache
  assert.deepEqual(sent, ["tmux", null, "audio", null, "audio", null, "audio"]);
});

test("a tab that loads hidden watches nothing until it is shown", () => {
  const { w, sent } = tracker("hidden");
  w.setRoute("brightness");
  assert.deepEqual(sent, []);
  w.setVisibility("visible");
  assert.deepEqual(sent, ["brightness"]);
});

test("after a reconnect the core is told again (a new socket starts with nothing watched)", () => {
  const { w, sent } = tracker();
  w.connected(); // first connect, nothing to say yet
  assert.deepEqual(sent, []);
  w.setRoute("shortcuts");
  w.connected();
  assert.deepEqual(sent, ["shortcuts", "shortcuts"]);
  w.setVisibility("hidden");
  w.connected(); // hidden: a new socket watches nothing already, nothing to send
  assert.deepEqual(sent, ["shortcuts", "shortcuts", null]);
});
