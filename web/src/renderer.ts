// Declarative renderer (DESIGN.md § 4.1). Each widget binds to a state path in the tool's
// store and updates its own DOM in place; lists use KeyedList so rows survive changes.
import type {
  ButtonWidget,
  ControlStatus,
  JsonObject,
  JsonValue,
  ListWidget,
  MeterWidget,
  RadioWidget,
  SliderWidget,
  TextWidget,
  ToggleWidget,
  Widget,
} from "@motherapp/protocol";
import { joinPath } from "@motherapp/protocol";
import { ActionRunner } from "./actionRunner.ts";
import { KeyedList, listEntries } from "./keyedList.ts";
import type { Row, RowHost } from "./keyedList.ts";
import type { ToolStore } from "./store.ts";
import { interpolate, interpolateWidget } from "./template.ts";

export interface RenderContext {
  toolId: string;
  store: ToolStore;
  action(name: string, args?: JsonObject): Promise<JsonValue>;
  openStream(name: string, cb: (v: JsonValue) => void): () => void;
}

interface Mounted {
  el: HTMLElement;
  destroy(): void;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { class?: string; text?: string; title?: string } = {},
  ...children: (Node | null)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.text !== undefined) el.textContent = props.text;
  if (props.title) el.title = props.title;
  for (const c of children) if (c) el.append(c);
  return el;
}

/** Small status dot: setting / set / failed (message on hover). */
export function statusDot(): { el: HTMLElement; set(status: ControlStatus, error?: string): void } {
  const el = h("span", { class: "dot" });
  el.dataset.status = "idle";
  return {
    el,
    set(status, error) {
      el.dataset.status = status;
      el.title = status === "failed" ? `Failed: ${error ?? "unknown error"}` : status === "setting" ? "Setting…" : status === "set" ? "Set" : "";
      el.setAttribute("aria-label", el.title);
    },
  };
}

function markStale(el: HTMLElement, stale: boolean): void {
  el.classList.toggle("stale", stale);
  if (stale) el.dataset.staleHint = "not confirmed yet";
  else delete el.dataset.staleHint;
}

function display(v: JsonValue | undefined): string {
  if (v === undefined || v === null) return "";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

function control(label: string | undefined, ...parts: (Node | null)[]): HTMLElement {
  return h("div", { class: "control" }, label ? h("span", { class: "control-label", text: label }) : null, ...parts);
}

function runnerFor(ctx: RenderContext, action: string, onStatus: (s: ControlStatus, e?: string) => void): ActionRunner {
  return new ActionRunner((args) => ctx.action(action, args), onStatus);
}

let uid = 0;

// ---- widgets ----

function text(w: TextWidget, ctx: RenderContext): Mounted {
  const tag = w.style === "heading" ? "h3" : "p";
  const el = h(tag, { class: `w-text ${w.style ?? "body"}` });
  const update = () => {
    const v = w.bind ? ctx.store.get(w.bind) : undefined;
    el.textContent = v !== undefined ? display(v) : (w.text ?? "");
    if (w.bind) markStale(el, ctx.store.isStale(w.bind));
  };
  update();
  const off = w.bind ? ctx.store.subscribe(w.bind, update) : () => {};
  return { el, destroy: off };
}

function button(w: ButtonWidget, ctx: RenderContext): Mounted {
  const dot = statusDot();
  const btn = h("button", { class: `btn ${w.style ?? "default"}`, text: w.label });
  btn.type = "button";
  const runner = runnerFor(ctx, w.action, dot.set);
  btn.addEventListener("click", () => runner.send(w.args ?? {}));
  const el = h("div", { class: "control w-button" }, btn, dot.el);
  return { el, destroy: () => runner.dispose() };
}

function toggle(w: ToggleWidget, ctx: RenderContext): Mounted {
  const dot = statusDot();
  const input = h("input", { class: "switch" });
  input.type = "checkbox";
  input.setAttribute("role", "switch");
  if (w.label) input.setAttribute("aria-label", w.label);
  const sync = () => {
    if (!runner.busy) input.checked = ctx.store.get(w.bind) === true;
    markStale(el, ctx.store.isStale(w.bind));
  };
  const runner = runnerFor(ctx, w.action, (s, e) => {
    dot.set(s, e);
    if (s !== "setting") sync(); // on failure this reverts to the real value
  });
  input.addEventListener("change", () => runner.send({ ...w.args, value: input.checked }));
  const el = control(w.label, input, dot.el);
  el.classList.add("w-toggle");
  sync();
  const off = ctx.store.subscribe(w.bind, sync);
  return { el, destroy: () => (off(), runner.dispose()) };
}

function slider(w: SliderWidget, ctx: RenderContext): Mounted {
  const dot = statusDot();
  const input = h("input", { class: "range" });
  input.type = "range";
  input.min = String(w.min);
  input.max = String(w.max);
  input.step = String(w.step ?? 1);
  if (w.label) input.setAttribute("aria-label", w.label);
  const out = h("output", { class: "range-value" });
  let dragging = false;
  const showValue = (v: number) => (out.textContent = `${v}${w.unit ?? ""}`);
  const sync = () => {
    // Never yank the thumb while the user holds it or while our own value is on its way.
    const v = ctx.store.get(w.bind);
    if (!dragging && !runner.busy && typeof v === "number") {
      input.value = String(v);
      showValue(v);
    }
    markStale(el, ctx.store.isStale(w.bind));
  };
  const runner = runnerFor(ctx, w.action, (s, e) => {
    dot.set(s, e);
    if (s !== "setting") sync();
  });
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    sync();
  };
  input.addEventListener("pointerdown", () => (dragging = true));
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
  input.addEventListener("input", () => {
    const v = Number(input.value);
    showValue(v);
    runner.send({ ...w.args, value: v });
  });
  const el = control(w.label, input, out, dot.el);
  el.classList.add("w-slider");
  sync();
  const off = ctx.store.subscribe(w.bind, sync);
  return {
    el,
    destroy: () => {
      off();
      runner.dispose();
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    },
  };
}

