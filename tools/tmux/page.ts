/// <reference lib="dom" />
// The tmux tool's custom page (a light-DOM custom element, docs/extension-contract.md § 6): the
// session list on one side, a large live preview of the selected session on the other, stacked
// on a narrow screen. List, state and timeline come from state, which the tool keeps current all
// the time. The preview and Claude's text come from the `view` action, asked for only while this
// tab is visible and only for the selected session, and scrollback from `history`, only when
// asked. All three are local only with `open`: the core refuses them on a LAN connection, and then
// this page drops the preview and the Open button.
//
// Scrolling: a live refresh only touches the screen while the user is at its bottom. Scrolled up,
// or looking at history, what they read stays where it is until they go back.
//
// Everything from a pane or a transcript goes in through textContent and style properties, never
// as HTML. Shared logic is in ./src/view.ts and ./src/ansi.ts, which import nothing.
import type { JsonValue } from "@motherapp/protocol";
import type { PageContext } from "@motherapp/protocol/page";
import { DEFAULT_BG, DEFAULT_FG, parseAnsi } from "./src/ansi.ts";
import { formatElapsed, formatTokens, previewFontPx, summaryText, timelineBars, timelineText } from "./src/view.ts";

interface Row {
  id: string;
  name: string;
  created: number;
  detail: string;
  where: string;
  command: string;
  path: string;
  attachedNote: string;
  state: string;
  claude: boolean;
  timeline: string;
  /** Sub-agents running now; absent at 0. */
  agents?: number;
  /** Whole days without output, on a session at rest; absent under the threshold. */
  staleDays?: number;
  project: string;
  projectPath: string;
  /** Absent outside a repo. */
  branch?: string;
  changes?: number;
}

interface ListExtra {
  title?: string;
  contextTokens?: number;
}

interface AgentView {
  description: string;
  type: string;
  startedAt: number;
}

interface ClaudeView extends ListExtra {
  lastPrompt?: string;
  lastMessage?: string;
  /** The folder Claude works in, which can differ from the pane's. */
  cwd?: string;
  model?: string;
  name?: string;
  waitingFor?: string;
  agents?: AgentView[];
}

interface HistoryResult {
  source: "tmux" | "transcript";
  text: string;
  cut: boolean;
  cols: number;
}

interface ViewResult {
  rows: Record<string, ListExtra>;
  selected?: { id: string; text?: string; cols?: number; claude?: ClaudeView };
}

/** ErrorCode.LocalOnly. A bare import doesn't resolve in the browser, so it's spelled out. */
const LOCAL_ONLY = -32004;
const VIEW_MS = 1500;
const WIDE_PX = 820;
const PICKED_KEY = "motherapp.tmux.picked";
/** Within this of the bottom counts as at the bottom. */
const BOTTOM_PX = 24;
const TRANSCRIPT_FONT_PX = 13;

