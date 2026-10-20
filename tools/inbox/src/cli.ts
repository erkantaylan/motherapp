// `inboxctl` subcommands. With the motherapp core running they go through its inbox tool
// (coreClient.ts), which owns the links, the listener and the tunnel. Without it, the read-only
// commands and `revoke` work on the files directly; `new` needs the running tool, since the
// tunnel lives there.
import type { Writable } from "node:stream";
import { connectCore, corePort } from "./coreClient.ts";
import type { CoreConnection } from "./coreClient.ts";
import { remaining } from "./limits.ts";
import { AGENT_SENTENCE } from "./skill.ts";
import { TmuxPanes, isClaudeCommand } from "./panes.ts";
import type { PanesOptions } from "./panes.ts";
import { loadSettings, settingsFile } from "./settings.ts";
import { Store } from "./store.ts";
import type { DeliveryEntry } from "./store.ts";

export const USAGE = `usage: inboxctl <command> [options]

  panes [--json]          tmux panes running Claude
  links [--json]          active links: id, label, pane, expiry, uses, pending
  new --pane <pane> --label <label> [--expires 24h] [--max-uses 20] [--max-len 500]
                          make a link for a pane (motherapp:0.0 or %3); prints it ONCE
  revoke <id>             revoke a link (it answers 404 from then on)
  log [--json] [-n N]     deliveries: time, link, pane, result, text (default: last 20)
  serve                   JSON-RPC mode, started by the motherapp core

  "new" needs motherapp running (systemctl --user start motherapp): the inbox listener and
  the cloudflared tunnel live in its inbox tool. The other commands work without it.

Exit codes: 0 ok, 1 failed (no such link or pane, motherapp not running for "new"),
2 usage error.`;

export interface CliIO {
  stdout: Writable;
  stderr: Writable;
  env?: NodeJS.ProcessEnv;
  /** The inbox state dir (default ~/.local/state/motherapp/inbox). */
  stateDir: string;
  panes: PanesOptions;
  /** Default: the real core on its configured port. */
  connect?: () => Promise<CoreConnection | undefined>;
  now?: () => number;
}

class UsageError extends Error {}

const line = (out: Writable, s = "") => out.write(s + "\n");

interface Flags {
  pos: string[];
  opts: Map<string, string>;
  bools: Set<string>;
}

const VALUE_FLAGS = new Set(["--pane", "--label", "--expires", "--max-uses", "--max-len", "-n"]);
const BOOL_FLAGS = new Set(["--json"]);

function parse(args: string[]): Flags {
  const f: Flags = { pos: [], opts: new Map(), bools: new Set() };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const eq = a.indexOf("=");
    const name = a.startsWith("--") && eq > 0 ? a.slice(0, eq) : a;
    if (VALUE_FLAGS.has(name)) {
      const v = name !== a ? a.slice(eq + 1) : args[++i];
      if (v === undefined) throw new UsageError(`${name} needs a value`);
      f.opts.set(name, v);
    } else if (BOOL_FLAGS.has(a)) f.bools.add(a);
    else if (a.startsWith("-") && a !== "-") throw new UsageError(`unknown option "${a}"`);
    else f.pos.push(a);
  }
  return f;
}

function allow(f: Flags, values: string[], bools: string[], positional: number): void {
  for (const k of f.opts.keys()) if (!values.includes(k)) throw new UsageError(`unknown option "${k}"`);
  for (const k of f.bools) if (!bools.includes(k)) throw new UsageError(`unknown option "${k}"`);
  if (f.pos.length !== positional) throw new UsageError(positional === 0 ? `unexpected argument "${f.pos[0]}"` : "expected one link id");
}

interface LinkRow {
  id: string;
  label: string;
  pane: string;
  expires: number;
  uses: number;
  maxUses: number;
  pending: number;
  last4: string;
  held?: string;
}

function printLinks(out: Writable, rows: LinkRow[], now: number): void {
  if (rows.length === 0) {
    line(out, "No active links.");
    return;
  }
  for (const r of rows.sort((a, b) => a.expires - b.expires)) {
    const pend = r.pending > 0 ? `, ${r.pending} pending${r.held ? ` (${r.held})` : ""}` : "";
    line(out, `${r.id}  …${r.last4}  ${r.label}  → ${r.pane}  expires in ${remaining(r.expires, now)}, used ${r.uses}/${r.maxUses}${pend}`);
  }
}

function printLog(out: Writable, entries: DeliveryEntry[]): void {
  if (entries.length === 0) {
    line(out, "No deliveries yet.");
    return;
  }
  for (const e of entries) line(out, `${new Date(e.time).toISOString()}  ${e.linkId} → ${e.pane}  ${e.result}\n    ${e.text}`);
}

