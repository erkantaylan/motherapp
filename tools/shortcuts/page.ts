/// <reference lib="dom" />
// The shortcuts tool's custom page (a light-DOM custom element, docs/extension-contract.md § 6).
// A form to add or edit a motherapp shortcut (suggested command, name, command, key capture,
// live conflict warnings), then the shared groups (a "Group: " prefix used by motherapp's own
// and others' shortcuts, #27), the motherapp shortcuts and the read-only rest, all in
// collapsible groups (src/groups.ts; which groups are open is remembered per browser). Styled
// with the documented theme variables plus Bootstrap 6 badges. Remove buttons come from
// ctx.render, so they get the shell's confirm dialog and status dot.
import type { JsonValue } from "@motherapp/protocol";
import type { PageContext } from "@motherapp/protocol/page";
import { accelLabel, bindingProblem, bindingWarning, captureKey } from "./src/accel.ts";
import { commandFromLine } from "./src/command.ts";
import { conflictsFor } from "./src/conflicts.ts";
import type { BindingUse } from "./src/conflicts.ts";
import { COLLAPSE_AT, groupProblem, joinableGroups, layoutShortcuts, plural, splitPrefix } from "./src/groups.ts";
import type { Entry, Group } from "./src/groups.ts";

interface Row {
  id: string;
  path: string;
  name: string;
  command: string;
  binding: string;
  label: string;
  owned: boolean;
  order: number;
  conflicts: string;
  missing: string;
  error: string;
}

interface Suggestion {
  tool: string;
  toolTitle: string;
  bin: string;
  title: string;
  command: string;
  installed: boolean;
}

interface LayoutMap {
  get(code: string): string | undefined;
}

const STYLE = `
.msc { display: grid; gap: 16px; color: var(--fg); max-width: 960px; }
.msc-card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; min-width: 0; }
.msc h3 { margin: 0 0 8px; font-size: 1rem; }
.msc p { margin: 4px 0; }
.msc label { display: block; margin: 10px 0 4px; font-size: 0.9em; color: var(--muted); }
.msc input, .msc select { width: 100%; box-sizing: border-box; padding: 6px 8px; border: 1px solid var(--border);
  border-radius: 6px; background: var(--bg); color: var(--fg); font: inherit; min-width: 0; }
.msc input:focus, .msc select:focus, .msc-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.msc .msc-mono, .msc code, .msc kbd { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.msc code { font-size: 0.85em; word-break: break-all; }
.msc kbd { border: 1px solid var(--border); border-bottom-width: 2px; border-radius: 4px; padding: 0 6px; background: var(--bg); color: var(--fg);
  font-size: 0.85em; white-space: nowrap; }
.msc-btn { padding: 6px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: var(--fg);
  cursor: pointer; font: inherit; white-space: nowrap; }
.msc-btn:hover { border-color: var(--accent); }
.msc-btn:disabled { opacity: 0.5; cursor: default; }
.msc-btn.msc-primary { background: var(--accent); border-color: var(--accent); color: var(--bg); }
.msc-btn.msc-recording { border-color: var(--warn); outline: 2px solid var(--warn); }
.msc-keyrow, .msc-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.msc-keyrow input { flex: 1 1 12em; }
.msc-actions { margin-top: 12px; }
.msc-preview { margin-top: 4px; font-size: 0.9em; color: var(--muted); }
.msc-notes { margin: 8px 0 0; padding-left: 18px; }
.msc-notes:empty { display: none; }
.msc-warn { color: var(--warn); }
.msc-err { color: var(--err); }
.msc-ok { color: var(--ok); }
.msc-muted { color: var(--muted); font-size: 0.9em; }
.msc-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; padding: 8px 0; border-top: 1px solid var(--border); }
.msc-row:first-of-type { border-top: 0; }
.msc-name { font-weight: 600; }
.msc-row .msc-grow { flex: 1 1 auto; }
.msc-row .msc-full { flex: 1 1 100%; min-width: 0; }
.msc-row .msc-buttons { display: flex; gap: 8px; align-items: center; }
.msc-stale { opacity: 0.6; }
.msc-group { border-top: 1px solid var(--border); }
.msc-group:first-child { border-top: 0; }
.msc-group-head { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; width: 100%; padding: 8px 4px; margin: 0;
  border: 0; border-radius: 6px; background: none; color: var(--fg); font: inherit; text-align: start; cursor: pointer; }
.msc-group-head:hover { background: var(--bg); }
.msc-group-head:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.msc-caret { display: inline-block; width: 1em; color: var(--muted); }
.msc-group-keys { color: var(--muted); font-size: 0.85em; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.msc-group-head[aria-expanded="true"] .msc-group-conflicts { display: none; }
.msc-group-body { padding-left: 1.5em; }
.msc-group-body > .msc-row { border-top-style: dashed; }
.msc-group-body > .msc-row:first-of-type { border-top: 1px dashed var(--border); }
`;