function radio(w: RadioWidget, ctx: RenderContext): Mounted {
  const dot = statusDot();
  const group = `ma-${ctx.toolId}-${w.bind}`;
  const options = w.options ?? (w.value !== undefined ? [{ value: w.value, label: "" }] : []);
  const inputs: { input: HTMLInputElement; value: string | number }[] = [];
  const box = h("div", { class: "radio-group" });
  const sync = () => {
    if (!runner.busy) {
      const cur = ctx.store.get(w.bind);
      for (const r of inputs) r.input.checked = cur !== undefined && String(cur) === String(r.value);
    }
    markStale(el, ctx.store.isStale(w.bind));
  };
  const runner = runnerFor(ctx, w.action, (s, e) => {
    dot.set(s, e);
    if (s !== "setting") sync();
  });
  for (const o of options) {
    const input = h("input");
    input.type = "radio";
    input.name = group;
    input.value = String(o.value);
    input.id = `r${++uid}`;
    input.addEventListener("change", () => {
      if (input.checked) runner.send({ ...w.args, value: o.value });
    });
    inputs.push({ input, value: o.value });
    if (o.label) {
      const lab = h("label", { class: "radio" }, input, h("span", { text: o.label }));
      box.append(lab);
    } else {
      input.setAttribute("aria-label", "select");
      box.append(input);
    }
  }
  const el = control(w.label, box, dot.el);
  el.classList.add("w-radio");
  sync();
  const off = ctx.store.subscribe(w.bind, sync);
  return { el, destroy: () => (off(), runner.dispose()) };
}

function meter(w: MeterWidget, ctx: RenderContext): Mounted {
  const min = w.min ?? 0;
  const max = w.max ?? 1;
  const fill = h("div", { class: "meter-fill" });
  const bar = h("div", { class: "meter" }, fill);
  bar.setAttribute("role", "meter");
  bar.setAttribute("aria-valuemin", String(min));
  bar.setAttribute("aria-valuemax", String(max));
  const show = (v: JsonValue | undefined) => {
    const n = typeof v === "number" ? v : min;
    const f = Math.max(0, Math.min(1, (n - min) / (max - min || 1)));
    fill.style.width = `${(f * 100).toFixed(1)}%`;
    bar.setAttribute("aria-valuenow", String(n));
  };
  show(undefined);
  const cleanups: (() => void)[] = [];
  let closeStream: (() => void) | undefined;
  const open = () => {
    if (w.stream && !closeStream) closeStream = ctx.openStream(w.stream, show);
  };
  const close = () => {
    closeStream?.();
    closeStream = undefined;
    show(undefined);
  };
  let toggleBtn: HTMLButtonElement | null = null;
  if (w.stream && w.manual) {
    toggleBtn = h("button", { class: "btn small", text: "Monitor" });
    toggleBtn.type = "button";
    toggleBtn.setAttribute("aria-pressed", "false");
    toggleBtn.addEventListener("click", () => {
      const on = !closeStream;
      if (on) open();
      else close();
      toggleBtn!.setAttribute("aria-pressed", String(on));
    });
  } else if (w.stream) {
    open();
  }
  if (w.bind) {
    const bind = w.bind;
    const sync = () => {
      show(ctx.store.get(bind));
      markStale(el, ctx.store.isStale(bind));
    };
    cleanups.push(ctx.store.subscribe(bind, sync));
    queueMicrotask(sync);
  }
  const el = control(w.label, toggleBtn, bar);
  el.classList.add("w-meter");
  return { el, destroy: () => (close(), cleanups.forEach((c) => c())) };
}