export async function runCli(argv: string[], io: CliIO): Promise<number> {
  const [cmd, ...rest] = argv;
  const now = io.now ?? Date.now;
  const env = io.env ?? process.env;
  let core: CoreConnection | undefined;
  const open = async () => (core ??= await (io.connect ?? (() => connectCore(corePort(env))))());
  try {
    switch (cmd) {
      case "panes": {
        const f = parse(rest);
        allow(f, [], ["--json"], 0);
        const c = await open();
        let rows: { id: string; target: string; path: string; attached: string }[];
        if (c) {
          rows = Object.values((c.state.panes ?? {}) as Record<string, { id: string; target: string; path: string; attached: string }>);
        } else {
          const extra = loadSettings(settingsFile(env), env).settings.paneCommands;
          const list = await new TmuxPanes(io.panes).list();
          if (list.kind === "none" && !f.bools.has("--json")) {
            line(io.stdout, list.reason);
            return 0;
          }
          rows = (list.kind === "ok" ? list.panes : [])
            .filter((p) => isClaudeCommand(p.command, extra))
            .map((p) => ({ id: p.id, target: p.target, path: p.path, attached: p.attached > 0 ? "attached" : "detached" }));
        }
        rows.sort((a, b) => a.target.localeCompare(b.target));
        if (f.bools.has("--json")) line(io.stdout, JSON.stringify(rows, null, 2));
        else if (rows.length === 0) line(io.stdout, "No tmux pane is running Claude.");
        else {
          const w = Math.max(...rows.map((r) => r.target.length));
          for (const r of rows) line(io.stdout, `${r.target.padEnd(w)}  ${r.id.padEnd(4)}  ${r.attached.padEnd(8)}  ${r.path}`);
        }
        return 0;
      }
      case "links": {
        const f = parse(rest);
        allow(f, [], ["--json"], 0);
        const c = await open();
        const rows: LinkRow[] = c
          ? Object.values((c.state.links ?? {}) as Record<string, LinkRow>)
          : new Store(io.stateDir).active(now()).map((l) => ({ id: l.id, label: l.label, pane: l.pane.target, expires: l.expires, uses: l.uses, maxUses: l.maxUses, pending: 0, last4: l.last4 }));
        if (f.bools.has("--json")) line(io.stdout, JSON.stringify(rows, null, 2));
        else printLinks(io.stdout, rows, now());
        return 0;
      }
      case "new": {
        const f = parse(rest);
        allow(f, ["--pane", "--label", "--expires", "--max-uses", "--max-len"], [], 0);
        const pane = f.opts.get("--pane");
        if (!pane) throw new UsageError("--pane is required (see inboxctl panes)");
        if (!f.opts.get("--label")) throw new UsageError("--label is required");
        const args: Record<string, unknown> = { pane, label: f.opts.get("--label") };
        if (f.opts.has("--expires")) args.expires = f.opts.get("--expires");
        if (f.opts.has("--max-uses")) args.maxUses = f.opts.get("--max-uses");
        if (f.opts.has("--max-len")) args.maxLen = f.opts.get("--max-len");
        const c = await open();
        if (!c) throw new Error("motherapp isn't running with the inbox tool, and the link needs its tunnel. Start it: systemctl --user start motherapp");
        const r = (await c.action("create", args)) as { id: string; link: string; message: string; expires: number };
        // The only place the CLI ever prints a token: once, to this terminal.
        line(io.stdout, r.link);
        line(io.stderr, `\nLink ${r.id} for ${pane}, expires ${new Date(r.expires).toISOString()}. It won't be shown again.`);
        line(io.stderr, `Send it to the agent with: "${AGENT_SENTENCE}"`);
        return 0;
      }
      case "revoke": {
        const f = parse(rest);
        allow(f, [], [], 1);
        const id = f.pos[0]!;
        const c = await open();
        if (c) await c.action("revoke", { id });
        else if (!new Store(io.stateDir).revoke(id, now())) throw new Error(`no active link with id ${id}`);
        line(io.stdout, `revoked ${id}`);
        return 0;
      }
      case "log": {
        const f = parse(rest);
        allow(f, ["-n"], ["--json"], 0);
        const n = f.opts.has("-n") ? Number(f.opts.get("-n")) : 20;
        if (!Number.isInteger(n) || n < 1) throw new UsageError("-n must be a positive number");
        const entries = new Store(io.stateDir).deliveries().slice(-n);
        if (f.bools.has("--json")) line(io.stdout, JSON.stringify(entries, null, 2));
        else printLog(io.stdout, entries);
        return 0;
      }
      case undefined:
      case "help":
      case "-h":
      case "--help":
        line(cmd === undefined ? io.stderr : io.stdout, USAGE);
        return cmd === undefined ? 2 : 0;
      default:
        throw new UsageError(`unknown command "${cmd}"`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      line(io.stderr, `inboxctl: ${e.message}\n\n${USAGE}`);
      return 2;
    }
    line(io.stderr, `inboxctl: ${(e as Error).message}`);
    return 1;
  } finally {
    core?.close();
  }
}
