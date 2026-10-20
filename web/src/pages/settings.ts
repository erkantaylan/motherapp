// Built-in settings page: enable/disable tools, restart them, set their sidebar order (#20);
// which version is running.
import type { ToolInfo, UpdateStatus, VersionInfo } from "@motherapp/protocol";
import type { App } from "../app.ts";
import { KeyedList } from "../keyedList.ts";
import { confirmDialog, h, statusDot } from "../renderer.ts";
import { ReorderModel, dropIndex, keyMove, moveMessage, moveItem, sameOrder } from "../reorder.ts";
import { bannerText, releaseText, updateView, when } from "../versionText.ts";

/**
 * The "Version" section: running build, checkout, latest release, the banner, and "Update now"
 * (`motherapp install` outside the service, followed through the service's restart).
 */
function versionSection(app: App): { el: HTMLElement; off: () => void } {
  const banner = h("div", { class: "banner" });
  banner.hidden = true;
  const runningSub = h("div", { class: "row-sub" });
  const checkoutSub = h("div", { class: "row-sub" });
  const releaseSub = h("div", { class: "row-sub" });
  const releaseLink = h("a", { class: "btn-outline theme-secondary btn-sm", text: "Release page" });
  releaseLink.target = "_blank";
  releaseLink.rel = "noopener noreferrer";
  releaseLink.hidden = true;
  const dot = statusDot();
  const again = h("button", { class: "btn-outline theme-secondary btn-sm", text: "Check for updates" });
  again.type = "button";
  again.addEventListener("click", () => {
    dot.set("setting");
    app.refreshVersion(true, true).then(
      (v) => (v.release?.error ? dot.set("failed", `couldn't check: ${v.release.error}`) : dot.set("set")),
      (e: Error) => dot.set("failed", e.message),
    );
  });
  const updateSub = h("div", { class: "row-sub update-text" });
  const updateDot = statusDot();
  const updateBtn = h("button", { class: "btn-solid theme-primary btn-sm", text: "Update now" });
  updateBtn.type = "button";
  const logPre = h("pre", { class: "update-log-text" });
  const logBox = h("details", { class: "update-log" }, h("summary", { text: "Update log" }), logPre);
  logBox.hidden = true;

  const row = (title: string, sub: HTMLElement, ...controls: Node[]) =>
    h("div", { class: "list-group-item list-row" }, h("div", { class: "row-labels" }, h("div", { class: "row-title", text: title }), sub), h("div", { class: "row-controls" }, ...controls));
  const show = (v: VersionInfo | undefined) => {
    if (!v) {
      runningSub.textContent = "…";
      checkoutSub.textContent = "…";
      releaseSub.textContent = "…";
      return;
    }
    const r = v.running;
    runningSub.textContent = r.error ? `${r.string} · ${r.error}` : `${r.string} · built ${when(r.builtAt)}`;
    const c = v.checkout;
    checkoutSub.textContent = c.string ? `${c.string} · checked ${when(c.checkedAt)}` : `unknown · ${c.error ?? "git gave no answer"}`;
    releaseSub.textContent = releaseText(v.release);
    releaseSub.title = releaseSub.textContent;
    releaseLink.hidden = !v.release?.latestUrl;
    if (v.release?.latestUrl) releaseLink.href = v.release.latestUrl;
    const text = bannerText(v);
    banner.hidden = text === undefined;
    banner.textContent = text ?? "";
  };

  // ---- Update now ----
  let upd: UpdateStatus | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  const showUpdate = () => {
    const view = updateView(upd, app.conn.connected);
    let text = view.text;
    // The page's own code is still the old build's until a reload.
    if (upd?.state === "done" && app.loadedBuild && app.version && app.version.running.string !== app.loadedBuild) text += " · reload the page for the new UI";
    updateSub.textContent = text || "Pulls main, rebuilds and restarts the service";
    updateSub.title = updateSub.textContent;
    updateSub.dataset.tone = view.tone;
    updateBtn.disabled = view.busy || !app.conn.connected;
    updateBtn.textContent = view.busy ? "Updating…" : "Update now";
    logBox.hidden = !upd || upd.log === "";
    logPre.textContent = upd?.log ?? "";
    if (view.tone === "error") logBox.open = true;
  };
  const poll = () => {
    clearTimeout(pollTimer);
    if (!app.conn.connected) return showUpdate();
    app.conn.request("update.status", {}).then(
      (s) => {
        const was = upd?.state;
        upd = s;
        if (s.state === "running") pollTimer = setTimeout(poll, 1000);
        else if (was === "running") app.refreshVersion(true).catch(() => {});
        showUpdate();
      },
      () => showUpdate(), // disconnected mid-request: onOpen polls again
    );
  };
  updateBtn.addEventListener("click", () => {
    void confirmDialog(
      "Update motherapp now? This runs `motherapp install` outside the service: it pulls main, rebuilds and restarts the service, and this page reconnects by itself. It refuses when the checkout has local changes, isn't on main or has diverged, and it never removes packages. If something needs sudo, it stops and asks you to run `motherapp install` in a terminal.",
      "Update now",
      "primary",
    ).then((ok) => {
      if (!ok) return;
      updateDot.set("setting");
      app.conn.request("update.start", {}).then(
        (s) => {
          updateDot.set("set");
          upd = s;
          showUpdate();
          poll();
        },
        (e: Error) => {
          updateDot.set("failed", e.message);
          poll();
        },
      );
    });
  });

  show(app.version);
  showUpdate();
  const offs = [
    app.onVersion(() => {
      show(app.version);
      showUpdate();
    }),
    app.conn.onState(() => showUpdate()),
    // Also right now: what the last update did. After the service restarts, the reconnect runs it again.
    app.conn.onOpen(poll),
  ];
  const el = h(
    "section",
    {},
    h("h3", { class: "w-text heading", text: "Version" }),
    banner,
    h(
      "div",
      { class: "list-group list-rows" },
      row("Running", runningSub),
      row("Checkout", checkoutSub, again, dot.el),
      row("Latest release", releaseSub, releaseLink),
      row("Update", updateSub, updateBtn, updateDot.el),
    ),
    logBox,
    h("p", { class: "w-text muted", text: "Update now = `motherapp install` (also works in a terminal). Releases are tags v<N> on main; the update pulls main, which is at or past the latest release." }),
  );
  return {
    el,
    off: () => {
      for (const off of offs) off();
      clearTimeout(pollTimer);
      dot.dispose();
      updateDot.dispose();
    },
  };
}

