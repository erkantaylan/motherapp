// The tool strip on the right edge of every page, like an IDE's tool window bar: one button per
// side panel. A click shows that panel beside the page (the page narrows to make room), a
// second click hides it. Where there is no room to dock (styles.scss, "tool strip") the panel
// lies over the page instead. Which panel is open is remembered per browser.
import { h } from "./renderer.ts";

/** From this window width up the panel docks; keep in step with $dock-min in styles.scss. */
export const DOCK_MIN_PX = 1480;
const OPEN_KEY = "motherapp.strip.open";

export interface StripPanel {
  id: string;
  /** The panel's heading and the button's name, e.g. "Notifications". */
  title: string;
  /** Inline SVG markup for the button (static, ours). */
  icon: string;
  /** The panel's content, below its header. */
  body: HTMLElement;
  /** Extra controls for the panel header, before the close button. */
  headerControls?: Node[];
  /** Runs when the panel is shown or hidden (also for the first, restored state). */
  onToggle?(open: boolean): void;
}

export interface StripButton {
  /** A small count on the button; "" removes it. `label` is the button's full name then. */
  setBadge(text: string, label?: string): void;
}

function stored(): string {
  try {
    return localStorage.getItem(OPEN_KEY) ?? "";
  } catch {
    return ""; // no storage here (private mode, blocked): nothing is remembered
  }
}

function store(id: string): void {
  try {
    localStorage.setItem(OPEN_KEY, id);
  } catch {
    // not remembered
  }
}

export class ToolStrip {
  /** The bar with the buttons. */
  readonly strip = h("nav", { class: "tool-strip" });
  /** The one side panel; shows the open button's content. */
  readonly panel = h("aside", { class: "side-panel" });
  private shell: HTMLElement;
  private titleEl = h("h2", { class: "side-panel-title" });
  private controls = h("div", { class: "side-panel-controls" });
  private bodyEl = h("div", { class: "side-panel-body" });
  private closeBtn = h("button", { class: "side-panel-close", text: "✕", title: "Hide" });
  private panels = new Map<string, { def: StripPanel; button: HTMLButtonElement }>();
  private openId = "";
  private wanted = stored();
  private docks = window.matchMedia(`(min-width: ${DOCK_MIN_PX}px)`);

  constructor(shell: HTMLElement) {
    this.shell = shell;
    this.strip.setAttribute("aria-label", "Side panels");
    this.panel.id = "side-panel";
    this.panel.hidden = true;
    this.closeBtn.type = "button";
    this.closeBtn.setAttribute("aria-label", "Hide panel");
    this.closeBtn.addEventListener("click", () => this.show(""));
    this.panel.append(h("header", { class: "side-panel-header" }, this.titleEl, this.controls, this.closeBtn), this.bodyEl);
    shell.append(this.panel, this.strip);
    // Escape closes a panel that lies over the page; a docked one stays, like the sidebar.
    window.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !this.openId || this.docked || e.defaultPrevented) return;
      if (document.querySelector("dialog[open]")) return; // the dialog's Escape
      this.show("");
    });
  }

  /** True when an open panel sits beside the page instead of over it. */
  get docked(): boolean {
    return this.docks.matches;
  }

  get open(): string {
    return this.openId;
  }

  add(def: StripPanel): StripButton {
    const button = h("button", { class: "strip-btn" });
    button.type = "button";
    button.innerHTML = def.icon;
    const badge = h("span", { class: "strip-badge" });
    badge.hidden = true;
    button.append(badge);
    button.title = def.title;
    button.setAttribute("aria-label", def.title);
    button.setAttribute("aria-controls", this.panel.id);
    button.setAttribute("aria-expanded", "false");
    button.dataset.panel = def.id;
    button.addEventListener("click", () => this.show(this.openId === def.id ? "" : def.id));
    this.strip.append(button);
    this.panels.set(def.id, { def, button });
    // Back to how this browser left it, but only where the panel docks: a page that opens
    // covered by a panel would be a bad start on a phone.
    if (this.wanted === def.id && this.docked) this.show(def.id, false);
    else def.onToggle?.(false);
    return {
      setBadge: (text, label) => {
        badge.textContent = text;
        badge.hidden = text === "";
        const name = label ?? def.title;
        button.title = name;
        button.setAttribute("aria-label", name);
      },
    };
  }

  /** Shows the panel `id`, or hides the open one for "". */
  show(id: string, remember = true): void {
    if (id !== "" && !this.panels.has(id)) return;
    const was = this.openId;
    if (id === was) return;
    this.openId = id;
    if (remember) store(id);
    for (const [key, p] of this.panels) {
      p.button.setAttribute("aria-expanded", String(key === id));
      p.button.classList.toggle("active", key === id);
    }
    const next = this.panels.get(id);
    this.panel.hidden = !next;
    this.shell.classList.toggle("panel-open", !!next);
    if (next) {
      this.titleEl.textContent = next.def.title;
      this.panel.setAttribute("aria-label", next.def.title);
      this.controls.replaceChildren(...(next.def.headerControls ?? []));
      this.bodyEl.replaceChildren(next.def.body);
    } else {
      this.bodyEl.replaceChildren();
      // The focus was inside the panel that just went away: back to its button.
      if (document.activeElement === document.body) this.panels.get(was)?.button.focus();
    }
    if (was) this.panels.get(was)?.def.onToggle?.(false);
    next?.def.onToggle?.(true);
  }
}