const STYLE = `
.mtx { display: grid; gap: 12px; color: var(--fg); container-type: inline-size; min-width: 0; }
/* One line that never changes height: a strip that grew would push the list from under the pointer. */
.mtx-bar { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 10px; min-height: 36px; background: var(--bg); min-width: 0; }
.mtx-summary { margin: 0; flex: none; color: var(--muted); font-size: 0.9rem; }
.mtx-needs { display: flex; align-items: center; gap: 6px; min-width: 0; overflow-x: auto; scrollbar-width: none; }
.mtx-needs[hidden] { display: none; }
.mtx-needs-label { flex: none; font-size: 0.8125rem; font-weight: 600; }
.mtx-need { flex: none; display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; font: inherit; font-size: 0.875rem; color: var(--fg); cursor: pointer;
  background: var(--surface); border: 1px solid var(--warn); border-radius: 999px; }
.mtx-need:hover { background: var(--bg); }
.mtx-need:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.mtx-need .mtx-dot { background: var(--warn); border-color: var(--warn); }
.mtx-grid { display: grid; gap: 16px; grid-template-columns: minmax(0, 1fr); }
@container (min-width: ${WIDE_PX}px) {
  .mtx-grid { grid-template-columns: minmax(280px, 340px) minmax(0, 1fr); align-items: start; }
  .mtx-list { position: sticky; top: 44px; max-height: calc(100vh - 60px); overflow-y: auto; }
}
.mtx-list { display: grid; gap: 6px; min-width: 0; align-content: start; }
.mtx-list[data-stale="true"] { opacity: 0.6; }
.mtx-empty { color: var(--muted); padding: 12px; }
.mtx-group { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; padding: 6px 2px 0; font-size: 0.8125rem; color: var(--muted); min-width: 0; }
.mtx-group:first-child { padding-top: 0; }
.mtx-project { font-weight: 600; color: var(--fg); overflow-wrap: anywhere; min-width: 0; }
.mtx-branch { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.75rem; overflow-wrap: anywhere; min-width: 0; }
.mtx-changes { display: inline-flex; align-items: center; gap: 4px; }
.mtx-changes::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--warn); }
.mtx-changes[hidden] { display: none; }
.mtx-row { display: grid; gap: 3px; width: 100%; min-width: 0; padding: 8px 10px; text-align: start; font: inherit; color: var(--fg); cursor: pointer;
  background: var(--surface); border: 1px solid var(--border); border-radius: 8px; }
.mtx-row:hover { border-color: var(--accent); }
.mtx-row:focus-visible, .mtx-btn:focus-visible, .mtx-rename input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
.mtx-row[aria-current="true"] { border-color: var(--accent); }
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
.mtx-ai, .mtx-agents { flex: none; display: inline-flex; align-items: center; align-self: center; }
.mtx-agents { gap: 3px; font-size: 0.75rem; color: var(--muted); font-variant-numeric: tabular-nums; }
.mtx-ai[hidden], .mtx-agents[hidden], .mtx-path[hidden] { display: none; }
/* rtl moves the ellipsis to the start, so a long path keeps its end; the bdi keeps the text in order. */
.mtx-path { direction: rtl; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: 0.75rem; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.mtx-tip { position: relative; }
.mtx-top .mtx-state { padding: 4px; margin: -4px; align-self: center; }
.mtx-tip:hover::after { content: attr(data-tip); position: absolute; right: calc(100% + 6px); top: 50%; transform: translateY(-50%); z-index: 2; padding: 2px 8px; border-radius: 6px; background: var(--fg); color: var(--bg); font-size: 0.75rem; font-weight: 400; white-space: nowrap; pointer-events: none; }
.mtx-stale { flex: none; padding: 0 6px; font-size: 0.75rem; color: var(--muted); border: 1px dashed var(--muted); border-radius: 999px; white-space: nowrap; }
.mtx-stale[hidden] { display: none; }
.mtx-row[data-stale="true"] .mtx-name { color: var(--muted); }
.mtx-tl { display: block; width: 100%; height: 14px; color: var(--muted); }
.mtx-tl .base { stroke: var(--border); stroke-width: 1; }
.mtx-tl .busy { fill: var(--ok); }
.mtx-tl .wait { fill: var(--warn); }
.mtx-main { display: grid; gap: 10px; min-width: 0; scroll-margin-top: 44px; }
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
.mtx-screenbar { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; min-height: 32px; font-size: 0.8125rem; color: var(--muted); }
.mtx-screenbar[hidden], .mtx-screenbar button[hidden] { display: none; }
.mtx-screenbar span { flex: 1 1 12em; min-width: 0; }
.mtx-screenbar .mtx-btn { padding: 2px 10px; font-size: 0.8125rem; }
.mtx-screen { margin: 0; padding: 8px 10px; overflow: auto; max-height: 60vh; min-height: 120px; border-radius: 8px; border: 1px solid var(--border);
  background: ${DEFAULT_BG}; color: ${DEFAULT_FG}; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; line-height: 1.2; white-space: pre; tab-size: 8; }
.mtx-screen[data-wrap="true"] { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.35; }
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
const agentsText = (n: number) => `${n} sub-agent${n === 1 ? "" : "s"} running`;
const CLAUDE_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#d97757" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4M7.5 3.9l9 16.2M16.5 3.9l-9 16.2M3.9 7.5l16.2 9M20.1 7.5 3.9 16.5"/></svg>`;
const ROBOT_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v4"/><circle cx="12" cy="3" r="1"/><rect x="4" y="7" width="16" height="12" rx="3"/><path d="M9 12v1.5M15 12v1.5M9.5 16h5M2 12v3M22 12v3"/></svg>`;

