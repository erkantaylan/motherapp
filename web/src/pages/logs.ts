// Built-in logs page (DESIGN.md § 4.12): live tail, filter by tool and level, text search.
// A web component, like tool custom pages.
import { LOG_LEVELS } from "@motherapp/protocol";
import type { LogEntry, LogLevel } from "@motherapp/protocol";
import type { App } from "../app.ts";
import { defaultFilter, matches } from "../logFilter.ts";
import type { LogFilter } from "../logFilter.ts";
import { h } from "../renderer.ts";

const MAX_ENTRIES = 5000;
const MAX_ROWS = 2000;

function time(ts: string): string {
  const d = new Date(ts);
  return isNaN(d.getTime()) ? ts : d.toLocaleTimeString(undefined, { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0");
}

export class LogsPage extends HTMLElement {
  app: App | undefined;
  private entries: LogEntry[] = [];
  private filter: LogFilter = { ...defaultFilter };
  private rows = h("div", { class: "log-rows" });
  private toolSelect = h("select", { class: "form-control form-control-sm" });
  private count = h("span", { class: "muted" });
  private follow = true;
  private cleanups: (() => void)[] = [];

  connectedCallback(): void {
    const app = this.app;
    if (!app) return;
    this.toolSelect.setAttribute("aria-label", "Tool");
    this.toolSelect.addEventListener("change", () => this.setFilter({ tool: this.toolSelect.value }));
    const levelSelect = h("select", { class: "form-control form-control-sm" });
    levelSelect.setAttribute("aria-label", "Minimum level");
    for (const l of LOG_LEVELS) levelSelect.append(new Option(l === "debug" ? "all levels" : `${l}+`, l));
    levelSelect.addEventListener("change", () => this.setFilter({ level: levelSelect.value as LogLevel }));
    const search = h("input", { class: "form-control form-control-sm" });
    search.type = "search";
    search.placeholder = "Search";
    search.setAttribute("aria-label", "Search logs");
    let t: ReturnType<typeof setTimeout> | undefined;
    search.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(() => this.setFilter({ text: search.value }), 150);
    });
    const clear = h("button", { class: "btn-outline theme-secondary btn-sm", text: "Clear view" });
    clear.type = "button";
    clear.addEventListener("click", () => {
      this.entries = [];
      this.rebuild();
    });
    const bar = h("div", { class: "log-toolbar" }, this.toolSelect, levelSelect, search, clear, this.count);
    this.rows.addEventListener("scroll", () => {
      const r = this.rows;
      this.follow = r.scrollTop + r.clientHeight >= r.scrollHeight - 8;
    });
    this.append(h("header", { class: "page-header" }, h("h2", { text: "Logs" })), bar, this.rows);

    this.cleanups.push(
      app.onLog((e) => this.add(e)),
      app.conn.onOpen(() => {
        app.conn
          .request("logs.subscribe", { limit: MAX_ENTRIES })
          .then((r) => {
            this.entries = r.entries;
            this.rebuild();
          })
          .catch(() => {});
      }),
      app.onTools(() => this.refreshTools()),
    );
    this.refreshTools();
  }

  disconnectedCallback(): void {
    for (const c of this.cleanups) c();
    this.cleanups = [];
    this.app?.conn.request("logs.unsubscribe", {}).catch(() => {});
  }

  private refreshTools(): void {
    const ids = new Set<string>(["core", ...(this.app?.tools.map((t) => t.id) ?? []), ...this.entries.map((e) => e.tool)]);
    const cur = this.filter.tool;
    const opts = [new Option("all tools", ""), ...[...ids].sort().map((id) => new Option(id, id))];
    if (this.toolSelect.options.length === opts.length && opts.every((o, i) => this.toolSelect.options[i]!.value === o.value)) return;
    this.toolSelect.replaceChildren(...opts);
    this.toolSelect.value = cur;
  }

  private setFilter(f: Partial<LogFilter>): void {
    this.filter = { ...this.filter, ...f };
    this.rebuild();
  }

  private add(e: LogEntry): void {
    this.entries.push(e);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    if (!this.toolSelectHas(e.tool)) this.refreshTools();
    if (!matches(e, this.filter)) return;
    this.rows.append(this.row(e));
    while (this.rows.childElementCount > MAX_ROWS) this.rows.firstElementChild!.remove();
    this.updateCount();
    if (this.follow) this.rows.scrollTop = this.rows.scrollHeight;
  }

  private toolSelectHas(id: string): boolean {
    return [...this.toolSelect.options].some((o) => o.value === id);
  }

  /** Rebuilding is fine here: this is a filter change, not a data change. */
  private rebuild(): void {
    const shown = this.entries.filter((e) => matches(e, this.filter)).slice(-MAX_ROWS);
    this.rows.replaceChildren(...shown.map((e) => this.row(e)));
    this.updateCount();
    this.follow = true;
    this.rows.scrollTop = this.rows.scrollHeight;
  }

  private updateCount(): void {
    this.count.textContent = `${this.rows.childElementCount} shown`;
  }

  private row(e: LogEntry): HTMLElement {
    const fields = e.fields ? h("pre", { class: "log-fields", text: JSON.stringify(e.fields, null, 2) }) : null;
    if (fields) fields.hidden = true;
    const el = h(
      "div",
      { class: `log-row level-${e.level}`, title: e.ts },
      h("span", { class: "log-time", text: time(e.ts) }),
      h("span", { class: "log-level", text: e.level }),
      h("span", { class: "log-tool", text: e.src === "stderr" ? `${e.tool} (stderr)` : e.tool }),
      h("span", { class: "log-msg", text: e.msg + (e.fields ? " …" : "") }),
      fields,
    );
    if (fields) {
      el.classList.add("has-fields");
      el.addEventListener("click", () => (fields.hidden = !fields.hidden));
    }
    return el;
  }
}

customElements.define("ma-logs", LogsPage);
