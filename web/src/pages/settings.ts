// Built-in settings page: enable/disable tools, restart them, set their sidebar order (#20);
// notifications (mute, per tool, per kind, sounds); the network switches; which version is running.
import { NO_SOUND } from "@motherapp/protocol";
import type { NetworkInfo, NotificationKindSettings, NotificationSettings, NotificationToolSettings, ToolInfo, UpdateStatus, VersionInfo } from "@motherapp/protocol";
import type { App } from "../app.ts";
import { KeyedList } from "../keyedList.ts";
import { confirmDialog, h, statusDot } from "../renderer.ts";
import { LAN_NOTE, networkView } from "../networkView.ts";
import { isLocalPage, soundChoices } from "../notifications.ts";
import { trayText } from "../trayText.ts";
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

/** A switch inside the shared `.control` markup (see the tool rows). */
function switchControl(label: string, aria: string): { el: HTMLElement; input: HTMLInputElement } {
  const input = h("input");
  input.type = "checkbox";
  input.setAttribute("role", "switch");
  input.setAttribute("switch", "");
  input.setAttribute("aria-label", aria);
  const el = h("label", { class: "control" }, h("span", { class: "control-label", text: label }), h("div", { class: "switch" }, input));
  return { el, input };
}

/**
 * The "Network" section: the Local network switch (opens only on trusted networks), the current
 * network with "Trust this network", the trusted list, and the *.localhost toggle. Changes are
 * refused by the core unless this tab is on this computer under a localhost name.
 */
