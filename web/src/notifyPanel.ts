// The bell on the tool strip and its panel: the notification history, newest on top, with a
// count on the bell of what arrived since the panel was last open.
import type { NotificationEntry } from "@motherapp/protocol";
import type { App } from "./app.ts";
import { badgeText, entryTime, newestTs, unreadCount } from "./notifications.ts";
import { h } from "./renderer.ts";
import type { ToolStrip } from "./toolStrip.ts";

const PANEL_ID = "notifications";
/** localStorage: the time (ISO 8601) of the newest entry the panel has shown in this browser. */
const SEEN_KEY = "motherapp.notifications.seen";

const BELL = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9"/><path d="M10 20a2.2 2.2 0 0 0 4 0"/></svg>`;

function loadSeen(): string {
  try {
    return localStorage.getItem(SEEN_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveSeen(ts: string): void {
  try {
    localStorage.setItem(SEEN_KEY, ts);
  } catch {
    // not remembered: after a reload the whole history counts as new
  }
}

function entryNode(e: NotificationEntry, now: Date): HTMLElement {
  const icon = h("span", { class: "note-icon", title: e.toolTitle });
  if (e.toolIconUrl) icon.append(Object.assign(document.createElement("img"), { src: e.toolIconUrl, alt: "" }));
  else icon.textContent = e.toolIcon ?? e.toolTitle.slice(0, 1);
  const time = h("time", { class: "note-time", text: entryTime(e.ts, now) });
  time.dateTime = e.ts;
  time.title = `${e.toolTitle} · ${new Date(e.ts).toLocaleString()}`;
  const head = h("div", { class: "note-head" }, h("span", { class: "note-title", text: e.title }), time);
  if (e.muted) head.append(h("span", { class: "note-muted", text: "muted", title: "Arrived while Mute all was on: no popup and no sound" }));
  const node = h("li", { class: e.muted ? "note is-muted" : "note" }, icon, h("div", { class: "note-main" }, head, e.body ? h("div", { class: "note-body", text: e.body }) : null));
  node.dataset.seq = String(e.seq);
  return node;
}

export function mountNotifications(app: App, strip: ToolStrip): void {
  const list = h("ol", { class: "note-list" });
  const empty = h("div", { class: "note-empty" }, h("p", { text: "No notifications yet." }), h("p", { class: "muted", text: "What your tools tell you shows up here. The last 200 are kept until motherapp restarts." }));
  const settingsLink = h("a", { class: "note-settings", text: "Notification settings" });
  settingsLink.href = "#/settings";
  // Where the panel lies over the page, following the link has to uncover the page.
  settingsLink.addEventListener("click", () => {
    if (!strip.docked) strip.show("");
  });
  const body = h("div", { class: "note-panel" }, list, empty, h("footer", { class: "note-foot" }, settingsLink));

  // Mute all, the same setting as on the Settings page.
  const mute = h("input");
  mute.type = "checkbox";
  mute.setAttribute("role", "switch");
  mute.setAttribute("switch", "");
  mute.setAttribute("aria-label", "Mute all notifications");
  const muteEl = h("label", { class: "control note-mute", title: "No popups and no sounds. Notifications are still listed here." }, h("span", { class: "control-label", text: "Mute all" }), h("div", { class: "switch" }, mute));
  const showMute = () => {
    mute.checked = app.notifySettings?.muted === true;
    mute.disabled = !app.notifySettings || !app.conn.connected;
  };
  mute.addEventListener("change", () => {
    app.conn.request("notifications.setMuted", { muted: mute.checked }).then(
      (s) => app.setNotifySettings(s),
      () => showMute(), // not saved: put the switch back
    );
  });

  let seen = loadSeen();
  let button: ReturnType<ToolStrip["add"]> | undefined;
  const render = () => {
    const entries = app.notifications.entries;
    const open = strip.open === PANEL_ID;
    if (open) {
      const now = new Date();
      list.replaceChildren(...[...entries].reverse().map((e) => entryNode(e, now)));
      list.hidden = entries.length === 0;
      empty.hidden = entries.length > 0;
      // Everything listed has been shown: nothing is unread.
      const newest = newestTs(entries, seen);
      if (newest !== seen) {
        seen = newest;
        saveSeen(seen);
      }
    }
    const unread = open ? 0 : unreadCount(entries, seen);
    button?.setBadge(badgeText(unread), unread > 0 ? `Notifications, ${unread} new` : "Notifications");
  };

  button = strip.add({
    id: PANEL_ID,
    title: "Notifications",
    icon: BELL,
    body,
    headerControls: [muteEl],
    onToggle: () => render(),
  });
  app.onNotifications(render);
  app.onNotifySettings(showMute);
  app.conn.onState(showMute);
  showMute();
  render();
}