function list(w: ListWidget, ctx: RenderContext): Mounted {
  const rowsEl = h("div", { class: "list-rows" });
  const empty = h("p", { class: "w-text muted list-empty", text: w.empty ?? "Nothing here." });
  const el = h("section", { class: "w-list" }, w.label ? h("h3", { class: "w-text heading", text: w.label }) : null, rowsEl, empty);

  const host: RowHost<HTMLElement> = {
    insertBefore: (node, ref) => rowsEl.insertBefore(node, ref),
    remove: (node) => node.remove(),
    nextSibling: (node) => node.nextElementSibling as HTMLElement | null,
  };

  const createRow = (key: string, item: unknown): Row<unknown, HTMLElement> => {
    const path = joinPath(w.bind, key);
    const tctx = () => ({ key, path, item: current });
    let current = item;
    const title = h("div", { class: "row-title" });
    const sub = h("div", { class: "row-sub" });
    const labels = h("div", { class: "row-labels" }, title, sub);
    const controls = h("div", { class: "row-controls" });
    const node = h("div", { class: "row" }, labels, controls);
    node.dataset.key = key;
    const setLabels = () => {
      const t = w.item.label ? interpolate(w.item.label, tctx()) : key;
      if (title.textContent !== t) title.textContent = t;
      const s = w.item.sublabel ? interpolate(w.item.sublabel, tctx()) : "";
      if (sub.textContent !== s) sub.textContent = s;
      sub.hidden = s === "";
    };
    setLabels();
    const widgets = (w.item.widgets ?? []).map((x) => interpolateWidget(x, tctx()));
    const cleanup = renderWidgets(widgets, controls, ctx);
    const staleSync = () => markStale(node, ctx.store.isStale(path));
    staleSync();
    return {
      node,
      update(next) {
        current = next;
        setLabels();
        staleSync();
      },
      destroy: cleanup,
    };
  };

  const keyed = new KeyedList<unknown, HTMLElement>(host, createRow);
  const sync = () => {
    const entries = listEntries(ctx.store.get(w.bind), w.sort);
    keyed.update(entries);
    empty.hidden = entries.length > 0;
  };
  sync();
  const off = ctx.store.subscribe(w.bind, sync);
  return {
    el,
    destroy: () => {
      off();
      keyed.clear();
    },
  };
}

function mount(w: Widget, ctx: RenderContext): Mounted {
  switch (w.type) {
    case "text":
      return text(w, ctx);
    case "button":
      return button(w, ctx);
    case "toggle":
      return toggle(w, ctx);
    case "slider":
      return slider(w, ctx);
    case "radio":
      return radio(w, ctx);
    case "meter":
      return meter(w, ctx);
    case "list":
      return list(w, ctx);
    default: {
      const el = h("p", { class: "w-text muted", text: `Unknown widget type: ${(w as { type: string }).type}` });
      return { el, destroy: () => {} };
    }
  }
}

/** Renders `widgets` into `container`; returns a cleanup that unsubscribes everything. */
export function renderWidgets(widgets: readonly Widget[], container: HTMLElement, ctx: RenderContext): () => void {
  const mounted = widgets.map((w) => mount(w, ctx));
  for (const m of mounted) container.append(m.el);
  return () => {
    for (const m of mounted) {
      m.destroy();
      m.el.remove();
    }
  };
}