function networkSection(app: App): { el: HTMLElement; off: () => void } {
  const row = (title: string, sub: HTMLElement, ...controls: Node[]) =>
    h("div", { class: "list-group-item list-row" }, h("div", { class: "row-labels" }, h("div", { class: "row-title", text: title }), sub), h("div", { class: "row-controls" }, ...controls));
  const lockedNote = h("p", { class: "w-text muted" });

  const lan = switchControl("On", "Local network");
  const lanDot = statusDot();
  const lanSub = h("div", { class: "row-sub update-text" });
  const addresses = h("div", { class: "row-sub" });

  const currentSub = h("div", { class: "row-sub" });
  const trust = switchControl("Trusted", "Trust this network");
  const trustDot = statusDot();
  const again = h("button", { class: "btn-outline theme-secondary btn-sm", text: "Check again" });
  again.type = "button";

  const trustedRows = h("div", { class: "list-group list-rows" });
  const noneTrusted = h("p", { class: "w-text muted", text: "No trusted networks yet." });

  const sub = switchControl("On", "Accept *.localhost names");
  const subDot = statusDot();

  const change = (dot: ReturnType<typeof statusDot>, method: "network.setLan" | "network.trust" | "network.untrust" | "network.setLocalhostSubdomains", params: Record<string, unknown>) => {
    dot.set("setting");
    (app.conn.request(method, params as never) as Promise<NetworkInfo>).then(
      (n) => {
        dot.set("set");
        app.setNetwork(n);
      },
      (e: Error) => {
        dot.set("failed", e.message);
        show(); // put the switch back
      },
    );
  };
  lan.input.addEventListener("change", () => change(lanDot, "network.setLan", { enabled: lan.input.checked }));
  trust.input.addEventListener("change", () => {
    const uuid = app.network?.current?.uuid;
    if (trust.input.checked) change(trustDot, "network.trust", {});
    else if (uuid) change(trustDot, "network.untrust", { uuid });
  });
  sub.input.addEventListener("change", () => change(subDot, "network.setLocalhostSubdomains", { enabled: sub.input.checked }));
  again.addEventListener("click", () => {
    trustDot.set("setting");
    app.refreshNetwork(true).then(
      () => trustDot.set("set"),
      (e: Error) => trustDot.set("failed", e.message),
    );
  });

  const removeDots: ReturnType<typeof statusDot>[] = [];
  const show = () => {
    const v = networkView(app.network, app.conn.connected);
    lan.input.checked = v.lanChecked;
    lan.input.disabled = v.locked;
    lanSub.textContent = v.reason;
    lanSub.title = v.reason;
    lanSub.dataset.tone = v.tone;
    addresses.hidden = v.addresses.length === 0;
    addresses.replaceChildren(
      document.createTextNode("Reachable at "),
      ...v.addresses.flatMap((url, i) => {
        const a = h("a", { text: url.replace(/\/$/, "") });
        a.href = url;
        return i === 0 ? [a] : [document.createTextNode(", "), a];
      }),
    );
    currentSub.textContent = v.trustHint ? `${v.current} · ${v.trustHint}` : v.current;
    currentSub.title = currentSub.textContent;
    trust.input.checked = v.trustChecked;
    trust.input.disabled = v.trustDisabled;
    again.disabled = !app.conn.connected;
    sub.input.checked = v.subdomainsChecked;
    sub.input.disabled = v.locked;
    lockedNote.textContent = v.lockedHint;
    lockedNote.hidden = v.lockedHint === "";

    for (const d of removeDots.splice(0)) d.dispose();
    const trusted = app.network?.trusted ?? [];
    noneTrusted.hidden = trusted.length > 0 || !app.network;
    trustedRows.hidden = trusted.length === 0;
    trustedRows.replaceChildren(
      ...trusted.map((t) => {
        const dot = statusDot();
        removeDots.push(dot);
        const remove = h("button", { class: "btn-outline theme-danger btn-sm", text: "Remove" });
        remove.type = "button";
        remove.disabled = v.locked;
        remove.setAttribute("aria-label", `Remove ${t.name || t.uuid}`);
        remove.addEventListener("click", () => {
          void confirmDialog(`Stop trusting "${t.name || t.uuid}"? motherapp won't open to the local network there any more.`, "Remove", "danger").then((ok) => {
            if (ok) change(dot, "network.untrust", { uuid: t.uuid });
          });
        });
        const s = h("div", { class: "row-sub", text: `${t.uuid} · gateway ${t.gatewayMac}` });
        s.title = s.textContent ?? "";
        return row(t.name || "(no name)", s, remove, dot.el);
      }),
    );
  };

  const offs = [app.onNetwork(show), app.conn.onState(show), app.conn.onOpen(() => app.refreshNetwork().catch(() => {}))];
  if (app.conn.connected) app.refreshNetwork().catch(() => {});
  show();

  const el = h(
    "section",
    {},
    h("h3", { class: "w-text heading", text: "Network" }),
    h("div", { class: "list-group list-rows" }, row("Local network", h("div", {}, lanSub, addresses), lan.el, lanDot.el), row("This network", currentSub, again, trust.el, trustDot.el)),
    h("p", { class: "w-text muted", text: LAN_NOTE }),
    h("h4", { class: "w-text heading", text: "Trusted networks" }),
    trustedRows,
    noneTrusted,
    h("h4", { class: "w-text heading", text: "Local names" }),
    h(
      "div",
      { class: "list-group list-rows" },
      row("*.localhost names", h("div", { class: "row-sub", text: "Accept names like ana.localhost (portgate). Off: only localhost, 127.x.x.x and [::1]." }), sub.el, subDot.el),
    ),
    lockedNote,
  );
  return {
    el,
    off: () => {
      for (const off of offs) off();
      for (const d of [lanDot, trustDot, subDot, ...removeDots]) d.dispose();
    },
  };
}

/**
 * The "Notifications" section: Mute all, then per tool an on/off and per kind an on/off, a
 * sound and a play button. The core owns all of it (config.json `notifications`) and pushes
 * `notifications.settings` to every page after a change, so the rows are updated in place.
 * One grid with a named column per part, every row a subgrid (as the tool rows): the switches,
 * sounds and dots line up whether or not a row has a sound.
 */
