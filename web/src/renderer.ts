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
import { ActionRunner, DotStatus } from "./actionRunner.ts";
import { KeyedList, listEntries } from "./keyedList.ts";
import type { Row, RowHost } from "./keyedList.ts";
import type { ToolStore } from "./store.ts";
import { buttonStyle, clickButton, copyToClipboard } from "./button.ts";
import type { CopyEnv } from "./button.ts";
import { interpolate, interpolateWidget } from "./template.ts";
import { textView } from "./textWidget.ts";
import type { TemplateContext } from "./template.ts";

export interface RenderContext {
  toolId: string;
  store: ToolStore;
  action(name: string, args?: JsonObject): Promise<JsonValue>;
  openStream(name: string, cb: (v: JsonValue) => void): () => void;
  /** Inside a list row: the row's current template context (for click-time templates). */
  template?: () => TemplateContext;
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

/**
 * Small status dot: setting / set / failed (message on hover). `set` fades out after ~2 s
 * (DotStatus); the dot keeps its space in every state, so nothing around it moves.
 */
export function statusDot(): { el: HTMLElement; set(status: ControlStatus, error?: string): void; dispose(): void } {
  const el = h("span", { class: "dot" });
  el.dataset.status = "idle";
  const state = new DotStatus((status, error) => {
    if (status === "idle") {
      // Keep the last colour (data-status) while the opacity transition runs; see styles.scss.
      if (el.dataset.status !== "idle") el.dataset.faded = "";
      el.title = "";
    } else {
      delete el.dataset.faded;
      el.dataset.status = status;
      el.title = status === "failed" ? `Failed: ${error ?? "unknown error"}` : status === "setting" ? "Setting…" : "Set";
    }
    if (el.title) el.setAttribute("aria-label", el.title);
    else el.removeAttribute("aria-label");
  });
  return { el, set: (status, error) => state.set(status, error), dispose: () => state.cancel() };
}

function markStale(el: HTMLElement, stale: boolean): void {
  el.classList.toggle("stale", stale);
  if (stale) el.dataset.staleHint = "not confirmed yet";
  else delete el.dataset.staleHint;
}

/** A labelled control row. With `target`, the label is a `<label for>` that names that input. */
function control(label: string | undefined, target: HTMLElement | null, ...parts: (Node | null)[]): HTMLElement {
  let lab: HTMLElement | null = null;
  if (label && target) {
    if (!target.id) target.id = `c${++uid}`;
    const l = h("label", { class: "control-label", text: label });
    l.htmlFor = target.id;
    lab = l;
  } else if (label) {
    lab = h("span", { class: "control-label", text: label });
  }
  return h("div", { class: "control" }, lab, ...parts);
}

const BUTTON_CLASS: Record<NonNullable<ButtonWidget["style"]>, string> = {
  default: "btn-outline theme-secondary",
  primary: "btn-solid theme-primary",
  danger: "btn-outline theme-danger",
};

/** Bootstrap classes for a button of `style`; `solid` for the main button of a dialog. */
export function buttonClass(style: ButtonWidget["style"] = "default", solid = false): string {
  if (solid) return style === "danger" ? "btn-solid theme-danger" : "btn-solid theme-primary";
  return BUTTON_CLASS[style] ?? BUTTON_CLASS.default;
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
    const view = textView(w, w.bind ? ctx.store.get(w.bind) : undefined);
    el.textContent = view.text;
    el.classList.toggle("reserve", view.reserve);
    if (w.bind) markStale(el, ctx.store.isStale(w.bind));
  };
  update();
  const off = w.bind ? ctx.store.subscribe(w.bind, update) : () => {};
  return { el, destroy: off };
}

/** In-page modal dialog (native `<dialog>`). Resolves with the button pressed, or "cancel" on Escape. */
function modal(build: (dlg: HTMLDialogElement, close: (value: string) => void) => HTMLElement): Promise<string> {
  return new Promise((resolve) => {
    const dlg = h("dialog", { class: "dialog" });
    let done = false;
    const close = (value: string) => {
      if (done) return;
      done = true;
      dlg.close();
      dlg.remove();
      if (!document.querySelector("dialog[open]")) document.documentElement.classList.remove("dialog-open");
      resolve(value);
    };
    dlg.addEventListener("cancel", (e) => {
      e.preventDefault();
      close("cancel");
    });
    dlg.addEventListener("close", () => close("cancel"));
    const focus = build(dlg, close);
    document.body.append(dlg);
    document.documentElement.classList.add("dialog-open"); // Bootstrap's scroll lock
    dlg.showModal();
    focus.focus();
  });
}

