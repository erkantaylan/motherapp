/// <reference lib="dom" />
// The shortcuts tool's custom page (a light-DOM custom element, docs/extension-contract.md § 6).
// A form to add or edit a motherapp shortcut (suggested command, name, command, key capture,
// live conflict warnings), then the motherapp shortcuts and the read-only rest. Styled only
// with the documented theme variables. Remove buttons come from ctx.render, so they get the
// shell's confirm dialog and status dot.
import type { JsonValue } from "@motherapp/protocol";
import type { PageContext } from "@motherapp/protocol/page";
import { accelLabel, bindingProblem, bindingWarning, captureKey } from "./src/accel.ts";
import { commandFromLine } from "./src/command.ts";
import { conflictsFor } from "./src/conflicts.ts";
import type { BindingUse } from "./src/conflicts.ts";

interface Row {
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
.msc kbd { border: 1px solid var(--border); border-bottom-width: 2px; border-radius: 4px; padding: 0 6px; background: var(--bg);
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
`;

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

  private root = el("div", { class: "msc" });
  private status = el("p", { class: "msc-err" });
  private formTitle = el("h3", { text: "Add a shortcut" });
  private suggest = el("select");
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
  private owned = el("div");
  private foreign = el("div");

  connectedCallback(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const kb = (navigator as unknown as { keyboard?: { getLayoutMap?: () => Promise<LayoutMap> } }).keyboard;
    kb?.getLayoutMap?.().then((m) => (this.layout = m)).catch(() => {});

    this.name.placeholder = "Mute Firefox";
    this.command.placeholder = "audioctl app-mute firefox toggle";
    this.command.spellcheck = false;
    this.accel.placeholder = "<Control><Shift>F9";
    this.accel.spellcheck = false;
    for (const [input, label] of [
      [this.suggest, "Suggested command"],
      [this.name, "Name"],
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
      label("Command", this.command),
      this.command,
      this.preview,
      label("Key combination", this.accel),
      el("div", { class: "msc-keyrow" }, this.accel, this.record),
      this.captureHint,
      this.notes,
      el("div", { class: "msc-actions" }, this.submit, this.cancel, this.result),
    );
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
    this.root.append(style, this.status, form, ownedCard, foreignCard);
    this.append(this.root);

    this.suggest.addEventListener("change", () => this.pickSuggestion());
    for (const i of [this.name, this.command, this.accel]) i.addEventListener("input", () => this.validate());
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
    const ok = this.name.value.trim() !== "" && !!p.command && binding !== "" && !bindingProblem(binding);
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
    this.command.value = "";
    this.accel.value = "";
    this.validate();
  }

  private startEdit(id: string, row: Row): void {
    this.editing = id;
    this.chosen = undefined;
    this.formTitle.textContent = `Edit '${row.name}'`;
    this.submit.textContent = "Save changes";
    this.cancel.hidden = false;
    this.suggest.value = "";
    this.name.value = row.name;
    this.command.value = row.command;
    this.accel.value = row.binding;
    this.result.textContent = "";
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
        const args: Record<string, string> = { id: this.editing, name: this.name.value, binding: this.accel.value.trim() };
        if (!row || this.command.value !== row.command) args.command = this.command.value;
        r = await ctx.action("edit", args);
      } else {
        r = await ctx.action("add", { name: this.name.value, binding: this.accel.value.trim(), command: this.command.value });
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
    this.rowCleanups.forEach((f) => f());
    this.rowCleanups = [];
    const rows = Object.entries(asMap<Row>(ctx.get("shortcuts"))).sort(([, a], [, b]) => a.order - b.order);
    const stale = ctx.isStale("shortcuts");
    this.owned.classList.toggle("msc-stale", stale);
    this.foreign.classList.toggle("msc-stale", stale);
    const mine = rows.filter(([, r]) => r.owned);
    const theirs = rows.filter(([, r]) => !r.owned);
    this.owned.replaceChildren(...(mine.length ? mine.map(([id, r]) => this.ownedRow(id, r)) : [el("p", { class: "msc-muted", text: "None yet. Add one above." })]));
    this.foreign.replaceChildren(...(theirs.length ? theirs.map(([, r]) => this.foreignRow(r)) : [el("p", { class: "msc-muted", text: "None." })]));
    if (this.editing && !mine.some(([id]) => id === this.editing)) this.resetForm();
    else this.validate();
  }

  private common(r: Row): HTMLElement[] {
    const out: HTMLElement[] = [el("span", { class: "msc-name", text: r.name || "(no name)" }), el("kbd", { text: r.label, class: "" })];
    out[1]!.title = r.binding;
    const full: HTMLElement[] = [el("code", { text: r.command || "(no command)" })];
    if (r.error) full.push(el("div", { class: "msc-err", text: `Can't read this entry: ${r.error}` }));
    if (r.conflicts) full.push(el("div", { class: "msc-warn", text: r.conflicts }));
    if (r.missing) full.push(el("div", { class: "msc-warn", text: r.missing }));
    return [...out, el("span", { class: "msc-grow" }), el("div", { class: "msc-full" }, ...full)];
  }

  private ownedRow(id: string, r: Row): HTMLElement {
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
    const [name, kbd, grow, full] = this.common(r);
    return el("div", { class: "msc-row" }, name!, kbd!, grow!, el("span", { class: "msc-buttons" }, edit, remove), full!);
  }

  private foreignRow(r: Row): HTMLElement {
    const [name, kbd, grow, full] = this.common(r);
    return el("div", { class: "msc-row" }, name!, kbd!, grow!, el("span", { class: "msc-muted", text: "read-only" }), full!);
  }
}