function notificationsSection(app: App): { el: HTMLElement; off: () => void } {
  type Dot = ReturnType<typeof statusDot>;
  const dots = new Set<Dot>();
  const newDot = () => {
    const d = statusDot();
    dots.add(d);
    return d;
  };
  // The preview plays on the computer motherapp runs on, so only a page opened there offers it.
  const local = isLocalPage(location.hostname);

  const change = (dot: Dot, req: Promise<NotificationSettings>) => {
    dot.set("setting");
    req.then(
      (s) => {
        dot.set("set");
        app.setNotifySettings(s);
      },
      (e: Error) => {
        dot.set("failed", e.message);
        show(); // put the control back
      },
    );
  };
  const enabledSwitch = (aria: string) => {
    const sw = switchControl("On", aria);
    sw.el.classList.add("row-enabled");
    return sw;
  };

  const muteDot = newDot();
  const mute = enabledSwitch("Mute all notifications");
  mute.input.addEventListener("change", () => change(muteDot, app.conn.request("notifications.setMuted", { muted: mute.input.checked })));
  const muteRow = h(
    "div",
    { class: "list-group-item list-row" },
    h("div", { class: "row-labels" }, h("div", { class: "row-title", text: "Mute all" }), h("div", { class: "row-sub", text: "No popups and no sounds. Notifications are still listed under the bell." })),
    mute.el,
    muteDot.el,
  );

  // Mute all is the first row of the same list, so its switch shares the tools' column.
  const rowsEl = h("div", { class: "list-group list-rows notify-rows" }, muteRow);
  const none = h("p", { class: "w-text muted", text: "None of your tools sends notifications." });
  const noDelivery = h("p", { class: "banner", text: "This motherapp was started with notifications off: it shows no popups and plays no sounds. The list under the bell and these settings work as usual." });
  const remoteNote = h("p", { class: "w-text muted", text: "Popups and sounds happen on the computer motherapp runs on, so a sound can be tried only there." });
  remoteNote.hidden = local;

  interface Row {
    node: HTMLElement;
    update(s: NotificationSettings): void;
    dot: Dot;
  }
  let rows: Row[] = [];
  let builtFor = "";

  const toolRow = (id: string): Row => {
    const dot = newDot();
    const title = h("div", { class: "row-title" });
    const sub = h("div", { class: "row-sub" });
    const sw = enabledSwitch("");
    sw.input.addEventListener("change", () => change(dot, app.conn.request("notifications.setTool", { tool: id, enabled: sw.input.checked })));
    const node = h("div", { class: "list-group-item list-row notify-tool" }, h("div", { class: "row-labels" }, title, sub), sw.el, dot.el);
    node.dataset.tool = id;
    return {
      node,
      dot,
      update: (s) => {
        const t = s.tools.find((x) => x.id === id);
        if (!t) return;
        title.textContent = `${t.icon ? t.icon + " " : ""}${t.title}`;
        sub.textContent = t.enabled ? "Notifications from this tool" : "Off: nothing from this tool is shown or kept";
        sub.title = sub.textContent;
        sw.input.setAttribute("aria-label", `Notifications from ${t.title}`);
        sw.input.checked = t.enabled;
        sw.input.disabled = !app.conn.connected;
      },
    };
  };

  const kindRow = (toolId: string, kindId: string, sounds: readonly string[]): Row => {
    const dot = newDot();
    const title = h("div", { class: "row-title" });
    const sw = enabledSwitch("");
    const select = h("select", { class: "form-control form-control-sm row-sound" });
    const play = h("button", { class: "btn-outline theme-secondary btn-sm row-play" });
    play.type = "button";
    // Drawn, not the ▶ character: that one comes out as a colour emoji in some fonts.
    play.innerHTML = `<svg viewBox="0 0 12 12" width="11" height="11" fill="currentColor" aria-hidden="true"><path d="M2.5 1.2v9.6L10.5 6z"/></svg>`;
    play.hidden = !local;
    let shownFor = "";
    const setKind = (c: { enabled?: boolean; sound?: string }) => change(dot, app.conn.request("notifications.setKind", { tool: toolId, kind: kindId, ...c }));
    sw.input.addEventListener("change", () => setKind({ enabled: sw.input.checked }));
    select.addEventListener("change", () => setKind({ sound: select.value }));
    play.addEventListener("click", () => {
      dot.set("setting");
      app.conn.request("notifications.previewSound", { sound: select.value }).then(
        () => dot.set("set"),
        (e: Error) => dot.set("failed", e.message),
      );
    });
    const node = h("div", { class: "list-group-item list-row notify-kind" }, h("div", { class: "row-labels" }, title), sw.el, select, play, dot.el);
    node.dataset.tool = toolId;
    node.dataset.kind = kindId;
    return {
      node,
      dot,
      update: (s) => {
        const t: NotificationToolSettings | undefined = s.tools.find((x) => x.id === toolId);
        const k: NotificationKindSettings | undefined = t?.kinds.find((x) => x.id === kindId);
        if (!t || !k) return;
        title.textContent = k.label;
        node.classList.toggle("is-off", !t.enabled);
        sw.input.setAttribute("aria-label", `${t.title}: ${k.label}`);
        sw.input.checked = k.enabled;
        sw.input.disabled = !app.conn.connected;
        const choices = soundChoices(sounds, k.sound);
        const key = `${choices.join("\0")}\0\0${k.defaultSound}`;
        if (key !== shownFor) {
          shownFor = key;
          select.replaceChildren(
            ...choices.map((c) => {
              const o = h("option", { text: c === NO_SOUND ? "No sound" : c === k.defaultSound ? `${c} (default)` : c });
              o.value = c;
              return o;
            }),
          );
        }
        select.value = k.sound;
        select.disabled = !app.conn.connected;
        select.setAttribute("aria-label", `Sound for ${t.title}: ${k.label}`);
        // A core that plays no sounds (`delivery` false) would answer the preview and stay silent.
        play.disabled = k.sound === NO_SOUND || !s.delivery || !app.conn.connected;
        play.title = k.sound === NO_SOUND ? "No sound to play" : s.delivery ? "Play this sound on this computer" : "This motherapp plays no sounds";
        play.setAttribute("aria-label", `Play the sound for ${t.title}: ${k.label}`);
      },
    };
  };

  function show(): void {
    const s = app.notifySettings;
    mute.input.checked = s?.muted === true;
    mute.input.disabled = !s || !app.conn.connected;
    noDelivery.hidden = !s || s.delivery;
    none.hidden = !s || s.tools.length > 0;
    if (!s) return;
    // Rows are rebuilt only when the tools, kinds or sounds changed, so a push that follows
    // the user's own change leaves the focus where it is.
    const shape = JSON.stringify([s.tools.map((t) => [t.id, t.kinds.map((k) => k.id)]), s.sounds]);
    if (shape !== builtFor) {
      builtFor = shape;
      for (const r of rows) {
        r.dot.dispose();
        dots.delete(r.dot);
      }
      rows = s.tools.flatMap((t) => [toolRow(t.id), ...t.kinds.map((k) => kindRow(t.id, k.id, s.sounds))]);
      rowsEl.replaceChildren(muteRow, ...rows.map((r) => r.node));
    }
    for (const r of rows) r.update(s);
  }

  const offs = [app.onNotifySettings(show), app.conn.onState(show)];
  show();
  const el = h(
    "section",
    { class: "notify-settings" },
    h("h3", { class: "w-text heading", text: "Notifications" }),
    noDelivery,
    rowsEl,
    none,
    remoteNote,
  );
  return {
    el,
    off: () => {
      for (const off of offs) off();
      for (const d of dots) d.dispose();
    },
  };
}

