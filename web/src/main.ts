// Shell: sidebar (enabled tools with status dots, Logs, Settings) + content area.
// Routes: #/tool/<id>, #/logs, #/settings.
import "./styles.scss";
import type { ToolInfo } from "@motherapp/protocol";
import { App } from "./app.ts";
import { KeyedList } from "./keyedList.ts";
import { LogsPage } from "./pages/logs.ts";
import { mountSettings } from "./pages/settings.ts";
import { mountToolPage } from "./pages/toolPage.ts";
import { h } from "./renderer.ts";
import { WatchTracker } from "./watch.ts";

const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
const app = new App(wsUrl);

// Tells the core which tool's page this tab shows while it is visible, so tools poll only
// while someone looks (docs/extension-contract.md § 3, "poll only while watched").
const watch = new WatchTracker((tool) => {
  if (app.conn.connected) app.conn.request("tool.watch", { tool }).catch(() => {});
}, document.visibilityState);
document.addEventListener("visibilitychange", () => watch.setVisibility(document.visibilityState));
window.addEventListener("pagehide", () => watch.hide());
window.addEventListener("pageshow", () => watch.setVisibility(document.visibilityState));
app.conn.onOpen(() => watch.connected());

// ---- layout ----
const toolNav = h("nav", { class: "nav nav-tools" });
toolNav.setAttribute("aria-label", "Tools");
const builtinNav = h("nav", { class: "nav nav-builtin" });
const menuBtn = h("button", { class: "menu-btn btn-outline theme-secondary btn-sm", text: "☰" });
menuBtn.type = "button";
menuBtn.setAttribute("aria-label", "Toggle sidebar");
menuBtn.setAttribute("aria-expanded", "false");
// Sidebar footer: the running version (v1-abc1234); "update available" when the checkout moved on.
const versionEl = h("div", { class: "sidebar-version muted fs-xs px-4 py-2" });
const sidebar = h("aside", { class: "sidebar" }, h("div", { class: "brand", text: "motherapp" }), toolNav, h("div", { class: "spacer" }), builtinNav, versionEl);
const showVersion = () => {
  const v = app.version;
  versionEl.textContent = v ? `${v.running.string}${v.status === "behind" ? " · update available" : ""}` : "";
  versionEl.title = v ? (v.message ?? `built ${v.running.builtAt ?? "(unknown)"}`) : "";
};
app.onVersion(showVersion);
const connBanner = h("div", { class: "conn-banner", text: "Disconnected from motherapp — reconnecting…" });
const content = h("main", { class: "content" });
const shell = h("div", { class: "shell" }, sidebar, h("div", { class: "main-col" }, h("div", { class: "topbar" }, menuBtn, h("span", { class: "brand", text: "motherapp" })), connBanner, content));
document.body.append(shell);

const setSidebar = (open: boolean) => {
  shell.classList.toggle("sidebar-open", open);
  menuBtn.setAttribute("aria-expanded", String(open));
};
menuBtn.addEventListener("click", () => setSidebar(!shell.classList.contains("sidebar-open")));

function navLink(href: string, label: string, icon?: Node): HTMLAnchorElement {
  const a = h("a", { class: "nav-link" }, icon ?? null, h("span", { class: "nav-label", text: label }));
  a.href = href;
  a.addEventListener("click", () => setSidebar(false));
  return a;
}

builtinNav.append(navLink("#/logs", "Logs", h("span", { class: "nav-icon", text: "≡" })), navLink("#/settings", "Settings", h("span", { class: "nav-icon", text: "⚙" })));

// Sidebar tool entries are a keyed list too, so status changes don't rebuild the nav.
const navList = new KeyedList<ToolInfo, HTMLElement>(
  {
    insertBefore: (n, r) => toolNav.insertBefore(n, r),
    remove: (n) => n.remove(),
    nextSibling: (n) => n.nextElementSibling as HTMLElement | null,
  },
  (id, first) => {
    const icon = h("span", { class: "nav-icon" });
    const dot = h("span", { class: "tool-dot" });
    const a = navLink(`#/tool/${encodeURIComponent(id)}`, first.title, icon);
    a.append(dot);
    const update = (t: ToolInfo) => {
      (a.querySelector(".nav-label") as HTMLElement).textContent = t.title;
      if (t.iconUrl) {
        if (!icon.querySelector("img")) icon.replaceChildren(Object.assign(document.createElement("img"), { src: t.iconUrl, alt: "" }));
      } else {
        icon.textContent = t.icon ?? t.title.slice(0, 1);
      }
      dot.dataset.status = app.conn.connected ? t.status : "down";
      dot.title = app.conn.connected ? `${t.status}${t.statusText ? ": " + t.statusText : ""}` : "disconnected";
    };
    update(first);
    return { node: a, update, destroy: () => {} };
  },
);

function refreshNav(): void {
  navList.update(app.tools.filter((t) => t.enabled).map((t) => [t.id, t] as const));
  connBanner.hidden = app.conn.connected;
  for (const a of shell.querySelectorAll<HTMLAnchorElement>("a.nav-link")) {
    const active = a.getAttribute("href") === location.hash;
    a.classList.toggle("active", active);
    if (active) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
}
app.onTools(refreshNav);

// ---- routing ----
let unmount = () => {};
let current = "";

function route(): void {
  let hash = location.hash || "";
  if (!/^#\/(tool\/.+|logs|settings)$/.test(hash)) {
    const first = app.tools.find((t) => t.enabled);
    if (!app.toolsLoaded && hash === "") return; // wait for the tool list
    hash = first ? `#/tool/${encodeURIComponent(first.id)}` : "#/logs";
    history.replaceState(null, "", hash);
  }
  if (hash === current) return;
  current = hash;
  watch.setRoute(hash.startsWith("#/tool/") ? decodeURIComponent(hash.slice("#/tool/".length)) : null);
  unmount();
  content.replaceChildren();
  if (hash === "#/logs") {
    const el = new LogsPage();
    el.app = app;
    content.append(el);
    unmount = () => el.remove();
  } else if (hash === "#/settings") {
    unmount = mountSettings(app, content);
  } else {
    const id = decodeURIComponent(hash.slice("#/tool/".length));
    unmount = mountToolPage(app, id, content);
  }
  refreshNav();
}

window.addEventListener("hashchange", route);
app.onTools(() => {
  if (current === "") route();
});
app.start();
route();
refreshNav();
