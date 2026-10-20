/// <reference lib="dom" />
// The inbox tool's custom page (a light-DOM custom element, docs/extension-contract.md § 6):
// active links first (so a forgotten one is noticed) with their waiting messages and "Deliver
// now", the tunnel, Claude panes with "Create link" and "Save screen", the one-time link
// display, and the delivery log.
//
// Everything a link holder sent (the log) is shown with textContent only, never as HTML.
// The full link exists only in this page's memory after `create` returns, until "Hide".
import type { JsonValue } from "@motherapp/protocol";
import type { PageContext } from "@motherapp/protocol/page";
import { DEFAULT_HOURS, remaining } from "./src/limits.ts";

interface PaneRow {
  id: string;
  target: string;
  path: string;
  attached: string;
}

interface LinkRow {
  id: string;
  label: string;
  pane: string;
  expires: number;
  uses: number;
  last4: string;
  pending: number;
  held: string;
  /** Which idle check holds the messages (idle.ts HoldCheck), "" when none wait. */
  check: string;
  queued: { qid: number; received: number; text: string }[];
  hostChanged: boolean;
}

interface LogRow {
  seq: number;
  time: number;
  linkId: string;
  label: string;
  pane: string;
  text: string;
  result: string;
  from?: string;
}

interface TunnelRow {
  status: string;
  host: string;
  connected: boolean;
  error: string;
  warning: string;
}

const STYLE = `
.mib { display: grid; gap: 16px; color: var(--fg); max-width: 1000px; }
.mib-card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; min-width: 0; }
.mib h3 { margin: 0 0 8px; font-size: 1rem; }
.mib p { margin: 4px 0; }
.mib label { display: block; margin: 8px 0 4px; font-size: 0.9em; color: var(--muted); }
.mib input, .mib select { width: 100%; box-sizing: border-box; padding: 6px 8px; border: 1px solid var(--border);
  border-radius: 6px; background: var(--bg); color: var(--fg); font: inherit; min-width: 0; }
.mib input:focus, .mib select:focus, .mib-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.mib code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85em; word-break: break-all; }
.mib-btn { padding: 6px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: var(--fg);
  cursor: pointer; font: inherit; white-space: nowrap; }
.mib-btn:hover { border-color: var(--accent); }
.mib-btn:disabled { opacity: 0.5; cursor: default; }
.mib-btn.mib-primary { background: var(--accent); border-color: var(--accent); color: var(--bg); }
.mib-banner { border-color: var(--warn); border-width: 2px; }
.mib-secret { border-color: var(--accent); border-width: 2px; }
.mib-secret code { display: block; padding: 8px; margin: 8px 0; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; user-select: all; }
.mib-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(10em, 1fr)); gap: 0 12px; }
.mib-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; padding: 8px 0; border-top: 1px solid var(--border); }
.mib-row:first-of-type { border-top: 0; }
.mib-row .mib-grow { flex: 1 1 16em; min-width: 0; }
.mib-row .mib-full { flex: 1 1 100%; min-width: 0; }
.mib-buttons, .mib-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.mib-actions { margin-top: 10px; }
.mib-name { font-weight: 600; }
.mib-muted { color: var(--muted); font-size: 0.9em; }
.mib-warn { color: var(--warn); }
.mib-err { color: var(--err); }
.mib-ok { color: var(--ok); }
.mib-text { white-space: pre-wrap; overflow-wrap: anywhere; }
`;

const noPlaceholders = (s: string) => s.replace(/\{/g, "{\u200B");

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: { class?: string; text?: string } = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (props.class) e.className = props.class;
  if (props.text !== undefined) e.textContent = props.text;
  e.append(...kids);
  return e;
}

function button(label: string, cls = ""): HTMLButtonElement {
  const b = el("button", { class: `mib-btn ${cls}`.trim(), text: label });
  b.type = "button";
  return b;
}

function field(labelText: string, input: HTMLInputElement | HTMLSelectElement, id: string): HTMLElement {
  input.id = id;
  const l = el("label", { text: labelText });
  l.htmlFor = id;
  return el("div", {}, l, input);
}

const asMap = <T>(v: JsonValue | undefined): Record<string, T> => (v && typeof v === "object" && !Array.isArray(v) ? (v as unknown as Record<string, T>) : {});
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const time = (ms: number) => new Date(ms).toLocaleString();