/** Confirm dialog for a button's `confirm` text. Cancel has the focus, so Enter is harmless. */
export function confirmDialog(text: string, okLabel: string, style: ButtonWidget["style"]): Promise<boolean> {
  return modal((dlg, close) => {
    const msg = h("p", { class: "dialog-text", text });
    msg.id = `dlg${++uid}`;
    dlg.setAttribute("role", "alertdialog");
    dlg.setAttribute("aria-label", "Confirm");
    dlg.setAttribute("aria-describedby", msg.id);
    const cancel = h("button", { class: buttonClass("default"), text: "Cancel" });
    const ok = h("button", { class: buttonClass(style, true), text: okLabel });
    cancel.type = ok.type = "button";
    cancel.addEventListener("click", () => close("cancel"));
    ok.addEventListener("click", () => close("ok"));
    dlg.append(h("div", { class: "dialog-body" }, msg), h("div", { class: "dialog-footer" }, cancel, ok));
    return cancel;
  }).then((v) => v === "ok");
}

/** Fallback when the clipboard can't be written: the text, selected, and "press Ctrl+C". */
function manualCopyDialog(text: string): Promise<void> {
  return modal((dlg, close) => {
    const msg = h("p", { class: "dialog-text mb-4", text: "The browser won't let this page copy. Press Ctrl+C to copy the selected text:" });
    msg.id = `dlg${++uid}`;
    dlg.setAttribute("aria-labelledby", msg.id);
    const field = h("input", { class: "form-control font-monospace" });
    field.readOnly = true;
    field.value = text;
    field.addEventListener("focus", () => field.select());
    field.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") setTimeout(() => close("ok"), 0);
    });
    const done = h("button", { class: buttonClass("default"), text: "Close" });
    done.type = "button";
    done.addEventListener("click", () => close("ok"));
    dlg.append(h("div", { class: "dialog-body" }, msg, field), h("div", { class: "dialog-footer" }, done));
    return field;
  }).then(() => undefined);
}

function execCopy(text: string): boolean {
  const ta = h("textarea", { class: "ma-offscreen" });
  ta.value = text;
  ta.readOnly = true;
  document.body.append(ta);
  ta.select();
  try {
    return document.execCommand("copy");
  } finally {
    ta.remove();
  }
}

const domCopyEnv = (): CopyEnv => ({
  writeText: window.isSecureContext && navigator.clipboard?.writeText ? (t) => navigator.clipboard.writeText(t) : undefined,
  execCopy,
  manual: manualCopyDialog,
});

/** One shared toast at the bottom corner, e.g. "Copied to the clipboard". Its container is a live region. */
let toast: { el: HTMLElement; body: HTMLElement; timer?: ReturnType<typeof setTimeout> } | undefined;

export function showToast(text: string, ms = 1500): void {
  if (!toast) {
    const body = h("div", { class: "toast-body" });
    const el = h("div", { class: "toast" }, body);
    const box = h("div", { class: "toast-container ma-toasts" }, el);
    box.setAttribute("role", "status");
    box.setAttribute("aria-live", "polite");
    box.setAttribute("aria-atomic", "true");
    document.body.append(box);
    toast = { el, body };
  }
  const t = toast;
  clearTimeout(t.timer);
  t.body.textContent = text;
  t.el.classList.add("show");
  t.timer = setTimeout(() => {
    t.el.classList.remove("show");
    t.body.textContent = "";
  }, ms);
}

function button(w: ButtonWidget, ctx: RenderContext): Mounted {
  const dot = statusDot();
  const style = buttonStyle(w);
  const btn = h("button", { class: buttonClass(style), text: w.label });
  btn.type = "button";
  const runner = w.action !== undefined ? runnerFor(ctx, w.action, dot.set) : undefined;
  const copied = () => showToast("Copied to the clipboard");
  btn.addEventListener("click", () => {
    void clickButton(w, {
      template: ctx.template,
      get: (p) => ctx.store.get(p),
      confirm: (text) => confirmDialog(text, w.label, style),
      copy: async (text) => {
        if ((await copyToClipboard(text, domCopyEnv())) === "copied") copied();
      },
      send: runner ? (args) => runner.send(args) : undefined,
    });
  });
  const el = h("div", { class: "control w-button" }, btn, runner ? dot.el : null);
  return { el, destroy: () => (runner?.dispose(), dot.dispose()) };
}

function toggle(w: ToggleWidget, ctx: RenderContext): Mounted {
  const dot = statusDot();
  const input = h("input");
  input.type = "checkbox";
  input.setAttribute("role", "switch");
  input.setAttribute("switch", "");
  if (w.label) input.setAttribute("aria-label", w.label);
  const sw = h("div", { class: "switch" }, input);
  const sync = () => {
    if (!runner.busy) input.checked = ctx.store.get(w.bind) === true;
    markStale(el, ctx.store.isStale(w.bind));
  };
  const runner = runnerFor(ctx, w.action, (s, e) => {
    dot.set(s, e);
    if (s !== "setting") sync(); // on failure this reverts to the real value
  });
  input.addEventListener("change", () => runner.send({ ...w.args, value: input.checked }));
  const el = control(w.label, input, sw, dot.el);
  el.classList.add("w-toggle");
  sync();
  const off = ctx.store.subscribe(w.bind, sync);
  return { el, destroy: () => (off(), runner.dispose(), dot.dispose()) };
}

