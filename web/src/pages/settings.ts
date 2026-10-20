// Built-in settings page: enable/disable tools, restart them, set their sidebar order (#20);
// which version is running.
import type { ToolInfo, VersionInfo } from "@motherapp/protocol";
import type { App } from "../app.ts";
import { KeyedList } from "../keyedList.ts";
import { confirmDialog, h, statusDot } from "../renderer.ts";
import { ReorderModel, dropIndex, focusTarget, moveBy, moveMessage, moveItem, sameOrder } from "../reorder.ts";

const when = (iso: string | null | undefined): string => (iso ? new Date(iso).toLocaleString() : "unknown");

/** The "Version" section: running build, checkout, and the "run `motherapp install`" banner. */
function versionSection(app: App): { el: HTMLElement; off: () => void } {
  const banner = h("div", { class: "banner" });
  banner.hidden = true;
  const runningSub = h("div", { class: "row-sub" });
  const checkoutSub = h("div", { class: "row-sub" });
  const dot = statusDot();
  const again = h("button", { class: "btn-outline theme-secondary btn-sm", text: "Check again" });
  again.type = "button";
  again.addEventListener("click", () => {
    dot.set("setting");
    app.refreshVersion(true).then(
      () => dot.set("set"),
      (e: Error) => dot.set("failed", e.message),
    );
  });
  const row = (title: string, sub: HTMLElement, ...controls: Node[]) =>
    h("div", { class: "list-group-item list-row" }, h("div", { class: "row-labels" }, h("div", { class: "row-title", text: title }), sub), h("div", { class: "row-controls" }, ...controls));
  const show = (v: VersionInfo | undefined) => {
    if (!v) {
      runningSub.textContent = "…";
      checkoutSub.textContent = "…";
      return;
    }
    const r = v.running;
    runningSub.textContent = r.error ? `${r.string} · ${r.error}` : `${r.string} · built ${when(r.builtAt)}`;
    const c = v.checkout;
    checkoutSub.textContent = c.string ? `${c.string} · checked ${when(c.checkedAt)}` : `unknown · ${c.error ?? "git gave no answer"}`;
    banner.hidden = v.status !== "behind";
    banner.textContent = v.message ?? "";
  };
  show(app.version);
  const off = app.onVersion(() => show(app.version));
  const el = h(
    "section",
    {},
    h("h3", { class: "w-text heading", text: "Version" }),
    banner,
    h("div", { class: "list-group list-rows" }, row("Running", runningSub), row("Checkout", checkoutSub, again, dot.el)),
    h("p", { class: "w-text muted", text: "Update with `motherapp install` in a terminal: it pulls main, rebuilds and restarts the service." }),
  );
  return { el, off };
}

interface RowRefs {
  node: HTMLElement;
  up: HTMLButtonElement;
  down: HTMLButtonElement;
  title(): string;
}