export default class InboxPage extends HTMLElement {
  ctx?: PageContext;
  private off: (() => void)[] = [];
  private cleanups = new Map<string, (() => void)[]>();
  private seen = new Map<string, string>();
  private formFor: string | undefined;
  private form: { pane: string; el: HTMLElement } | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** "Save screen" results, by pane id: shown until the page is left. */
  private screenNotes = new Map<string, { text: string; error: boolean }>();

  private root = el("div", { class: "mib" });
  private banner = el("div", { class: "mib-card mib-banner" });
  private secret = el("div", { class: "mib-card mib-secret" });
  private links = el("div", { class: "mib-card" });
  private panes = el("div", { class: "mib-card" });
  private tunnel = el("div", { class: "mib-card" });
  private log = el("div", { class: "mib-card" });

  connectedCallback(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const style = el("style");
    style.textContent = STYLE;
    this.secret.hidden = true;
    this.root.append(this.banner, this.secret, this.links, this.panes, this.tunnel, this.log);
    this.replaceChildren(style, this.root);
    this.off.push(ctx.subscribe("", () => this.update()));
    this.timer = setInterval(() => this.update(true), 30_000);
  }

  disconnectedCallback(): void {
    this.off.forEach((f) => f());
    this.off = [];
    for (const list of this.cleanups.values()) list.forEach((f) => f());
    this.cleanups.clear();
    this.seen.clear();
    this.screenNotes.clear();
    if (this.timer) clearInterval(this.timer);
    // The one-time link is gone once the page is left.
    this.secret.replaceChildren();
    this.secret.hidden = true;
  }

  /** Rebuilds a section only when its data changed. */
  private section(name: string, data: unknown, build: (track: (f: () => void) => void) => void, force = false): void {
    const key = JSON.stringify(data);
    if (!force && this.seen.get(name) === key) return;
    this.seen.set(name, key);
    for (const f of this.cleanups.get(name) ?? []) f();
    const list: (() => void)[] = [];
    this.cleanups.set(name, list);
    build((f) => list.push(f));
  }

  private update(clock = false): void {
    const ctx = this.ctx!;
    const links = Object.values(asMap<LinkRow>(ctx.get("links"))).sort((a, b) => a.expires - b.expires);
    const panes = Object.values(asMap<PaneRow>(ctx.get("panes"))).sort((a, b) => a.target.localeCompare(b.target));
    const log = Object.values(asMap<LogRow>(ctx.get("log"))).sort((a, b) => b.seq - a.seq);
    const tunnel = ctx.get("tunnel") as unknown as TunnelRow | undefined;
    const listener = ctx.get("listener") as unknown as { port: number; error: string } | undefined;
    const panesStatus = String(ctx.get("panesStatus") ?? "");

    this.section("banner", links.length, () => {
      this.banner.hidden = links.length === 0;
      this.banner.replaceChildren(
        el("h3", { class: "mib-warn", text: `⚠️ ${plural(links.length, "inbox link")} active` }),
        el("p", { text: "Anyone holding one of these links can type into a Claude session on this machine. Revoke the ones you no longer need." }),
      );
    });
    this.section("links", links, (track) => this.renderLinks(links, track), clock);
    this.section("panes", [panes, panesStatus, listener, this.formFor, [...this.screenNotes]], () => this.renderPanes(panes, panesStatus, listener));
    this.section("tunnel", tunnel ?? null, () => this.renderTunnel(tunnel));
    this.section("log", log, () => this.renderLog(log), clock);
  }

