// Built-in settings page: enable/disable tools, restart them; which version is running.
import type { ToolInfo, VersionInfo } from "@motherapp/protocol";
import type { App } from "../app.ts";
import { KeyedList } from "../keyedList.ts";
import { h, statusDot } from "../renderer.ts";

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

export function mountSettings(app: App, root: HTMLElement): () => void {
  const rowsEl = h("div", { class: "list-group list-rows" });
  const version = versionSection(app);
  root.append(
    h("header", { class: "page-header" }, h("h2", { text: "Settings" })),
    h("h3", { class: "w-text heading", text: "Tools" }),
    rowsEl,
    h("p", { class: "w-text muted", text: "Changes are saved to ~/.config/motherapp/config.json." }),
    version.el,
  );
  // The core caches the checkout for a minute, so opening the page doesn't run git each time;
  // "Check again" forces a fresh look.
  app.refreshVersion().catch(() => {});

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
      const node = h(
        "div",
        { class: "list-group-item list-row" },
        h("div", { class: "row-labels" }, title, sub),
        h("div", { class: "row-controls" }, h("label", { class: "control" }, h("span", { class: "control-label", text: "Enabled" }), h("div", { class: "switch" }, enabled)), restart, dot.el),
      );
      const update = (next: ToolInfo) => {
        info = next;
        title.textContent = `${next.icon ? next.icon + " " : ""}${next.title}`;
        sub.textContent = `${next.id} · ${next.status}${next.statusText ? ` · ${next.statusText}` : ""}`;
        enabled.checked = next.enabled;
        restart.hidden = !next.enabled;
      };
      update(first);
      return { node, update, destroy: () => {} };
    },
  );
  const sync = () => list.update(app.tools.map((t) => [t.id, t] as const));
  sync();
  const off = app.onTools(sync);
  return () => {
    off();
    version.off();
    root.replaceChildren();
  };
}
