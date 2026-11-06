/// <reference lib="dom" />
// The tmux tool's custom page (a light-DOM custom element, docs/extension-contract.md § 6): the
// session list on one side, a large live preview of the selected session on the other, stacked
// on a narrow screen. List, state and timeline come from state, which the tool keeps current all
// the time. The preview and Claude's text come from the `view` action, asked for only while this
// tab is visible and only for the selected session. `view` and `open` are local only: the core
// refuses them on a LAN connection, and then this page drops the preview and the Open button.
//
// Everything from a pane or a transcript goes in through textContent and style properties, never
// as HTML. Shared logic is in ./src/view.ts and ./src/ansi.ts, which import nothing.
import type { JsonValue } from "@motherapp/protocol";
import type { PageContext } from "@motherapp/protocol/page";
import { DEFAULT_BG, DEFAULT_FG, parseAnsi } from "./src/ansi.ts";
import { formatTokens, previewFontPx, summaryText, timelineBars, timelineText } from "./src/view.ts";

interface Row {
  id: string;
  name: string;
  detail: string;
  where: string;
  attachedNote: string;
  state: string;
  claude: boolean;
  timeline: string;
  /** Sub-agents running now; absent at 0. */
  agents?: number;
}

interface ListExtra {
  title?: string;
  contextTokens?: number;
}

interface ClaudeView extends ListExtra {
  lastPrompt?: string;
  lastMessage?: string;
  model?: string;
  name?: string;
  waitingFor?: string;
}

interface ViewResult {
  rows: Record<string, ListExtra>;
  selected?: { id: string; text?: string; cols?: number; claude?: ClaudeView };
}

/** ErrorCode.LocalOnly. A bare import doesn't resolve in the browser, so it's spelled out. */
const LOCAL_ONLY = -32004;
const VIEW_MS = 1500;
const WIDE_PX = 820;
const SELECTED_KEY = "motherapp.tmux.selected";