/** localStorage key: which groups the viewer opened or closed ({ "own:audio": true, … }). */
const OPEN_KEY = "motherapp.shortcuts.openGroups";

function loadOpen(): Record<string, boolean> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(OPEN_KEY) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function saveOpen(v: Record<string, boolean>): void {
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify(v));
  } catch {
    // a private window or blocked storage: the choice just isn't remembered
  }
}

/** Braces in user text would be read as {placeholders} by the confirm template. */
const noPlaceholders = (s: string) => s.replace(/\{/g, "{​");

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: { class?: string; text?: string } = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (props.class) e.className = props.class;
  if (props.text !== undefined) e.textContent = props.text;
  e.append(...kids);
  return e;
}

function button(label: string, cls = ""): HTMLButtonElement {
  const b = el("button", { class: `msc-btn ${cls}`.trim(), text: label });
  b.type = "button";
  return b;
}

const asMap = <T>(v: JsonValue | undefined): Record<string, T> => (v && typeof v === "object" && !Array.isArray(v) ? (v as unknown as Record<string, T>) : {});

export default class ShortcutsPage extends HTMLElement {
  ctx?: PageContext;
  private off: (() => void)[] = [];
  private rowCleanups: (() => void)[] = [];
  private layout: LayoutMap | undefined;
  private editing: string | undefined;
  private recording = false;
  private chosen: Suggestion | undefined;
  private open = loadOpen();

  private root = el("div", { class: "msc" });
  private status = el("p", { class: "msc-err" });
  private formTitle = el("h3", { text: "Add a shortcut" });
  private suggest = el("select");
  private group = el("input");
  private groupList = el("datalist");
  private name = el("input");
  private command = el("input", { class: "msc-mono" });
  private preview = el("div", { class: "msc-preview" });
  private accel = el("input", { class: "msc-mono" });
  private record = button("Record keys");
  private captureHint = el("p", { class: "msc-muted" });
  private notes = el("ul", { class: "msc-notes" });
  private submit = button("Add shortcut", "msc-primary");
  private cancel = button("Cancel");
  private result = el("span");
  private shared = el("div");
  private sharedCard = el("section", { class: "msc-card" });
  private owned = el("div");
  private foreign = el("div");