  private renderLinks(links: LinkRow[], track: (f: () => void) => void): void {
    const ctx = this.ctx!;
    const now = Date.now();
    this.links.replaceChildren(el("h3", { text: "Active links" }));
    if (links.length === 0) {
      this.links.append(el("p", { class: "mib-muted", text: "No active links." }));
      return;
    }
    for (const l of links) {
      const info = el(
        "div",
        { class: "mib-grow" },
        el("div", {}, el("span", { class: "mib-name", text: l.label }), ` → ${l.pane}`),
        el("div", {
          class: "mib-muted",
          text: `id ${l.id} · …${l.last4} · expires in ${remaining(l.expires, now)} · ${plural(l.uses, "message")}`,
        }),
      );
      if (l.pending > 0) {
        info.append(el("div", { class: "mib-warn", text: `${plural(l.pending, "message")} waiting${l.held ? `: ${l.held}` : ""}${l.check ? ` [check: ${l.check}]` : ""}` }));
        for (const q of l.queued ?? []) {
          const deliver = el("div", { class: "mib-buttons" });
          track(
            ctx.render(
              [{ type: "button", label: "Deliver now", action: "deliverNow", args: { id: l.id, qid: q.qid }, confirm: noPlaceholders("Type this into the pane now even though it doesn't look idle?") }],
              deliver,
            ),
          );
          info.append(el("div", { class: "mib-row" }, el("div", { class: "mib-grow" }, el("div", { class: "mib-muted", text: `waiting since ${time(q.received)}` }), el("div", { class: "mib-text", text: q.text })), deliver));
        }
      }
      if (l.hostChanged) info.append(el("div", { class: "mib-err", text: "The quick tunnel's URL changed since this link was made, so the link no longer reaches here. Revoke it and make a new one." }));
      const buttons = el("div", { class: "mib-buttons" });
      track(
        ctx.render(
          [{ type: "button", label: "Revoke", action: "revoke", args: { id: l.id }, confirm: noPlaceholders(`Revoke the link '${l.label}' to ${l.pane}? It answers 404 from then on, and waiting messages are dropped.`) }],
          buttons,
        ),
      );
      this.links.append(el("div", { class: "mib-row" }, info, buttons));
    }
  }

  private renderPanes(panes: PaneRow[], status: string, listener: { port: number; error: string } | undefined): void {
    this.panes.replaceChildren(el("h3", { text: "Claude sessions in tmux" }));
    if (listener?.error) this.panes.append(el("p", { class: "mib-err", text: listener.error }));
    if (panes.length === 0) {
      this.panes.append(el("p", { class: "mib-muted", text: status || "No tmux pane is running Claude." }));
      return;
    }
    for (const p of panes) {
      const make = button("Create link");
      make.addEventListener("click", () => {
        this.formFor = this.formFor === p.id ? undefined : p.id;
        if (this.formFor === undefined) this.form = undefined;
        this.update();
      });
      // For idle-detector fixtures: saves `tmux capture-pane -p` of this pane to a file.
      const shot = button("Save screen");
      shot.title = "Save what this pane shows to ~/.local/state/motherapp/inbox/screens/";
      shot.addEventListener("click", () => {
        shot.disabled = true;
        this.ctx!
          .action("saveScreen", { pane: p.id })
          .then((r) => {
            const res = r as { file: string; verdict: string };
            this.screenNotes.set(p.id, { text: `Saved ${res.file}. The idle detector says: ${res.verdict}`, error: false });
          })
          .catch((e: Error) => this.screenNotes.set(p.id, { text: e.message, error: true }))
          .finally(() => this.update());
      });
      const note = this.screenNotes.get(p.id);
      const row = el(
        "div",
        { class: "mib-row" },
        el(
          "div",
          { class: "mib-grow" },
          el("div", { class: "mib-name", text: p.target }),
          el("div", { class: "mib-muted", text: `${p.path} · ${p.attached} · ${p.id}` }),
          ...(note ? [el("div", { class: note.error ? "mib-err" : "mib-muted", text: note.text })] : []),
        ),
        el("div", { class: "mib-buttons" }, make, shot),
      );
      this.panes.append(row);
      if (this.formFor === p.id) {
        // Reused across refreshes of the pane list, so what is typed survives a poll.
        if (this.form?.pane !== p.id) this.form = { pane: p.id, el: this.createForm(p) };
        row.append(this.form.el);
      }
    }
  }