const STYLE = `
.mtx { display: grid; gap: 12px; color: var(--fg); container-type: inline-size; min-width: 0; }
.mtx-summary { margin: 0; color: var(--muted); font-size: 0.9rem; }
.mtx-grid { display: grid; gap: 16px; grid-template-columns: minmax(0, 1fr); }
@container (min-width: ${WIDE_PX}px) {
  .mtx-grid { grid-template-columns: minmax(280px, 340px) minmax(0, 1fr); align-items: start; }
  .mtx-list { position: sticky; top: 12px; max-height: calc(100vh - 110px); overflow-y: auto; }
}
.mtx-list { display: grid; gap: 6px; min-width: 0; align-content: start; }
.mtx-list[data-stale="true"] { opacity: 0.6; }
.mtx-empty { color: var(--muted); padding: 12px; }
.mtx-row { display: grid; gap: 3px; width: 100%; min-width: 0; padding: 8px 10px; text-align: start; font: inherit; color: var(--fg); cursor: pointer;
  background: var(--surface); border: 1px solid var(--border); border-radius: 8px; }
.mtx-row:hover { border-color: var(--accent); }
.mtx-row:focus-visible, .mtx-btn:focus-visible, .mtx-rename input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
.mtx-row[aria-current="true"] { border-color: var(--accent); box-shadow: inset 3px 0 0 var(--accent); }
.mtx-top, .mtx-mid { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.mtx-name { font-weight: 600; flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mtx-state { flex: none; display: inline-flex; align-items: center; gap: 5px; font-size: 0.8125rem; color: var(--muted); }
.mtx-dot { width: 8px; height: 8px; border-radius: 50%; border: 2px solid var(--muted); box-sizing: border-box; flex: none; }
[data-state="working"] .mtx-dot { background: var(--ok); border-color: var(--ok); }
[data-state="working"] > .mtx-state, [data-state="working"] .mtx-top .mtx-state { color: var(--fg); }
[data-state="waiting"] .mtx-dot { background: var(--warn); border-color: var(--warn); }
[data-state="waiting"] .mtx-top .mtx-state { color: var(--fg); font-weight: 600; }
[data-state="idle"] .mtx-dot { background: var(--muted); }
.mtx-sub { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: 0.8125rem; }
.mtx-chip { flex: none; font-size: 0.75rem; color: var(--muted); font-variant-numeric: tabular-nums; }
.mtx-tl { display: block; width: 100%; height: 14px; color: var(--muted); }
.mtx-tl .base { stroke: var(--border); stroke-width: 1; }
.mtx-tl .busy { fill: var(--ok); }
.mtx-tl .wait { fill: var(--warn); }
.mtx-main { display: grid; gap: 10px; min-width: 0; }
.mtx-card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 10px 14px; min-width: 0; }
.mtx-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; }
.mtx-head h3 { margin: 0; font-size: 1.05rem; overflow-wrap: anywhere; min-width: 0; }
.mtx-meta { color: var(--muted); font-size: 0.8125rem; flex-basis: 100%; overflow-wrap: anywhere; }
.mtx-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 8px; }
.mtx-actions > div { display: contents; }
.mtx-btn { padding: 6px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: var(--fg); cursor: pointer; font: inherit; white-space: nowrap; }
.mtx-btn:hover { border-color: var(--accent); }
.mtx-btn:disabled { opacity: 0.5; cursor: default; }
.mtx-rename { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.mtx-rename input { flex: 1 1 14em; min-width: 0; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--fg); font: inherit; }
.mtx-note { margin: 6px 0 0; font-size: 0.875rem; color: var(--muted); overflow-wrap: anywhere; }
.mtx-note[data-error="true"] { color: var(--err); }
.mtx-screen { margin: 0; padding: 8px 10px; overflow: auto; max-height: 60vh; min-height: 120px; border-radius: 8px; border: 1px solid var(--border);
  background: ${DEFAULT_BG}; color: ${DEFAULT_FG}; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; line-height: 1.2; white-space: pre; tab-size: 8; }
@container (min-width: ${WIDE_PX}px) { .mtx-screen { max-height: calc(100vh - 300px); } }
.mtx-screen[hidden], .mtx-claude[hidden], .mtx-rename[hidden], .mtx-note[hidden], .mtx-main[hidden] { display: none; }
.mtx-claude dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 12px; margin: 0; font-size: 0.875rem; }
.mtx-claude dt { color: var(--muted); }
.mtx-claude dd { margin: 0; min-width: 0; overflow-wrap: anywhere; white-space: pre-wrap; max-height: 12em; overflow-y: auto; }
@media (max-width: 720px) { .mtx-claude dl { grid-template-columns: minmax(0, 1fr); } .mtx-claude dd { margin-bottom: 6px; } }
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: { class?: string; text?: string } = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (props.class) e.className = props.class;
  if (props.text !== undefined) e.textContent = props.text;
  e.append(...kids);
  return e;
}

const SVG = "http://www.w3.org/2000/svg";
const BAR_STEP = 2;
const TL_WIDTH = 120;
const TL_HEIGHT = 14;

/** The hour as bars on one baseline: height is how much of that minute it was busy. */
function timeline(): { root: SVGSVGElement; update(encoded: string): void } {
  const root = document.createElementNS(SVG, "svg");
  root.setAttribute("class", "mtx-tl");
  root.setAttribute("viewBox", `0 0 ${TL_WIDTH} ${TL_HEIGHT}`);
  root.setAttribute("preserveAspectRatio", "none");
  root.setAttribute("role", "img");
  const title = document.createElementNS(SVG, "title");
  const base = document.createElementNS(SVG, "line");
  base.setAttribute("class", "base");
  base.setAttribute("x1", "0");
  base.setAttribute("x2", String(TL_WIDTH));
  base.setAttribute("y1", String(TL_HEIGHT - 0.5));
  base.setAttribute("y2", String(TL_HEIGHT - 0.5));
  const busy = document.createElementNS(SVG, "path");
  busy.setAttribute("class", "busy");
  const wait = document.createElementNS(SVG, "path");
  wait.setAttribute("class", "wait");
  root.append(title, base, busy, wait);
  return {
    root,
    update(encoded) {
      let busyPath = "";
      let waitPath = "";
      timelineBars(encoded).forEach((b, i) => {
        if (b.level === 0) return;
        const h = Math.max(2, b.level * (TL_HEIGHT - 1));
        const bar = `M${i * BAR_STEP} ${TL_HEIGHT}v-${h}h${BAR_STEP - 0.5}v${h}z`;
        if (b.waiting) waitPath += bar;
        else busyPath += bar;
      });
      busy.setAttribute("d", busyPath);
      wait.setAttribute("d", waitPath);
      const text = timelineText(encoded);
      title.textContent = text;
      root.setAttribute("aria-label", text);
    },
  };
}

const asRows = (v: JsonValue | undefined): Record<string, Row> => (v && typeof v === "object" && !Array.isArray(v) ? (v as unknown as Record<string, Row>) : {});
/** A confirm outside a list has no row to fill in, so `{word}` in a name must stay as it is. */
const noPlaceholders = (s: string) => s.replace(/\{/g, "{​");
const agentsText = (n: number) => `${n} sub-agent${n === 1 ? "" : "s"}`;

function readSelected(): string | undefined {
  try {
    return localStorage.getItem(SELECTED_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function saveSelected(id: string): void {
  try {
    localStorage.setItem(SELECTED_KEY, id);
  } catch {
    // only a convenience
  }
}

interface RowEls {
  root: HTMLButtonElement;
  name: HTMLElement;
  stateWord: HTMLElement;
  sub: HTMLElement;
  chip: HTMLElement;
  update(encoded: string): void;
}

export default class TmuxPage extends HTMLElement {
  ctx?: PageContext;
  private off: (() => void)[] = [];
  private sessions: Record<string, Row> = {};
  private extras: Record<string, ListExtra> = {};
  private rows = new Map<string, RowEls>();
  private selected: string | undefined = readSelected();
  /** Known after the first `view` answer. */
  private local: boolean | undefined;
  private viewTimer: ReturnType<typeof setTimeout> | undefined;
  private viewSeq = 0;
  private shownText: string | undefined;
  private cols = 0;
  private actionsKey = "";
  private actionsOff: (() => void)[] = [];
  private claudeView: ClaudeView | undefined;
  private resize: ResizeObserver | undefined;

  private root = el("div", { class: "mtx" });
  private summary = el("p", { class: "mtx-summary" });
  private list = el("div", { class: "mtx-list" });
  private main = el("div", { class: "mtx-main" });
  private heading = el("h3");
  private stateBox = el("span", { class: "mtx-state" });
  private meta = el("span", { class: "mtx-meta" });
  private actionsBefore = el("div");
  private actionsAfter = el("div");
  private renameBtn = el("button", { class: "mtx-btn", text: "Rename" });
  private renameForm = el("form", { class: "mtx-rename" });
  private renameInput = el("input");
  private renameNote = el("p", { class: "mtx-note" });
  private screen = el("pre", { class: "mtx-screen" });
  private screenNote = el("p", { class: "mtx-note" });
  private claude = el("div", { class: "mtx-card mtx-claude" });

  connectedCallback(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const style = el("style");
    style.textContent = STYLE;
    this.build();
    this.replaceChildren(style, this.root);
    this.off.push(ctx.subscribe("sessions", (v) => this.onSessions(v)));
    this.off.push(ctx.subscribe("status", () => this.renderSummary()));
    const onVisible = () => {
      if (document.visibilityState === "visible") this.refreshSoon(0);
      else this.stopView();
    };
    document.addEventListener("visibilitychange", onVisible);
    this.off.push(() => document.removeEventListener("visibilitychange", onVisible));
    this.resize = new ResizeObserver(() => this.fitScreen());
    this.resize.observe(this.screen);
    this.refreshSoon(0);
  }

  disconnectedCallback(): void {
    this.off.forEach((f) => f());
    this.off = [];
    this.actionsOff.forEach((f) => f());
    this.actionsOff = [];
    this.resize?.disconnect();
    this.stopView();
    this.viewSeq++;
  }

  private build(): void {
    this.renameBtn.type = "button";
    this.renameBtn.addEventListener("click", () => this.toggleRename());
    this.renameInput.setAttribute("aria-label", "New session name");
    const save = el("button", { class: "mtx-btn", text: "Save" });
    save.type = "submit";
    const cancel = el("button", { class: "mtx-btn", text: "Cancel" });
    cancel.type = "button";
    cancel.addEventListener("click", () => this.closeRename());
    this.renameForm.append(this.renameInput, save, cancel);
    this.renameForm.hidden = true;
    this.renameForm.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.submitRename();
    });
    this.renameForm.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.closeRename();
    });
    this.renameNote.hidden = true;
    this.screenNote.hidden = true;
    this.claude.hidden = true;
    const head = el("div", { class: "mtx-head" }, this.heading, this.stateBox, this.meta);
    const actions = el("div", { class: "mtx-actions" }, this.actionsBefore, this.renameBtn, this.actionsAfter);
    this.main.append(el("div", { class: "mtx-card" }, head, actions, this.renameForm, this.renameNote), this.screen, this.screenNote, this.claude);
    this.root.append(this.summary, el("div", { class: "mtx-grid" }, this.list, this.main));
  }

  // ---- list ----

  private sortedIds(): string[] {
    return Object.keys(this.sessions).sort((a, b) => this.sessions[a]!.name.localeCompare(this.sessions[b]!.name));
  }

  private onSessions(v: JsonValue | undefined): void {
    this.sessions = asRows(v);
    const ids = this.sortedIds();
    if (this.selected === undefined || !this.sessions[this.selected]) {
      const next = ids[0];
      if (next !== this.selected) this.select(next, false);
    }
    for (const [id, r] of this.rows) {
      if (this.sessions[id]) continue;
      r.root.remove();
      this.rows.delete(id);
    }
    for (const id of ids) this.updateRow(id);
    const inOrder = ids.map((id) => this.rows.get(id)!.root);
    if (inOrder.some((e, i) => this.list.children[i] !== e) || this.list.children.length !== inOrder.length) this.list.replaceChildren(...inOrder);
    if (ids.length === 0) this.list.replaceChildren(el("div", { class: "mtx-empty", text: "No tmux sessions." }));
    this.list.dataset.stale = String(this.ctx?.isStale("sessions") === true);
    this.renderSummary();
    this.renderSelected();
  }

  private makeRow(id: string): RowEls {
    const name = el("span", { class: "mtx-name" });
    const stateWord = el("span");
    const dot = el("span", { class: "mtx-dot" });
    const sub = el("span", { class: "mtx-sub" });
    const chip = el("span", { class: "mtx-chip" });
    const tl = timeline();
    const root = el("button", { class: "mtx-row" }, el("span", { class: "mtx-top" }, name, el("span", { class: "mtx-state" }, dot, stateWord)), el("span", { class: "mtx-mid" }, sub, chip), tl.root);
    root.type = "button";
    root.addEventListener("click", () => this.select(id, true));
    return { root, name, stateWord, sub, chip, update: tl.update };
  }

  private updateRow(id: string): void {
    const s = this.sessions[id]!;
    let r = this.rows.get(id);
    if (!r) {
      r = this.makeRow(id);
      this.rows.set(id, r);
    }
    const extra = this.extras[id];
    r.root.dataset.state = s.state;
    r.root.setAttribute("aria-current", String(id === this.selected));
    r.name.textContent = s.name;
    r.name.title = s.name;
    r.stateWord.textContent = s.state;
    r.sub.textContent = (s.claude && extra?.title) || s.where;
    r.sub.title = r.sub.textContent;
    const chips = [];
    if (s.agents) chips.push(agentsText(s.agents));
    if (s.claude && extra?.contextTokens) chips.push(formatTokens(extra.contextTokens));
    r.chip.textContent = chips.join(" · ");
    r.update(s.timeline ?? "");
  }

  private renderSummary(): void {
    const status = this.ctx?.get("status");
    this.summary.textContent = typeof status === "string" ? status : summaryText(Object.values(this.sessions).map((s) => s.state));
  }

  private select(id: string | undefined, byUser: boolean): void {
    if (id === this.selected && !byUser) return;
    const changed = id !== this.selected;
    this.selected = id;
    if (id !== undefined && byUser) saveSelected(id);
    for (const [k, r] of this.rows) r.root.setAttribute("aria-current", String(k === id));
    if (changed) {
      this.shownText = undefined;
      this.claudeView = undefined;
      this.screen.replaceChildren();
      this.renderClaude();
      this.closeRename();
      this.renameNote.hidden = true;
    }
    this.renderSelected();
    this.refreshSoon(0);
    // Stacked, the preview is below the list. Not smooth: the re-render that follows would stop it.
    if (byUser && this.root.clientWidth < WIDE_PX) this.main.scrollIntoView({ block: "start" });
  }

  // ---- selected session ----

  private renderSelected(): void {
    const s = this.selected === undefined ? undefined : this.sessions[this.selected];
    this.main.hidden = !s;
    if (!s) return;
    this.heading.textContent = s.name;
    this.main.dataset.state = s.state;
    this.stateBox.replaceChildren(el("span", { class: "mtx-dot" }), s.state);
    this.meta.textContent = s.detail;
    this.renderActions(s);
    this.renderClaude();
  }

  /** ctx.render gives Open and Kill the shell's status dot, and Kill its confirm dialog. */
  private renderActions(s: Row): void {
    const key = JSON.stringify([s.id, s.name, s.attachedNote, this.local]);
    if (key === this.actionsKey || !this.ctx) return;
    this.actionsKey = key;
    this.actionsOff.forEach((f) => f());
    const id = this.selected!;
    this.actionsOff = [
      this.ctx.render(
        [
          ...(this.local === true ? [{ type: "button" as const, label: "Open", action: "open", args: { id }, style: "primary" as const }] : []),
          { type: "button" as const, label: "Copy attach command", copy: { bind: `sessions.${id}.attachCommand` } },
        ],
        this.actionsBefore,
      ),
      this.ctx.render([{ type: "button", label: "Kill", action: "kill", args: { id }, confirm: `Kill tmux session '${noPlaceholders(s.name)}'?${noPlaceholders(s.attachedNote)}` }], this.actionsAfter),
    ];
  }

  private renderClaude(): void {
    const s = this.selected === undefined ? undefined : this.sessions[this.selected];
    const c = this.claudeView;
    const agents = s?.agents ?? 0;
    const rows: [string, string | undefined][] = [
      ["Title", c?.title],
      ["Session", c?.name],
      ["Waiting for", c?.waitingFor],
      ["Sub-agents", agents > 0 ? `${agents} running` : undefined],
      ["Context", c?.contextTokens ? `${formatTokens(c.contextTokens)} tokens${c.model ? ` · ${c.model}` : ""}` : undefined],
      ["Last prompt", c?.lastPrompt],
      ["Last message", c?.lastMessage],
    ];
    const shown = s?.claude ? rows.filter((r): r is [string, string] => !!r[1]) : [];
    this.claude.hidden = shown.length === 0;
    const key = JSON.stringify(shown);
    if (this.claude.dataset.key === key) return;
    this.claude.dataset.key = key;
    const dl = el("dl");
    for (const [k, v] of shown) dl.append(el("dt", { text: k }), el("dd", { text: v }));
    this.claude.replaceChildren(dl);
  }

  private toggleRename(): void {
    if (!this.renameForm.hidden) return this.closeRename();
    const s = this.selected === undefined ? undefined : this.sessions[this.selected];
    if (!s) return;
    this.renameForm.hidden = false;
    this.renameNote.hidden = true;
    this.renameInput.value = s.name;
    this.renameInput.focus();
    this.renameInput.select();
  }

  private closeRename(): void {
    this.renameForm.hidden = true;
  }

  private note(text: string, error: boolean): void {
    this.renameNote.textContent = text;
    this.renameNote.dataset.error = String(error);
    this.renameNote.hidden = false;
  }

  private async submitRename(): Promise<void> {
    const id = this.selected;
    if (id === undefined || !this.ctx) return;
    const wanted = this.renameInput.value;
    try {
      const r = (await this.ctx.action("rename", { id, name: wanted })) as { name: string };
      this.closeRename();
      if (r.name !== wanted.trim()) this.note(`tmux named it '${r.name}': it turns ":" and "." into "_".`, false);
      else this.renameNote.hidden = true;
    } catch (e) {
      this.note((e as Error).message, true);
    }
  }

  // ---- preview ----

  private stopView(): void {
    if (this.viewTimer !== undefined) clearTimeout(this.viewTimer);
    this.viewTimer = undefined;
  }

  private refreshSoon(ms: number): void {
    this.stopView();
    if (this.local === false || document.visibilityState !== "visible") return;
    this.viewTimer = setTimeout(() => void this.refreshView(), ms);
  }

  private async refreshView(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    const seq = ++this.viewSeq;
    const id = this.selected;
    try {
      const r = (await ctx.action("view", id === undefined ? {} : { id })) as unknown as ViewResult;
      if (seq !== this.viewSeq) return;
      if (this.local !== true) {
        this.local = true;
        this.actionsKey = "";
      }
      this.applyView(r, id);
      this.screenNote.hidden = true;
    } catch (e) {
      if (seq !== this.viewSeq) return;
      if ((e as { code?: number }).code === LOCAL_ONLY) {
        this.local = false;
        this.actionsKey = "";
        this.screen.hidden = true;
        this.screenNote.textContent = "Screen contents and Claude's messages are shown only on this computer.";
        this.screenNote.hidden = false;
        this.renderSelected();
        return;
      }
      this.screenNote.textContent = `Can't read the screen: ${(e as Error).message}`;
      this.screenNote.hidden = false;
    }
    this.refreshSoon(VIEW_MS);
  }

  private applyView(r: ViewResult, id: string | undefined): void {
    this.extras = r.rows ?? {};
    for (const key of Object.keys(this.sessions)) this.updateRow(key);
    if (id !== this.selected) return;
    const sel = r.selected;
    this.claudeView = sel?.claude;
    if (sel?.text !== undefined) this.showScreen(sel.text, sel.cols ?? 0);
    this.renderSelected();
  }

  private showScreen(text: string, cols: number): void {
    if (cols !== this.cols) {
      this.cols = cols;
      this.fitScreen();
    }
    if (text === this.shownText) return;
    this.shownText = text;
    const box = this.screen;
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
    const frag = document.createDocumentFragment();
    for (const line of parseAnsi(text)) {
      for (const run of line) {
        if (!run.fg && !run.bg && !run.bold && !run.dim && !run.italic && !run.underline && !run.strike) {
          frag.append(run.text);
          continue;
        }
        const span = el("span", { text: run.text });
        if (run.fg) span.style.color = run.fg;
        if (run.bg) span.style.background = run.bg;
        if (run.bold) span.style.fontWeight = "700";
        if (run.dim) span.style.opacity = "0.65";
        if (run.italic) span.style.fontStyle = "italic";
        if (run.underline || run.strike) span.style.textDecoration = `${run.underline ? "underline" : ""} ${run.strike ? "line-through" : ""}`.trim();
        frag.append(span);
      }
      frag.append("\n");
    }
    box.replaceChildren(frag);
    if (stick) box.scrollTop = box.scrollHeight;
  }

  private fitScreen(): void {
    const style = getComputedStyle(this.screen);
    const inner = this.screen.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    this.screen.style.fontSize = `${previewFontPx(inner, this.cols)}px`;
  }
}