  connectedCallback(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const kb = (navigator as unknown as { keyboard?: { getLayoutMap?: () => Promise<LayoutMap> } }).keyboard;
    kb?.getLayoutMap?.().then((m) => (this.layout = m)).catch(() => {});

    this.name.placeholder = "Mute Firefox";
    this.group.placeholder = "None";
    this.groupList.id = "msc-group-names";
    this.group.setAttribute("list", this.groupList.id);
    this.group.autocomplete = "off";
    this.command.placeholder = "audioctl app-mute firefox toggle";
    this.command.spellcheck = false;
    this.accel.placeholder = "<Control><Shift>F9";
    this.accel.spellcheck = false;
    for (const [input, label] of [
      [this.suggest, "Suggested command"],
      [this.name, "Name"],
      [this.group, "Group"],
      [this.command, "Command"],
      [this.accel, "Key combination"],
    ] as const) {
      input.id = `msc-${label.toLowerCase().replace(/\s+/g, "-")}`;
    }
    const label = (text: string, input: HTMLElement) => {
      const l = el("label", { text });
      l.htmlFor = input.id;
      return l;
    };
    this.cancel.hidden = true;
    this.captureHint.textContent = "Record, then press the keys. Esc cancels. Keys GNOME or the browser already use (an existing shortcut, Super+A, Ctrl+W) may never reach the page: type those instead.";

    const form = el(
      "section",
      { class: "msc-card" },
      this.formTitle,
      label("Suggested command", this.suggest),
      this.suggest,
      label("Name", this.name),
      this.name,
      label("Group (optional)", this.group),
      this.group,
      this.groupList,
      el("div", { class: "msc-preview", text: 'Saved in the name as "Group: name", so GNOME Settings shows it too.' }),
      label("Command", this.command),
      this.command,
      this.preview,
      label("Key combination", this.accel),
      el("div", { class: "msc-keyrow" }, this.accel, this.record),
      this.captureHint,
      this.notes,
      el("div", { class: "msc-actions" }, this.submit, this.cancel, this.result),
    );
    this.sharedCard.append(
      el("h3", { text: "Shared groups" }),
      el("p", { class: "msc-muted", text: "Groups whose name prefix is used both by motherapp shortcuts and by ones made elsewhere. Rows marked motherapp can be edited; the others are read-only." }),
      this.shared,
    );
    this.sharedCard.hidden = true;
    const ownedCard = el("section", { class: "msc-card" }, el("h3", { text: "motherapp shortcuts" }), this.owned);
    const foreignCard = el(
      "section",
      { class: "msc-card" },
      el("h3", { text: "Other custom shortcuts" }),
      el("p", { class: "msc-muted", text: "Made outside motherapp, for example in GNOME Settings. They are read-only here; motherapp never changes them." }),
      this.foreign,
    );
    const style = el("style", { text: STYLE });
    this.status.hidden = true;
    this.root.append(style, this.status, form, this.sharedCard, ownedCard, foreignCard);
    this.append(this.root);

    this.suggest.addEventListener("change", () => this.pickSuggestion());
    for (const i of [this.name, this.group, this.command, this.accel]) i.addEventListener("input", () => this.validate());
    this.record.addEventListener("click", () => (this.recording ? this.stopRecording() : this.startRecording()));
    this.record.addEventListener("keydown", (e) => this.onKey(e));
    this.record.addEventListener("blur", () => this.stopRecording());
    this.submit.addEventListener("click", () => void this.save());
    this.cancel.addEventListener("click", () => this.resetForm());

    this.off.push(ctx.subscribe("shortcuts", () => this.renderRows()));
    this.off.push(ctx.subscribe("suggestions", () => this.renderSuggestions()));
    this.off.push(ctx.subscribe("bindings", () => this.validate()));
    this.off.push(ctx.subscribe("binDir", () => this.validate()));
    this.off.push(
      ctx.subscribe("status", (v) => {
        this.status.textContent = typeof v === "string" ? v : "";
        this.status.hidden = typeof v !== "string";
      }),
    );
  }

  disconnectedCallback(): void {
    this.off.forEach((f) => f());
    this.off = [];
    this.rowCleanups.forEach((f) => f());
    this.rowCleanups = [];
    this.replaceChildren();
    this.root.replaceChildren();
  }

  // ---- suggestions ----

  private suggestions(): Record<string, Suggestion> {
    return asMap<Suggestion>(this.ctx!.get("suggestions"));
  }

  private renderSuggestions(): void {
    const keep = this.suggest.value;
    this.suggest.replaceChildren(new Option("Type your own command", ""));
    const groups = new Map<string, HTMLOptGroupElement>();
    for (const [key, s] of Object.entries(this.suggestions())) {
      let g = groups.get(s.toolTitle);
      if (!g) {
        g = el("optgroup");
        g.label = s.toolTitle;
        groups.set(s.toolTitle, g);
        this.suggest.append(g);
      }
      g.append(new Option(`${s.title}${s.installed ? "" : " (not installed)"}`, key));
    }
    this.suggest.value = keep;
    if (this.suggest.value !== keep) this.suggest.value = "";
  }

