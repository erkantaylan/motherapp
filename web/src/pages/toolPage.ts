// A tool's page: header (status, restart) + declarative renderer or the tool's custom element.
import type { PageContext, PageElement } from "@motherapp/protocol/page";
import type { ToolInfo } from "@motherapp/protocol";
import type { App } from "../app.ts";
import { h, renderWidgets } from "../renderer.ts";
import type { RenderContext } from "../renderer.ts";

const STATUS_TEXT: Record<ToolInfo["status"], string> = {
  stopped: "Stopped",
  starting: "Starting…",
  running: "Running",
  down: "Down",
  failed: "Failed",
};

export function renderContext(app: App, toolId: string): RenderContext {
  return {
    toolId,
    store: app.store(toolId),
    action: (name, args) => app.action(toolId, name, args),
    openStream: (name, cb) => app.openStream(toolId, name, cb),
  };
}

function pageContext(app: App, toolId: string): PageContext {
  const store = app.store(toolId);
  const rctx = renderContext(app, toolId);
  return {
    toolId,
    info: () => app.info(toolId),
    get: (path = "") => store.get(path),
    isStale: (path) => store.isStale(path),
    subscribe: (path, cb) => {
      cb(store.get(path));
      return store.subscribe(path, () => cb(store.get(path)));
    },
    action: (name, args, onProgress) => app.action(toolId, name, args, onProgress),
    openStream: (name, cb) => app.openStream(toolId, name, cb),
    render: (widgets, container) => renderWidgets(widgets, container, rctx),
  };
}

export function mountToolPage(app: App, toolId: string, root: HTMLElement): () => void {
  const title = h("h2");
  const statusEl = h("span", { class: "tool-status" });
  const restart = h("button", { class: "btn small", text: "Restart" });
  restart.type = "button";
  const restartErr = h("span", { class: "muted" });
  restart.addEventListener("click", () => {
    restartErr.textContent = "";
    app.conn.request("tool.restart", { tool: toolId }).catch((e: Error) => (restartErr.textContent = e.message));
  });
  const header = h("header", { class: "page-header" }, title, statusEl, restart, restartErr);
  const banner = h("p", { class: "banner" });
  const body = h("div", { class: "page-body" });
  root.append(header, banner, body);

  let renderedKey = "";
  let cleanup = () => {};

  const renderBody = (info: ToolInfo) => {
    const key = info.page === "custom" ? `custom:${info.pageUrl}` : info.page === "declarative" ? `decl:${JSON.stringify(info.layout ?? [])}` : "";
    if (key === renderedKey) return;
    cleanup();
    cleanup = () => {};
    body.replaceChildren();
    renderedKey = key;
    if (info.page === "declarative") {
      cleanup = renderWidgets(info.layout ?? [], body, renderContext(app, toolId));
    } else if (info.page === "custom" && info.pageUrl) {
      const url = info.pageUrl;
      let cancelled = false;
      cleanup = () => {
        cancelled = true;
      };
      import(/* @vite-ignore */ url)
        .then((mod: { default?: CustomElementConstructor }) => {
          if (cancelled) return;
          if (typeof mod.default !== "function") throw new Error(`${url} has no default-exported custom element`);
          const tag = `ma-page-${toolId}`;
          if (!customElements.get(tag)) customElements.define(tag, mod.default);
          const el = document.createElement(tag) as PageElement;
          el.ctx = pageContext(app, toolId);
          body.append(el);
          cleanup = () => el.remove();
        })
        .catch((e: Error) => {
          body.replaceChildren(h("p", { class: "banner error", text: `Cannot load page: ${e.message}` }));
        });
    } else {
      body.append(h("p", { class: "muted", text: "Waiting for the tool to describe its page…" }));
    }
  };

  const update = () => {
    const info = app.info(toolId);
    if (!info) {
      title.textContent = toolId;
      statusEl.textContent = "";
      banner.textContent = app.conn.connected ? "Unknown tool." : "";
      banner.hidden = banner.textContent === "";
      restart.hidden = true;
      return;
    }
    title.textContent = info.title;
    statusEl.textContent = STATUS_TEXT[info.status];
    statusEl.dataset.status = info.status;
    restart.hidden = !info.enabled;
    let msg = "";
    if (!info.enabled) msg = "This tool is disabled. Enable it on the Settings page.";
    else if (info.status === "failed") msg = `The tool keeps crashing and was not restarted (${info.statusText ?? ""}). Values shown are the last known ones.`;
    else if (info.status === "down") msg = `The tool is down (${info.statusText ?? ""}). Values shown are the last known ones.`;
    else if (!app.conn.connected) msg = "Disconnected from motherapp. Values shown are the last known ones.";
    banner.textContent = msg;
    banner.hidden = msg === "";
    banner.classList.toggle("error", info.status === "failed" || info.status === "down");
    renderBody(info);
  };
  update();
  const off = app.onTools(update);
  return () => {
    off();
    cleanup();
    root.replaceChildren();
  };
}