function slider(w: SliderWidget, ctx: RenderContext): Mounted {
  const dot = statusDot();
  const input = h("input", { class: "form-range-input" });
  input.type = "range";
  input.min = String(w.min);
  input.max = String(w.max);
  input.step = String(w.step ?? 1);
  if (w.label) input.setAttribute("aria-label", w.label);
  const wrap = h("div", { class: "form-range w-range" }, input);
  const out = h("output", { class: "range-value" });
  let dragging = false;
  const span = w.max - w.min;
  const showValue = (v: number) => {
    out.textContent = `${v}${w.unit ?? ""}`;
    // Bootstrap's range JS would set this; the track's filled part is drawn from it.
    wrap.style.setProperty("--bs-range-fill", String(span > 0 ? Math.max(0, Math.min(1, (v - w.min) / span)) : 0));
  };
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
  const el = control(w.label, input, wrap, out, dot.el);
  el.classList.add("w-slider");
  sync();
  const off = ctx.store.subscribe(w.bind, sync);
  return {
    el,
    destroy: () => {
      off();
      runner.dispose();
      dot.dispose();
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
  const single = w.options === undefined;
  if (!single) {
    box.setAttribute("role", "radiogroup");
    if (w.label) box.setAttribute("aria-label", w.label);
  }
  const sync = () => {
    if (!runner.busy) {
      const cur = ctx.store.get(w.bind);
      for (const r of inputs) r.input.checked = cur !== undefined && String(cur) === String(r.value);
    }
    // A one-button radio in a list row ("default device") also highlights its row.
    if (single) el.closest(".list-row")?.classList.toggle("selected", inputs[0]?.input.checked === true);
    markStale(el, ctx.store.isStale(w.bind));
  };
  const runner = runnerFor(ctx, w.action, (s, e) => {
    dot.set(s, e);
    if (s !== "setting") sync();
  });
  for (const o of options) {
    const input = h("input", { class: "radio" });
    input.type = "radio";
    input.name = group;
    input.value = String(o.value);
    input.id = `r${++uid}`;
    input.addEventListener("change", () => {
      if (input.checked) runner.send({ ...w.args, value: o.value });
    });
    inputs.push({ input, value: o.value });
    if (o.label) {
      const lab = h("label", { class: "radio-option" }, input, h("span", { text: o.label }));
      box.append(lab);
    } else {
      input.setAttribute("aria-label", "select");
      box.append(input);
    }
  }
  const el = control(w.label, null, box, dot.el);
  el.classList.add("w-radio");
  sync();
  if (single) queueMicrotask(sync); // the row exists once this widget is attached
  const off = ctx.store.subscribe(w.bind, sync);
  return { el, destroy: () => (off(), runner.dispose(), dot.dispose()) };
}

function meter(w: MeterWidget, ctx: RenderContext): Mounted {
  const min = w.min ?? 0;
  const max = w.max ?? 1;
  const fill = h("div", { class: "progress-bar" });
  const bar = h("div", { class: "progress meter theme-success" }, fill);
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
    toggleBtn = h("button", { class: "btn-outline theme-primary btn-sm", text: "Monitor" });
    toggleBtn.type = "button";
    toggleBtn.setAttribute("aria-pressed", "false");
    toggleBtn.addEventListener("click", () => {
      const on = !closeStream;
      if (on) open();
      else close();
      toggleBtn!.setAttribute("aria-pressed", String(on));
      toggleBtn!.classList.toggle("active", on);
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
  const el = control(w.label, null, toggleBtn, bar);
  el.classList.add("w-meter");
  return { el, destroy: () => (close(), cleanups.forEach((c) => c())) };
}

function list(w: ListWidget, ctx: RenderContext): Mounted {
  const rowsEl = h("div", { class: "list-group list-rows" });
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
    const node = h("div", { class: "list-group-item list-row" }, labels, controls);
    node.dataset.key = key;
    const setLabels = () => {
      const t = w.item.label ? interpolate(w.item.label, tctx()) : key;
      if (title.textContent !== t) title.textContent = t;
      const s = w.item.sublabel ? interpolate(w.item.sublabel, tctx()) : "";
      if (sub.textContent !== s) {
        sub.textContent = s;
        sub.title = s; // the line is cut with an ellipsis when it doesn't fit
      }
      sub.hidden = s === "";
    };
    setLabels();
    const widgets = (w.item.widgets ?? []).map((x) => interpolateWidget(x, tctx()));
    const cleanup = renderWidgets(widgets, controls, { ...ctx, template: tctx });
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