/** The session the user last clicked, as `<id>@<created>`: tmux reuses ids after a server restart. */
function readPicked(): string | undefined {
  try {
    return localStorage.getItem(PICKED_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function savePicked(value: string): void {
  try {
    localStorage.setItem(PICKED_KEY, value);
  } catch {
    // only a convenience
  }
}

/** Keeps the keys and their order, and rewrites only what changed: a scrolled box stays put. */
function fillList(dl: HTMLElement, rows: [string, string][]): void {
  const dts = [...dl.querySelectorAll("dt")];
  if (dts.length !== rows.length || rows.some(([k], i) => dts[i]!.textContent !== k)) {
    dl.replaceChildren(...rows.flatMap(([k, v]) => [el("dt", { text: k }), el("dd", { text: v })]));
    return;
  }
  rows.forEach(([, v], i) => {
    const dd = dts[i]!.nextElementSibling!;
    if (dd.textContent !== v) dd.textContent = v;
  });
}

interface RowEls {
  root: HTMLButtonElement;
  name: HTMLElement;
  state: HTMLElement;
  claudeIcon: HTMLElement;
  agents: HTMLElement;
  agentCount: HTMLElement;
  path: HTMLElement;
  pathText: HTMLElement;
  sub: HTMLElement;
  chip: HTMLElement;
  stale: HTMLElement;
  update(encoded: string): void;
}

interface GroupEls {
  root: HTMLElement;
  name: HTMLElement;
  branch: HTMLElement;
  changes: HTMLElement;
}

export default class TmuxPage extends HTMLElement {
  ctx?: PageContext;
  private off: (() => void)[] = [];
  private sessions: Record<string, Row> = {};
  private extras: Record<string, ListExtra> = {};
  private rows = new Map<string, RowEls>();
  private groups = new Map<string, GroupEls>();
  private selected: string | undefined;
  /** Only a click is remembered; anything else follows the first row. */
  private picked: string | undefined = readPicked();
  private needsKey = "";
  /** Known after the first `view` answer. */
  private local: boolean | undefined;
  private viewTimer: ReturnType<typeof setTimeout> | undefined;
  private viewSeq = 0;
  private shownText: string | undefined;
  private cols = 0;
  /** The newest screen, shown once the user is back at the bottom. */
  private latest: string | undefined;
  /** False while the user has scrolled up. */
  private following = true;
  /** Set while showing scrollback: a snapshot, not refreshed. */
  private history: { result: HistoryResult; at: number } | undefined;
  private historyBusy = false;
  /** Stacked, the preview is below the list: go there, once its content is in and the page is tall enough. */
  private revealMain = false;
  private actionsKey = "";
  private actionsOff: (() => void)[] = [];
  private claudeView: ClaudeView | undefined;
  private resize: ResizeObserver | undefined;

  private root = el("div", { class: "mtx" });
  private summary = el("p", { class: "mtx-summary" });
  private needs = el("div", { class: "mtx-needs" });
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
  private screenBar = el("div", { class: "mtx-screenbar" });
  private screenStatus = el("span");
  private historyBtn = el("button", { class: "mtx-btn", text: "Scroll back" });
  private liveBtn = el("button", { class: "mtx-btn", text: "Back to live" });
  private screen = el("pre", { class: "mtx-screen" });
  private screenNote = el("p", { class: "mtx-note" });
  private claudeList = el("dl");
  private claude = el("div", { class: "mtx-card mtx-claude" }, this.claudeList);

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
    this.historyBtn.type = "button";
    this.liveBtn.type = "button";
    this.historyBtn.addEventListener("click", () => void this.loadHistory());
    this.liveBtn.addEventListener("click", () => this.backToLive());
    this.screenBar.append(this.screenStatus, this.historyBtn, this.liveBtn);
    this.screenBar.hidden = true;
    this.screen.addEventListener("scroll", () => this.onScroll());
    // A screen that fits its box has nothing to scroll, so no scroll event: the wheel asks for more.
    this.screen.addEventListener("wheel", (e) => {
      if (e.deltaY < 0 && this.screen.scrollTop <= 0 && !this.history) void this.loadHistory();
    }, { passive: true });
    this.main.append(el("div", { class: "mtx-card" }, head, actions, this.renameForm, this.renameNote), this.screenBar, this.screen, this.screenNote, this.claude);
    this.needs.hidden = true;
    this.root.append(el("div", { class: "mtx-bar" }, this.summary, this.needs), el("div", { class: "mtx-grid" }, this.list, this.main));
  }

  // ---- list ----

  /** Projects by name, sessions by name within one: the order on screen. */
  private ordered(): [string, string[]][] {
    const byProject = new Map<string, string[]>();
    for (const id of Object.keys(this.sessions)) {
      const key = this.sessions[id]!.projectPath ?? "";
      const ids = byProject.get(key);
      if (ids) ids.push(id);
      else byProject.set(key, [id]);
    }
    const name = (id: string) => this.sessions[id]!.name;
    const groups = [...byProject].map(([key, ids]): [string, string[]] => [key, ids.sort((a, b) => name(a).localeCompare(name(b)))]);
    const project = (ids: string[]) => this.sessions[ids[0]!]!.project ?? "";
    return groups.sort(([ka, a], [kb, b]) => project(a).localeCompare(project(b)) || ka.localeCompare(kb));
  }

  private pickedId(): string | undefined {
    return Object.keys(this.sessions).find((id) => `${id}@${this.sessions[id]!.created}` === this.picked);
  }

  private onSessions(v: JsonValue | undefined): void {
    // A row without a name isn't a session yet.
    this.sessions = Object.fromEntries(Object.entries(asRows(v)).filter(([, s]) => typeof s.name === "string"));
    const order = this.ordered();
    const wanted = this.pickedId() ?? order[0]?.[1][0];
    if (wanted !== this.selected) this.select(wanted, false);
    for (const [id, r] of this.rows) {
      if (this.sessions[id]) continue;
      r.root.remove();
      this.rows.delete(id);
    }
    for (const [key, g] of this.groups) {
      if (order.some(([k]) => k === key)) continue;
      g.root.remove();
      this.groups.delete(key);
    }
    const nodes: Element[] = [];
    for (const [key, ids] of order) {
      nodes.push(this.updateGroup(key, this.sessions[ids[0]!]!));
      for (const id of ids) {
        this.updateRow(id);
        nodes.push(this.rows.get(id)!.root);
      }
    }
    if (nodes.length === 0) this.list.replaceChildren(el("div", { class: "mtx-empty", text: "No tmux sessions." }));
    else if (nodes.some((e, i) => this.list.children[i] !== e) || this.list.children.length !== nodes.length) this.list.replaceChildren(...nodes);
    this.list.dataset.stale = String(this.ctx?.isStale("sessions") === true);
    this.renderSummary();
    this.renderNeeds();
    this.renderSelected();
  }

  private updateGroup(key: string, s: Row): HTMLElement {
    let g = this.groups.get(key);
    if (!g) {
      const name = el("span", { class: "mtx-project" });
      const branch = el("span", { class: "mtx-branch" });
      const changes = el("span", { class: "mtx-changes" });
      g = { root: el("div", { class: "mtx-group" }, name, branch, changes), name, branch, changes };
      this.groups.set(key, g);
    }
    g.root.title = s.projectPath ?? "";
    g.name.textContent = s.project ?? "";
    g.branch.textContent = s.branch ?? "";
    g.changes.textContent = s.changes ? `${s.changes} uncommitted` : "";
    g.changes.hidden = !s.changes;
    return g.root;
  }

  /** Sessions waiting on the user, beside the summary. Empty, it takes no room and shows nothing. */
  private renderNeeds(): void {
    const ids = this.ordered().flatMap(([, g]) => g).filter((id) => this.sessions[id]!.state === "waiting");
    const key = JSON.stringify(ids.map((id) => [id, this.sessions[id]!.name, this.extras[id]?.title]));
    if (key === this.needsKey) return;
    this.needsKey = key;
    this.needs.hidden = ids.length === 0;
    this.needs.replaceChildren(
      ...(ids.length ? [el("span", { class: "mtx-needs-label", text: "Needs you" })] : []),
      ...ids.map((id) => {
        const b = el("button", { class: "mtx-need" }, el("span", { class: "mtx-dot" }), this.sessions[id]!.name);
        b.type = "button";
        const title = this.extras[id]?.title;
        if (title) b.title = title;
        b.addEventListener("click", () => this.select(id, true));
        return b;
      }),
    );
  }

  private makeRow(id: string): RowEls {
    const name = el("span", { class: "mtx-name" });
    const dot = el("span", { class: "mtx-dot" });
    const state = el("span", { class: "mtx-state mtx-tip" }, dot);
    const claudeIcon = el("span", { class: "mtx-ai" });
    claudeIcon.innerHTML = CLAUDE_ICON;
    const robot = el("span", { class: "mtx-ai" });
    robot.innerHTML = ROBOT_ICON;
    const agentCount = el("span");
    const agents = el("span", { class: "mtx-agents mtx-tip" }, robot, agentCount);
    const pathText = el("bdi");
    const path = el("span", { class: "mtx-path" }, pathText);
    const sub = el("span", { class: "mtx-sub" });
    const chip = el("span", { class: "mtx-chip" });
    const stale = el("span", { class: "mtx-stale" });
    const tl = timeline();
    const root = el("button", { class: "mtx-row" }, el("span", { class: "mtx-top" }, claudeIcon, name, stale, state), el("span", { class: "mtx-mid" }, sub, agents, chip), path, tl.root);
    root.type = "button";
    root.addEventListener("click", () => this.select(id, true));
    return { root, name, state, claudeIcon, agents, agentCount, path, pathText, sub, chip, stale, update: tl.update };
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
    r.root.dataset.stale = String(s.staleDays !== undefined);
    r.stale.hidden = s.staleDays === undefined;
    r.stale.textContent = s.staleDays === undefined ? "" : `${s.staleDays} d idle`;
    r.root.setAttribute("aria-current", String(id === this.selected));
    r.name.textContent = s.name;
    r.name.title = s.name;
    r.state.dataset.tip = s.state;
    r.state.setAttribute("aria-label", s.state);
    r.claudeIcon.hidden = !s.claude;
    r.sub.textContent = (s.claude && extra?.title) || s.command || s.where;
    r.sub.title = r.sub.textContent;
    r.agents.hidden = !s.agents;
    r.agentCount.textContent = String(s.agents ?? "");
    r.agents.dataset.tip = s.agents ? agentsText(s.agents) : "";
    r.chip.textContent = s.claude && extra?.contextTokens ? formatTokens(extra.contextTokens) : "";
    r.path.hidden = !s.path;
    r.pathText.textContent = s.path;
    r.path.title = s.path;
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
    if (id !== undefined && byUser) {
      this.picked = `${id}@${this.sessions[id]!.created}`;
      savePicked(this.picked);
    }
    for (const [k, r] of this.rows) r.root.setAttribute("aria-current", String(k === id));
    if (changed) {
      this.resetScreen();
      this.claudeView = undefined;
      this.renderClaude();
      this.closeRename();
      this.renameNote.hidden = true;
    }
    this.renderSelected();
    this.refreshSoon(0);
    this.revealMain = byUser && this.root.clientWidth < WIDE_PX;
  }

  // ---- selected session ----

  private renderSelected(): void {
    const s = this.selected === undefined ? undefined : this.sessions[this.selected];
    this.main.hidden = !s;
    if (!s) return;
    this.heading.textContent = s.name;
    this.main.dataset.state = s.state;
    this.stateBox.replaceChildren(el("span", { class: "mtx-dot" }), s.state);
    const git = s.branch ? [`on ${s.branch}`, ...(s.changes ? [`${s.changes} uncommitted`] : [])] : [];
    const flag = s.staleDays !== undefined ? [`idle for ${s.staleDays} days`] : [];
    this.meta.textContent = [s.detail, ...git, ...flag].join(" · ");
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
    const named = c?.agents?.length ? c.agents.map((a) => `${a.description || "(no description)"} · ${a.type} · ${formatElapsed(Date.now() - a.startedAt)}`).join("\n") : undefined;
    const panePath: [string, string | undefined] = ["Pane path", s?.path];
    const rows: [string, string | undefined][] = [
      ["Title", c?.title],
      ["Session", c?.name],
      panePath,
      ["Claude folder", c?.cwd],
      ["Waiting for", c?.waitingFor],
      ["Sub-agents", named ?? (agents > 0 ? `${agents} running` : undefined)],
      ["Context", c?.contextTokens ? `${formatTokens(c.contextTokens)} tokens${c.model ? ` · ${c.model}` : ""}` : undefined],
      ["Last prompt", c?.lastPrompt],
      ["Last message", c?.lastMessage],
    ];
    const shown = (s?.claude ? rows : [panePath]).filter((r): r is [string, string] => !!r[1]);
    this.claude.hidden = shown.length === 0;
    fillList(this.claudeList, shown);
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
        this.screenBar.hidden = false;
        this.renderScreenBar();
      }
      this.applyView(r, id);
      this.screenNote.hidden = true;
    } catch (e) {
      if (seq !== this.viewSeq) return;
      if ((e as { code?: number }).code === LOCAL_ONLY) {
        this.local = false;
        this.actionsKey = "";
        this.screen.hidden = true;
        this.screenBar.hidden = true;
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
    this.renderNeeds();
    if (id !== this.selected) return;
    const sel = r.selected;
    this.claudeView = sel?.claude;
    if (sel?.text !== undefined) this.showScreen(sel.text, sel.cols ?? 0);
    this.renderSelected();
    if (this.revealMain) {
      this.revealMain = false;
      this.main.scrollIntoView({ block: "start" });
    }
  }

  private atBottom(): boolean {
    const box = this.screen;
    return box.scrollHeight - box.scrollTop - box.clientHeight < BOTTOM_PX;
  }

  private resetScreen(): void {
    this.shownText = undefined;
    this.latest = undefined;
    this.history = undefined;
    this.following = true;
    delete this.screen.dataset.wrap;
    this.screen.replaceChildren();
    this.renderScreenBar();
  }

  private onScroll(): void {
    const following = this.atBottom();
    if (following === this.following) return;
    this.following = following;
    if (following && !this.history && this.latest !== undefined) this.renderText(this.latest);
    this.renderScreenBar();
  }

  private showScreen(text: string, cols: number): void {
    this.latest = text;
    if (cols !== this.cols) {
      this.cols = cols;
      if (!this.history) this.fitScreen();
    }
    if (this.history || !this.following) {
      this.renderScreenBar();
      return;
    }
    this.renderText(text);
    this.screen.scrollTop = this.screen.scrollHeight;
  }

  private renderText(text: string): void {
    if (text === this.shownText) return;
    this.shownText = text;
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
    this.screen.replaceChildren(frag);
  }

  private async loadHistory(): Promise<void> {
    const id = this.selected;
    if (id === undefined || !this.ctx || this.historyBusy || this.history) return;
    this.historyBusy = true;
    this.renderScreenBar();
    const box = this.screen;
    const fromBottom = box.scrollHeight - box.scrollTop - box.clientHeight;
    try {
      const result = (await this.ctx.action("history", { id })) as unknown as HistoryResult;
      if (id !== this.selected) return;
      this.history = { result, at: Date.now() };
      const wrap = result.source === "transcript";
      if (wrap) box.dataset.wrap = "true";
      if (result.cols) this.cols = result.cols;
      this.fitScreen();
      this.renderText(result.text);
      // Scrollback ends in the same screen, so what was in view stays in view.
      box.scrollTop = wrap ? box.scrollHeight : box.scrollHeight - box.clientHeight - fromBottom;
    } catch (e) {
      this.screenNote.textContent = `Can't read the history: ${(e as Error).message}`;
      this.screenNote.hidden = false;
    } finally {
      this.historyBusy = false;
      this.renderScreenBar();
    }
  }

  private backToLive(): void {
    this.history = undefined;
    this.following = true;
    delete this.screen.dataset.wrap;
    this.shownText = undefined;
    this.fitScreen();
    if (this.latest !== undefined) this.renderText(this.latest);
    this.screen.scrollTop = this.screen.scrollHeight;
    this.renderScreenBar();
    this.refreshSoon(0);
  }

  private renderScreenBar(): void {
    const h = this.history;
    const paused = !h && !this.following;
    this.historyBtn.hidden = !!h;
    this.historyBtn.disabled = this.historyBusy;
    this.liveBtn.hidden = !h && !paused;
    let text = "Live";
    if (this.historyBusy) text = "Loading…";
    else if (h) {
      const at = new Date(h.at).toLocaleTimeString();
      const lines = h.result.text.split("\n").length - 1;
      const cut = h.result.cut ? ", older parts left out" : "";
      text = h.result.source === "transcript" ? `From Claude's transcript at ${at}${cut}: this pane keeps no scrollback` : `${lines} lines at ${at}${cut}`;
    } else if (paused) text = "Paused while scrolled up";
    this.screenStatus.textContent = text;
  }

  private fitScreen(): void {
    const style = getComputedStyle(this.screen);
    const inner = this.screen.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    this.screen.style.fontSize = this.screen.dataset.wrap ? `${TRANSCRIPT_FONT_PX}px` : `${previewFontPx(inner, this.cols)}px`;
  }
}