export function mountSettings(app: App, root: HTMLElement): () => void {
  const rowsEl = h("div", { class: "list-group list-rows tool-order" });
  const version = versionSection(app);
  // Moves are announced here ("Brightness moved to position 1 of 6").
  const live = h("div", { class: "visually-hidden" });
  live.setAttribute("role", "status");
  live.setAttribute("aria-live", "polite");
  let liveTimer: ReturnType<typeof setTimeout> | undefined;
  const announce = (msg: string) => {
    // Cleared first, so the same text twice in a row is read twice.
    live.textContent = "";
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => (live.textContent = msg), 50);
  };
  const orderDot = statusDot();
  const reset = h("button", { class: "btn-outline theme-secondary btn-sm", text: "Reset to default order" });
  reset.type = "button";
  root.append(
    h("header", { class: "page-header" }, h("h2", { text: "Settings" })),
    h("h3", { class: "w-text heading", text: "Tools" }),
    h(
      "div",
      { class: "order-bar" },
      h("p", { class: "w-text muted", text: "Drag ⠿ or use the arrows to set the sidebar order. Logs and Settings stay at the bottom." }),
      h("div", { class: "row-controls" }, reset, orderDot.el),
    ),
    rowsEl,
    live,
    h("p", { class: "w-text muted", text: "Changes are saved to ~/.config/motherapp/config.json." }),
    version.el,
  );
  // The core caches the checkout for a minute, so opening the page doesn't run git each time;
  // "Check again" forces a fresh look.
  app.refreshVersion().catch(() => {});

  // ---- order (issue #20) ----
  // The rows show the core's order, or the user's latest move until the core confirms it. The
  // core then sends `tools` to every open tab, which is what re-orders the sidebars.
  const model = new ReorderModel();
  const refs = new Map<string, RowRefs>();
  const serverIds = () => app.tools.map((t) => t.id);

  const save = (order: string[]) => {
    orderDot.set("setting");
    app.conn.request("tools.setOrder", { order }).then(
      () => {
        orderDot.set("set");
        model.settle(order);
        sync();
      },
      (e: Error) => {
        orderDot.set("failed", e.message);
        model.settle(order);
        sync();
        announce(`Order not saved: ${e.message}`);
      },
    );
  };

  const moveRow = (id: string, pressed: "up" | "down") => {
    const r = moveBy(model.view(serverIds()), id, pressed === "up" ? -1 : 1);
    if (!r) return;
    model.propose(r.order);
    sync();
    // Moving a row re-inserts its node, which can drop the focus; put it back on the row's button.
    const row = refs.get(id);
    if (row) row[focusTarget(pressed, r.index, r.order.length)].focus();
    announce(moveMessage(row?.title() ?? id, r.index, r.order.length));
    save(r.order);
  };

  reset.addEventListener("click", () => {
    void confirmDialog("Put the tools back in the default order? Your own order is forgotten.", "Reset", "default").then((ok) => {
      if (!ok) return;
      orderDot.set("setting");
      model.clear();
      app.conn.request("tools.resetOrder", {}).then(
        () => {
          orderDot.set("set");
          announce("Tools are back in the default order");
        },
        (e: Error) => orderDot.set("failed", e.message),
      );
    });
  });

  // Dragging: Pointer Events, so mouse, touch and pen share one path. The pointer is captured by
  // the list itself, not the handle, because the dragged row's node is moved around while the
  // drag runs (and a moved node loses its capture). Keyboard users have the arrow buttons; the
  // handle isn't focusable and does nothing for them.
  let drag: { id: string; pointerId: number; start: string[] } | undefined;
  const shownOrder = () => list.keys();
  const endDrag = (commit: boolean) => {
    if (!drag) return;
    const { id, start, pointerId } = drag;
    drag = undefined;
    refs.get(id)?.node.classList.remove("dragging");
    rowsEl.classList.remove("is-dragging");
    if (rowsEl.hasPointerCapture(pointerId)) rowsEl.releasePointerCapture(pointerId);
    window.removeEventListener("keydown", onDragKey, true);
    const order = shownOrder();
    if (commit && !sameOrder(order, start)) {
      model.propose(order);
      const index = order.indexOf(id);
      announce(moveMessage(refs.get(id)?.title() ?? id, index, order.length));
      save(order);
    } else {
      model.clear();
      sync();
    }
  };
  const onDragKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && drag) {
      e.preventDefault();
      e.stopPropagation();
      endDrag(false);
    }
  };
  const startDrag = (id: string, e: PointerEvent) => {
    if (drag || (e.pointerType === "mouse" && e.button !== 0)) return;
    e.preventDefault(); // no text selection, no native drag
    drag = { id, pointerId: e.pointerId, start: shownOrder() };
    rowsEl.setPointerCapture(e.pointerId);
    rowsEl.classList.add("is-dragging");
    refs.get(id)?.node.classList.add("dragging");
    window.addEventListener("keydown", onDragKey, true);
  };
  rowsEl.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const ids = shownOrder();
    const from = ids.indexOf(drag.id);
    if (from < 0) return endDrag(false);
    const boxes = ids.map((k) => {
      const r = refs.get(k)!.node.getBoundingClientRect();
      return { top: r.top, height: r.height };
    });
    const to = dropIndex(boxes, from, e.clientY);
    if (to !== from) {
      model.propose(moveItem(ids, from, to));
      sync();
    }
  });
  rowsEl.addEventListener("pointerup", (e) => {
    if (drag && e.pointerId === drag.pointerId) endDrag(true);
  });
  rowsEl.addEventListener("pointercancel", (e) => {
    if (drag && e.pointerId === drag.pointerId) endDrag(false);
  });
  rowsEl.addEventListener("lostpointercapture", (e) => {
    if (drag && e.pointerId === drag.pointerId) endDrag(false);
  });

  const list = new KeyedList<ToolInfo, HTMLElement>(
    {
      insertBefore: (n, r) => rowsEl.insertBefore(n, r),
      remove: (n) => n.remove(),
      nextSibling: (n) => n.nextElementSibling as HTMLElement | null,
    },
    (_key, first) => {
      let info = first;
      const title = h("div", { class: "row-title" });
      const sub = h("div", { class: "row-sub" });
      const dot = statusDot();
      const enabled = h("input");
      enabled.type = "checkbox";
      enabled.setAttribute("role", "switch");
      enabled.setAttribute("switch", "");
      enabled.setAttribute("aria-label", `Enabled: ${first.title}`);
      enabled.addEventListener("change", () => {
        dot.set("setting");
        app.conn
          .request("tool.setEnabled", { tool: info.id, enabled: enabled.checked })
          .then(() => dot.set("set"))
          .catch((e: Error) => {
            dot.set("failed", e.message);
            enabled.checked = info.enabled;
          });
      });
      const restart = h("button", { class: "btn-outline theme-secondary btn-sm", text: "Restart" });
      restart.type = "button";
      restart.addEventListener("click", () => {
        app.conn.request("tool.restart", { tool: info.id }).catch((e: Error) => dot.set("failed", e.message));
      });
      // Drag handle: pointer only. Hidden from assistive tech and out of the tab order; the
      // arrow buttons below are the keyboard path.
      const handle = h("span", { class: "drag-handle", text: "⠿", title: "Drag to reorder" });
      handle.setAttribute("aria-hidden", "true");
      handle.addEventListener("pointerdown", (e) => startDrag(info.id, e));
      const arrow = (dir: "up" | "down") => {
        const b = h("button", { class: "btn-outline theme-secondary btn-sm btn-icon", text: dir === "up" ? "↑" : "↓" });
        b.type = "button";
        b.addEventListener("click", () => moveRow(info.id, dir));
        return b;
      };
      const up = arrow("up");
      const down = arrow("down");
      const node = h(
        "div",
        { class: "list-group-item list-row" },
        handle,
        h("div", { class: "row-labels" }, title, sub),
        h(
          "div",
          { class: "row-controls" },
          h("div", { class: "btn-group order-buttons" }, up, down),
          h("label", { class: "control" }, h("span", { class: "control-label", text: "Enabled" }), h("div", { class: "switch" }, enabled)),
          restart,
          dot.el,
        ),
      );
      node.dataset.tool = first.id;
      refs.set(first.id, { node, up, down, title: () => info.title });
      const update = (next: ToolInfo) => {
        info = next;
        up.setAttribute("aria-label", `Move ${next.title} up`);
        down.setAttribute("aria-label", `Move ${next.title} down`);
        title.textContent = `${next.icon ? next.icon + " " : ""}${next.title}`;
        sub.textContent = `${next.id} · ${next.status}${next.statusText ? ` · ${next.statusText}` : ""}`;
        sub.title = sub.textContent; // .row-sub is one line, cut with an ellipsis
        enabled.checked = next.enabled;
        restart.hidden = !next.enabled;
      };
      update(first);
      return {
        node,
        update,
        destroy: () => {
          refs.delete(first.id);
          dot.dispose();
        },
      };
    },
  );
  function sync(): void {
    const byId = new Map(app.tools.map((t) => [t.id, t] as const));
    const ids = model.view(serverIds());
    // Re-inserting a row can drop the focus (e.g. another tab moved the row this tab is on).
    const active = document.activeElement instanceof HTMLElement && rowsEl.contains(document.activeElement) ? document.activeElement : undefined;
    list.update(ids.map((id) => [id, byId.get(id)!] as const));
    ids.forEach((id, i) => {
      const r = refs.get(id);
      if (!r) return;
      r.up.disabled = i === 0;
      r.down.disabled = i === ids.length - 1;
    });
    if (active && active.isConnected && document.activeElement !== active) {
      const row = [...refs.values()].find((r) => r.node.contains(active));
      const target = active instanceof HTMLButtonElement && active.disabled && row ? (active === row.up ? row.down : row.up) : active;
      target.focus();
    }
    reset.disabled = !app.orderSaved && !model.hasPending;
  }
  sync();
  const off = app.onTools(sync);
  return () => {
    off();
    endDrag(false);
    clearTimeout(liveTimer);
    orderDot.dispose();
    version.off();
    root.replaceChildren();
  };
}