  private createForm(p: PaneRow): HTMLElement {
    const label = el("input");
    label.placeholder = "cloud";
    label.maxLength = 32;
    const hours = el("input");
    hours.type = "number";
    hours.min = "0.1";
    hours.max = "720";
    hours.step = "any";
    hours.value = String(DEFAULT_HOURS);
    const go = button("Create link", "mib-primary");
    const cancel = button("Cancel");
    const result = el("span", { class: "mib-muted" });
    const k = p.id.slice(1);
    const form = el(
      "div",
      { class: "mib-full" },
      el("div", { class: "mib-grid" }, field("Label (shown as [inbox: label])", label, `mib-label-${k}`), field("Expires after (hours)", hours, `mib-exp-${k}`)),
      el("div", { class: "mib-actions" }, go, cancel, result),
    );
    cancel.addEventListener("click", () => {
      this.formFor = undefined;
      this.form = undefined;
      this.update();
    });
    go.addEventListener("click", () => {
      go.disabled = true;
      result.className = "mib-muted";
      result.textContent = "Creating… (starting the tunnel can take a few seconds)";
      this.ctx!
        .action("create", { pane: p.id, label: label.value, hours: hours.value }, (text) => (result.textContent = text))
        .then((r) => {
          const res = r as { id: string; label: string; pane: string; link: string; message: string; expires: number };
          this.formFor = undefined;
          this.form = undefined;
          this.showSecret(res);
          this.update();
        })
        .catch((e: Error) => {
          result.className = "mib-err";
          result.textContent = e.message;
          go.disabled = false;
        });
    });
    queueMicrotask(() => label.focus());
    return form;
  }

  private showSecret(r: { id: string; label: string; pane: string; link: string; message: string; expires: number }): void {
    const ctx = this.ctx!;
    for (const f of this.cleanups.get("secret") ?? []) f();
    const list: (() => void)[] = [];
    this.cleanups.set("secret", list);
    const buttons = el("div", { class: "mib-buttons" });
    list.push(
      ctx.render(
        [
          { type: "button", label: "Copy link", copy: r.link, style: "primary" },
          { type: "button", label: "Copy message for the agent", copy: r.message },
        ],
        buttons,
      ),
    );
    const hide = button("Hide");
    hide.addEventListener("click", () => {
      for (const f of this.cleanups.get("secret") ?? []) f();
      this.cleanups.delete("secret");
      this.secret.replaceChildren();
      this.secret.hidden = true;
    });
    buttons.append(hide);
    this.secret.replaceChildren(
      el("h3", { text: `New link '${r.label}' → ${r.pane}` }),
      el("p", { text: "Shown once: only a hash is kept, so this link can't be shown again. Hand it to the agent privately, never in an issue, commit or log." }),
      el("code", { text: r.link }),
      el("p", { class: "mib-muted", text: `id ${r.id} · expires ${time(r.expires)}. "Copy message for the agent" adds the sentence telling the agent to GET the link first.` }),
      buttons,
    );
    this.secret.hidden = false;
  }

  private renderTunnel(t: TunnelRow | undefined): void {
    this.tunnel.replaceChildren(el("h3", { text: "Tunnel (cloudflared)" }));
    if (!t) return;
    const statusText =
      t.status === "running" ? `running${t.host ? ` at ${t.host}` : ""}${t.connected ? ", connected" : ""}` : t.status === "stopped" ? "stopped (it starts with the first link and stops when none is active)" : t.status;
    this.tunnel.append(el("p", {}, "Quick tunnel · ", el("span", { class: t.status === "running" ? "mib-ok" : t.status === "stopped" ? "mib-muted" : "mib-warn", text: statusText })));
    if (t.error) this.tunnel.append(el("p", { class: "mib-err", text: t.error }));
    if (t.warning) this.tunnel.append(el("p", { class: "mib-warn", text: t.warning }));
    this.tunnel.append(el("p", { class: "mib-muted", text: "Only the inbox's own listener (127.0.0.1, /inbox/ paths) is reachable through the tunnel, never the rest of motherapp." }));
  }

  private renderLog(log: LogRow[]): void {
    this.log.replaceChildren(el("h3", { text: "Delivery log" }));
    if (log.length === 0) {
      this.log.append(el("p", { class: "mib-muted", text: "Nothing delivered yet." }));
      return;
    }
    for (const e of log) {
      const cls = e.result.startsWith("submitted") ? "mib-ok" : e.result.startsWith("queued") ? "mib-warn" : "mib-err";
      this.log.append(
        el(
          "div",
          { class: "mib-row" },
          el(
            "div",
            { class: "mib-full" },
            el("div", { class: "mib-muted" }, `${time(e.time)} · ${e.label} (${e.linkId}) → ${e.pane} · `, el("span", { class: cls, text: e.result })),
            el("div", { class: "mib-text", text: e.text }),
            ...(e.from ? [el("div", { class: "mib-muted", text: `from ${e.from} (as the sender reports it)` })] : []),
          ),
        ),
      );
    }
  }
}
