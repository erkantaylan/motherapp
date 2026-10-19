// Built-in settings page: enable/disable tools, restart them.
import type { ToolInfo } from "@motherapp/protocol";
import type { App } from "../app.ts";
import { KeyedList } from "../keyedList.ts";
import { h, statusDot } from "../renderer.ts";

export function mountSettings(app: App, root: HTMLElement): () => void {
  const rowsEl = h("div", { class: "list-rows" });
  root.append(
    h("header", { class: "page-header" }, h("h2", { text: "Settings" })),
    h("h3", { class: "w-text heading", text: "Tools" }),
    rowsEl,
    h("p", { class: "w-text muted", text: "Changes are saved to ~/.config/motherapp/config.json." }),
  );

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
      const enabled = h("input", { class: "switch" });
      enabled.type = "checkbox";
      enabled.setAttribute("role", "switch");
      enabled.setAttribute("aria-label", "Enabled");
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
      const restart = h("button", { class: "btn small", text: "Restart" });
      restart.type = "button";
      restart.addEventListener("click", () => {
        app.conn.request("tool.restart", { tool: info.id }).catch((e: Error) => dot.set("failed", e.message));
      });
      const node = h(
        "div",
        { class: "row" },
        h("div", { class: "row-labels" }, title, sub),
        h("div", { class: "row-controls" }, h("label", { class: "control" }, h("span", { class: "control-label", text: "Enabled" }), enabled), restart, dot.el),
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
    root.replaceChildren();
  };
}