/** The "Desktop" section: the tray icon's switch and what became of it. */
function desktopSection(app: App): { el: HTMLElement; off: () => void } {
  const sub = h("div", { class: "row-sub update-text" });
  const sw = switchControl("On", "Show tray icon");
  const dot = statusDot();
  const show = () => {
    const t = app.tray;
    sub.textContent = trayText(t);
    sub.dataset.tone = t?.available && t.state === "failed" ? "error" : "";
    sw.input.checked = t?.enabled === true;
    sw.input.disabled = !t || !app.conn.connected;
  };
  sw.input.addEventListener("change", () => {
    dot.set("setting");
    app.conn.request("tray.setEnabled", { enabled: sw.input.checked }).then(
      (t) => {
        dot.set("set");
        app.setTray(t);
      },
      (e: Error) => {
        dot.set("failed", e.message);
        show(); // put the switch back
      },
    );
  });
  const get = () =>
    void app.conn.request("tray.get", {}).then(
      (t) => app.setTray(t),
      () => {},
    );
  const offs = [app.onTray(show), app.conn.onState(show), app.conn.onOpen(get)];
  show();
  const el = h(
    "section",
    { class: "desktop-settings" },
    h("h3", { class: "w-text heading", text: "Desktop" }),
    h("div", { class: "list-group list-rows" }, h("div", { class: "list-group-item list-row" }, h("div", { class: "row-labels" }, h("div", { class: "row-title", text: "Show tray icon" }), sub), h("div", { class: "row-controls" }, sw.el, dot.el))),
  );
  return {
    el,
    off: () => {
      for (const off of offs) off();
      dot.dispose();
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
  const network = networkSection(app);
  const notifications = notificationsSection(app);
  const desktop = desktopSection(app);
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
    notifications.el,
    desktop.el,
    network.el,
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
    network.off();
    notifications.off();
    desktop.off();
    root.replaceChildren();
  };
}