  private pickSuggestion(): void {
    const prev = this.chosen;
    const s = this.suggestions()[this.suggest.value];
    this.chosen = s;
    if (!s) {
      this.validate();
      return;
    }
    if (this.name.value.trim() === "" || (prev && this.name.value === prev.title)) this.name.value = s.title;
    this.command.value = s.command;
    this.validate();
    if (this.accel.value.trim() === "") this.record.focus();
  }

  // ---- key capture ----

  private startRecording(): void {
    this.recording = true;
    this.record.classList.add("msc-recording");
    this.record.textContent = "Press keys…";
    this.record.focus();
  }

  private stopRecording(): void {
    if (!this.recording) return;
    this.recording = false;
    this.record.classList.remove("msc-recording");
    this.record.textContent = "Record keys";
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.recording) return;
    e.preventDefault();
    e.stopPropagation();
    const r = captureKey(e, this.layout?.get(e.code));
    if (r.kind === "pending") {
      this.record.textContent = r.label;
      return;
    }
    if (r.kind === "cancel") return this.stopRecording();
    if (r.kind === "error") {
      this.result.className = "msc-err";
      this.result.textContent = r.message;
      return this.stopRecording();
    }
    this.accel.value = r.accel;
    this.result.textContent = "";
    this.stopRecording();
    this.validate();
  }

  // ---- form ----

  private commandPreview(): { command?: string; error?: string } {
    const ctx = this.ctx!;
    const text = this.command.value.trim();
    if (text === "") return {};
    const bins = ctx.get("bins");
    try {
      return {
        command: commandFromLine(text, {
          binDir: String(ctx.get("binDir") ?? ""),
          home: String(ctx.get("home") ?? ""),
          bins: new Set(Array.isArray(bins) ? bins.map(String) : []),
        }),
      };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  /** Updates the preview and the notes; returns whether the form can be saved. */
  private validate(): boolean {
    const ctx = this.ctx;
    if (!ctx) return false;
    const notes: [string, string][] = [];
    const p = this.commandPreview();
    this.preview.replaceChildren();
    if (p.command) this.preview.append("GNOME will run: ", el("code", { text: p.command }));
    if (p.error) notes.push(["msc-err", p.error]);
    const gp = groupProblem(this.group.value);
    if (gp) notes.push(["msc-err", gp]);
    const binding = this.accel.value.trim();
    if (binding) {
      const problem = bindingProblem(binding);
      if (problem) notes.push(["msc-err", problem]);
      else {
        const uses = (ctx.get("bindings") as unknown as BindingUse[] | undefined) ?? [];
        const c = conflictsFor(binding, Array.isArray(uses) ? uses : [], this.editing);
        if (c.length) notes.push(["msc-warn", `${accelLabel(binding)} is already used by ${c.join(", ")}. Both may react, or only one.`]);
        const w = bindingWarning(binding);
        if (w) notes.push(["msc-warn", w]);
      }
    }
    if (this.chosen && !this.chosen.installed && this.command.value === this.chosen.command) {
      notes.push(["msc-warn", `${this.chosen.bin} isn't installed in ${String(ctx.get("binDir"))} yet: run ./install.sh.`]);
    }
    this.notes.replaceChildren(...notes.map(([cls, text]) => el("li", { class: cls, text })));
    const ok = this.name.value.trim() !== "" && !gp && !!p.command && binding !== "" && !bindingProblem(binding);
    this.submit.disabled = !ok;
    return ok;
  }

  private resetForm(): void {
    this.editing = undefined;
    this.chosen = undefined;
    this.formTitle.textContent = "Add a shortcut";
    this.submit.textContent = "Add shortcut";
    this.cancel.hidden = true;
    this.suggest.disabled = false;
    this.suggest.value = "";
    this.name.value = "";
    this.group.value = "";
    this.command.value = "";
    this.accel.value = "";
    this.fillGroupList();
    this.validate();
  }

  private startEdit(id: string, row: Row): void {
    this.editing = id;
    this.chosen = undefined;
    this.formTitle.textContent = `Edit '${row.name}'`;
    this.submit.textContent = "Save changes";
    this.cancel.hidden = false;
    this.suggest.value = "";
    const pre = splitPrefix(row.name);
    this.group.value = pre?.group ?? "";
    this.name.value = pre?.rest ?? row.name;
    this.command.value = row.command;
    this.accel.value = row.binding;
    this.result.textContent = "";
    this.fillGroupList();
    this.validate();
    this.name.focus();
  }

  private async save(): Promise<void> {
    const ctx = this.ctx!;
    if (!this.validate()) return;
    this.submit.disabled = true;
    this.result.className = "msc-muted";
    this.result.textContent = "Saving…";
    try {
      let r: JsonValue;
      if (this.editing) {
        const row = asMap<Row>(ctx.get("shortcuts"))[this.editing];
        // The group always goes along, so emptying the field takes the shortcut out of its group.
        const args: Record<string, string> = { id: this.editing, name: this.name.value, group: this.group.value, binding: this.accel.value.trim() };
        if (!row || this.command.value !== row.command) args.command = this.command.value;
        r = await ctx.action("edit", args);
      } else {
        const args: Record<string, string> = { name: this.name.value, binding: this.accel.value.trim(), command: this.command.value };
        if (this.group.value.trim()) args.group = this.group.value;
        r = await ctx.action("add", args);
      }
      const warnings = (r as { warnings?: string[] } | null)?.warnings ?? [];
      const what = this.editing ? "Saved." : "Added. Press the keys to try it.";
      this.resetForm();
      this.result.className = warnings.length ? "msc-warn" : "msc-ok";
      this.result.textContent = [what, ...warnings].join(" ");
    } catch (e) {
      this.result.className = "msc-err";
      this.result.textContent = (e as Error).message;
      this.validate();
    }
  }

  // ---- lists ----

  private renderRows(): void {
    const ctx = this.ctx!;
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.group;
    this.rowCleanups.forEach((f) => f());
    this.rowCleanups = [];
    const rows = Object.entries(asMap<Row>(ctx.get("shortcuts"))).map(([id, r]) => ({ ...r, id }));
    const binTools = asMap<string>(ctx.get("binTools"));
    const stale = ctx.isStale("shortcuts");
    for (const d of [this.shared, this.owned, this.foreign]) d.classList.toggle("msc-stale", stale);
    const { shared, own: mine, other: theirs } = layoutShortcuts(rows, binTools);
    this.sharedCard.hidden = shared.length === 0;
    this.shared.replaceChildren(...shared.map((g) => this.entry("shared", g, (r, label) => (r.owned ? this.ownedRow(r.id, r, label, true) : this.foreignRow(r, label)))));
    // "None yet" only when there are none at all, not when the only ones sit in a shared group
    const ownedShared = shared.some((g) => g.members.some((m) => m.item.owned));
    this.owned.replaceChildren(...(mine.length ? mine.map((e) => this.entry("own", e, (r, label) => this.ownedRow(r.id, r, label))) : [el("p", { class: "msc-muted", text: ownedShared ? "No others; see Shared groups above." : "None yet. Add one above." })]));
    this.foreign.replaceChildren(...(theirs.length ? theirs.map((e) => this.entry("other", e, (r, label) => this.foreignRow(r, label))) : [el("p", { class: "msc-muted", text: shared.length ? "No others; see Shared groups above." : "None." })]));
    this.fillGroupList(rows);
    if (focused) this.querySelector<HTMLElement>(`[data-group="${CSS.escape(focused)}"]`)?.focus();
    if (this.editing && !rows.some((r) => r.owned && r.id === this.editing)) this.resetForm();
    else this.validate();
  }

  /** The Group field's suggestions: only prefixes a new or edited shortcut would really join. */
  private fillGroupList(rows?: Row[]): void {
    const all = rows ?? Object.entries(asMap<Row>(this.ctx!.get("shortcuts"))).map(([id, r]) => ({ ...r, id }));
    this.groupList.replaceChildren(...joinableGroups(all, this.editing).map((n) => new Option(n)));
  }

  private entry(card: string, e: Entry<Row>, row: (r: Row, label: string) => HTMLElement): HTMLElement {
    return e.kind === "single" ? row(e.item, e.label) : this.groupEl(`${card}:${e.key}`, e, row);
  }

  private groupEl(key: string, g: Group<Row>, row: (r: Row, label: string) => HTMLElement): HTMLElement {
    const head = el("button", { class: "msc-group-head" });
    head.type = "button";
    head.dataset.group = key;
    const body = el("div", { class: "msc-group-body" }, ...g.members.map((m) => row(m.item, m.label)));
    body.id = `msc-g-${key.replace(/[^a-z0-9_-]/gi, (c) => `_${c.codePointAt(0)!.toString(16)}`)}`;
    body.setAttribute("role", "group");
    body.setAttribute("aria-label", g.name);
    head.setAttribute("aria-controls", body.id);
    const count = el("span", { class: "badge badge-subtle theme-secondary", text: plural(g.members.length, "shortcut") });
    const keys = el("span", { class: "msc-group-keys", text: g.keys });
    const caret = el("span", { class: "msc-caret" });
    caret.setAttribute("aria-hidden", "true");
    const parts: HTMLElement[] = [caret, el("span", { class: "msc-name", text: g.name }), count, keys];
    if (g.conflicts) parts.push(el("span", { class: "msc-group-conflicts badge badge-subtle theme-warning", text: plural(g.conflicts, "conflict") }));
    head.append(...parts);
    const set = (open: boolean) => {
      head.setAttribute("aria-expanded", String(open));
      caret.textContent = open ? "▾" : "▸";
      body.hidden = !open;
    };
    set(this.open[key] ?? g.members.length < COLLAPSE_AT);
    head.addEventListener("click", () => {
      const open = head.getAttribute("aria-expanded") !== "true";
      set(open);
      this.open[key] = open;
      saveOpen(this.open);
    });
    return el("div", { class: "msc-group" }, head, body);
  }

  private common(r: Row, label = r.name): HTMLElement[] {
    const name = el("span", { class: "msc-name", text: label || "(no name)" });
    if (label !== r.name) name.title = r.name;
    const out: HTMLElement[] = [name, el("kbd", { text: r.label, class: "" })];
    out[1]!.title = r.binding;
    const full: HTMLElement[] = [el("code", { text: r.command || "(no command)" })];
    if (r.error) full.push(el("div", { class: "msc-err", text: `Can't read this entry: ${r.error}` }));
    if (r.conflicts) full.push(el("div", { class: "msc-warn", text: r.conflicts }));
    if (r.missing) full.push(el("div", { class: "msc-warn", text: r.missing }));
    return [...out, el("span", { class: "msc-grow" }), el("div", { class: "msc-full" }, ...full)];
  }

  private ownedRow(id: string, r: Row, label?: string, mark = false): HTMLElement {
    const edit = button("Edit");
    edit.addEventListener("click", () => this.startEdit(id, r));
    const remove = el("span");
    this.rowCleanups.push(
      this.ctx!.render(
        [
          {
            type: "button",
            label: "Remove",
            action: "remove",
            args: { id },
            confirm: `Remove the shortcut '${noPlaceholders(r.name)}' (${noPlaceholders(r.label)})? GNOME stops reacting to the key right away.`,
          },
        ],
        remove,
      ),
    );
    const [name, kbd, grow, full] = this.common(r, label);
    // In a shared group, tell motherapp's own rows from the read-only ones at a glance.
    const badge = mark ? [el("span", { class: "badge badge-subtle theme-primary", text: "motherapp" })] : [];
    return el("div", { class: "msc-row" }, name!, ...badge, kbd!, grow!, el("span", { class: "msc-buttons" }, edit, remove), full!);
  }

  private foreignRow(r: Row, label?: string): HTMLElement {
    const [name, kbd, grow, full] = this.common(r, label);
    return el("div", { class: "msc-row" }, name!, kbd!, grow!, el("span", { class: "msc-muted", text: "read-only" }), full!);
  }
}
