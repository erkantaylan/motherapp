// Settings re-ordering (issue #20), DOM-free: keyboard moves, drag targets, the pending-order model,
// focus after a move and the aria-live text. The pointer and focus behaviour itself is checked
// in Chromium (see docs/lessons/2026-10-20-tool-order.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ReorderModel, dropIndex, keyMove, moveBy, moveItem, moveMessage, sameOrder } from "../src/reorder.ts";

const ids = ["audio", "brightness", "inbox", "tmux"];

test("moveItem moves one item, clamps the target, never mutates", () => {
  assert.deepEqual(moveItem(ids, 3, 0), ["tmux", "audio", "brightness", "inbox"]);
  assert.deepEqual(moveItem(ids, 0, 2), ["brightness", "inbox", "audio", "tmux"]);
  assert.deepEqual(moveItem(ids, 1, 99), ["audio", "inbox", "tmux", "brightness"]);
  assert.deepEqual(moveItem(ids, 2, -5), ["inbox", "audio", "brightness", "tmux"]);
  assert.deepEqual(moveItem(ids, 7, 0), ids);
  assert.deepEqual(ids, ["audio", "brightness", "inbox", "tmux"]);
});

test("moveBy: up/down by one; nothing at the ends or for an unknown id", () => {
  assert.deepEqual(moveBy(ids, "brightness", -1), { order: ["brightness", "audio", "inbox", "tmux"], index: 0 });
  assert.deepEqual(moveBy(ids, "brightness", 1), { order: ["audio", "inbox", "brightness", "tmux"], index: 2 });
  assert.equal(moveBy(ids, "audio", -1), undefined);
  assert.equal(moveBy(ids, "tmux", 1), undefined);
  assert.equal(moveBy(ids, "gone", 1), undefined);
  assert.equal(moveBy(["only"], "only", 1), undefined);
});

test("dropIndex: counts the other rows above the pointer, and is stable after the move", () => {
  const rows = [0, 40, 80, 120].map((top) => ({ top, height: 40 }));
  // dragging row 0: still over itself, then past row 1's middle (60), then past the end
  assert.equal(dropIndex(rows, 0, 20), 0);
  assert.equal(dropIndex(rows, 0, 59), 0);
  assert.equal(dropIndex(rows, 0, 61), 1);
  assert.equal(dropIndex(rows, 0, 500), 3);
  assert.equal(dropIndex(rows, 3, -10), 0);
  // after moving to index 1 the pointer (61) is over the dragged row's new place: stays 1
  assert.equal(dropIndex(rows, 1, 61), 1);
  // rows of different heights
  const mixed = [{ top: 0, height: 100 }, { top: 100, height: 20 }, { top: 120, height: 20 }];
  assert.equal(dropIndex(mixed, 2, 40), 0);
  assert.equal(dropIndex(mixed, 2, 105), 1);
  assert.equal(dropIndex(mixed, 2, 111), 2);
});

test("ReorderModel: shows the latest move until the core's order matches it", () => {
  const m = new ReorderModel();
  assert.deepEqual(m.view(ids), ids);
  const first = moveBy(m.view(ids), "tmux", -1)!.order; // audio brightness tmux inbox
  m.propose(first);
  const second = moveBy(m.view(ids), "tmux", -1)!.order; // audio tmux brightness inbox
  m.propose(second);
  // the broadcast for the first click arrives: the second click's order stays on screen
  assert.deepEqual(m.view(first), second);
  assert.equal(m.hasPending, true);
  // the first save's reply doesn't clear the newer one either
  m.settle(first);
  assert.deepEqual(m.view(first), second);
  // the core caught up
  assert.deepEqual(m.view(second), second);
  assert.equal(m.hasPending, false);
});

test("ReorderModel: a failed or cancelled move goes back to the core's order", () => {
  const m = new ReorderModel();
  const order = moveItem(ids, 0, 3);
  m.propose(order);
  assert.deepEqual(m.view(ids), order);
  m.settle(order); // the save failed
  assert.deepEqual(m.view(ids), ids);
  m.propose(moveItem(ids, 1, 2));
  m.clear(); // Escape during a drag
  assert.deepEqual(m.view(ids), ids);
});

test("ReorderModel: tools that appear or vanish while a move is pending", () => {
  const m = new ReorderModel();
  m.propose(["tmux", "inbox", "brightness", "audio"]);
  // audio's folder was deleted, shortcuts installed: shown at the end
  assert.deepEqual(m.view(["brightness", "inbox", "shortcuts", "tmux"]), ["tmux", "inbox", "brightness", "shortcuts"]);
});

test("keyMove: arrows move by one, Home/End to the ends, other keys and the ends do nothing", () => {
  assert.deepEqual(keyMove(ids, "inbox", "ArrowUp"), { order: ["audio", "inbox", "brightness", "tmux"], index: 1 });
  assert.deepEqual(keyMove(ids, "inbox", "ArrowDown"), { order: ["audio", "brightness", "tmux", "inbox"], index: 3 });
  assert.deepEqual(keyMove(ids, "inbox", "Home"), { order: ["inbox", "audio", "brightness", "tmux"], index: 0 });
  assert.deepEqual(keyMove(ids, "brightness", "End"), { order: ["audio", "inbox", "tmux", "brightness"], index: 3 });
  assert.equal(keyMove(ids, "audio", "ArrowUp"), undefined);
  assert.equal(keyMove(ids, "audio", "Home"), undefined);
  assert.equal(keyMove(ids, "tmux", "ArrowDown"), undefined);
  assert.equal(keyMove(ids, "tmux", "End"), undefined);
  assert.equal(keyMove(ids, "inbox", "Enter"), undefined);
  assert.equal(keyMove(ids, "gone", "ArrowUp"), undefined);
});

test("the aria-live message names the tool and its 1-based position", () => {
  assert.equal(moveMessage("Brightness", 0, 6), "Brightness moved to position 1 of 6");
  assert.equal(sameOrder(["a", "b"], ["a", "b"]), true);
  assert.equal(sameOrder(["a", "b"], ["b", "a"]), false);
  assert.equal(sameOrder(["a"], ["a", "b"]), false);
});