interface RowRefs {
  node: HTMLElement;
  handle: HTMLButtonElement;
  title(): string;
}

export function mountSettings(app: App, root: HTMLElement): () => void {
  const rowsEl = h("div", { class: "list-group list-rows tool-order" });
  const version = versionSection(app);
  // Moves are announced here ("Brightness moved to position 1 of 6").
  const live = h("div", { class: "visually-hidden" });
  // Every drag handle points here (aria-describedby).
  const keyHint = h("div", { class: "visually-hidden", text: "Use arrow keys to move" });
  keyHint.id = "tool-order-key-hint";
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
      h("p", { class: "w-text muted", text: "Drag ⠿ to set the sidebar order (or focus it and use the arrow keys). Logs and Settings stay at the bottom." }),
      h("div", { class: "row-controls" }, reset, orderDot.el),
    ),
    rowsEl,
    live,
    keyHint,
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

  // Keyboard path: ArrowUp/ArrowDown/Home/End on a focused drag handle.
  const onHandleKey = (id: string, e: KeyboardEvent) => {
    if (drag || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
    // Also at the top or bottom, so the page doesn't scroll instead.
    e.preventDefault();
    const r = keyMove(model.view(serverIds()), id, e.key);
    if (!r) return;
    model.propose(r.order);
    sync();
    // Moving a row re-inserts its node, which can drop the focus; put it back on the handle.
    const row = refs.get(id);
    row?.handle.focus();
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
  // drag runs (and a moved node loses its capture). Keyboard users focus the same handle and use
  // the arrow keys (onHandleKey).
  let drag: { id: string; pointerId: number; start: string[] } | undefined;
  const shownOrder = () => list.keys();
  const endDrag = (commit: boolean) => {
    if (!drag) return;
    const { id, start, pointerId } = drag;
    drag = undefined;
    refs.get(id)?.node.classList.remove("dragging");
    rowsEl.classList.remove("is-dragging");
    if (rowsEl.hasPointerCapture(pointerId)) {
      try {
        rowsEl.releasePointerCapture(pointerId);
      } catch {
        // already gone
      }
    }
    dragListeners(false);
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
    // Capture keeps the moves coming when the pointer leaves the list. It throws when the
    // browser no longer counts the pointer as active (released already, or an event a script
    // made); the drag then still works while the pointer stays over the list.
    try {
      rowsEl.setPointerCapture(e.pointerId);
    } catch {
      // no capture
    }
    rowsEl.classList.add("is-dragging");
    refs.get(id)?.node.classList.add("dragging");
    dragListeners(true);
  };
  // Move, up and cancel are heard on the window while a drag runs: with the capture they reach
  // it through the list, and without one (see startDrag) a release outside the list still ends
  // the drag instead of leaving it stuck.
  const onDragMove = (e: PointerEvent) => {
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
  };
  const onDragUp = (e: PointerEvent) => {
    if (drag && e.pointerId === drag.pointerId) endDrag(true);
  };
  const onDragCancel = (e: PointerEvent) => {
    if (drag && e.pointerId === drag.pointerId) endDrag(false);
  };
  const dragListeners = (on: boolean) => {
    if (on) {
      window.addEventListener("keydown", onDragKey, true);
      window.addEventListener("pointermove", onDragMove);
      window.addEventListener("pointerup", onDragUp);
      window.addEventListener("pointercancel", onDragCancel);
    } else {
      window.removeEventListener("keydown", onDragKey, true);
      window.removeEventListener("pointermove", onDragMove);
      window.removeEventListener("pointerup", onDragUp);
      window.removeEventListener("pointercancel", onDragCancel);
    }
  };
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
      const restart = h("button", { class: "btn-outline theme-secondary btn-sm row-restart", text: "Restart" });
      restart.type = "button";
      restart.addEventListener("click", () => {
        app.conn.request("tool.restart", { tool: info.id }).catch((e: Error) => dot.set("failed", e.message));
      });
      // Drag handle: a pointer drags it; focused (it's a button), the arrow keys move the row.
      const handle = h("button", { class: "drag-handle", text: "⠿", title: "Drag to reorder" });
      handle.type = "button";
      handle.setAttribute("aria-describedby", keyHint.id);
      handle.addEventListener("pointerdown", (e) => startDrag(info.id, e));
      handle.addEventListener("keydown", (e) => onHandleKey(info.id, e));
      // Each part has its own named grid column, shared by all rows through subgrid
      // (styles.scss, .tool-order), so a row without a Restart button keeps the others' columns.
      const node = h(
        "div",
        { class: "list-group-item list-row" },
        handle,
        h("div", { class: "row-labels" }, title, sub),
        h("label", { class: "control row-enabled" }, h("span", { class: "control-label", text: "Enabled" }), h("div", { class: "switch" }, enabled)),
        restart,
        dot.el,
      );
      node.dataset.tool = first.id;
      refs.set(first.id, { node, handle, title: () => info.title });
      const update = (next: ToolInfo) => {
        info = next;
        handle.setAttribute("aria-label", `Move ${next.title}`);
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
    if (active && active.isConnected && document.activeElement !== active) active.focus();
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
