// `brightctl` subcommands for terminals and keybindings. With the motherapp core running they
// go through it (coreClient.ts); otherwise (or with --direct) they open the monitors here,
// using the same service code as serve mode.
import { createTool, readPersistedState } from "@motherapp/tool-sdk";
import type { JsonObject, Logger } from "@motherapp/tool-sdk";
import type { Writable } from "node:stream";
import { TOOL_ID, connectCore, corePort } from "./coreClient.ts";
import type { CoreConnection } from "./coreClient.ts";
import { parseValueSpec } from "./model.ts";
import { selectBackend } from "./select.ts";
import type { Selected } from "./select.ts";
import { BrightnessService, INITIAL_STATE } from "./service.ts";

export const USAGE = `usage: brightctl <command> [options]

  list [--json]                     monitors and their brightness
  get <monitor> [--json]            read one monitor now (prints the percent)
  set <monitor|all> <value>         value: 0-100 (absolute), +N or -N (relative)
  detect [--json]                   look for monitors again
  serve                             JSON-RPC mode, started by the motherapp core
  help

  <monitor> is a connector (DP-1), a bus (3, i2c-3, /dev/i2c-3), part of the model
  name (acer), or the id from "list --json". "all" sets every monitor; with +N/-N each
  one moves by N from its own value.

  --direct   don't go through the running motherapp service; open the monitors here.
             (By default brightctl uses the service when it is running, so the page
             updates and only one program talks to the monitors.)`;

export interface CliIo {
  stdout: Writable;
  stderr: Writable;
  env?: NodeJS.ProcessEnv;
  /** Called before libddcutil may be loaded; returns the stream to use as stdout from then on. */
  isolateStdout?: () => Writable | undefined;
  /** Backend for direct mode (tests). Default: selectBackend(env). */
  backend?: () => Promise<Selected>;
}

class UsageError extends Error {}

interface Row {
  id: string;
  title: string;
  connector?: string;
  bus: number;
  present: boolean;
  brightness?: number;
  stale: boolean;
}

const line = (s: Writable, text: string) => s.write(text + "\n");

function need(args: string[], n: number, what: string): void {
  if (args.length < n) throw new UsageError(`missing ${what}`);
}

function printRows(out: Writable, rows: Row[]): void {
  if (rows.length === 0) {
    line(out, "No monitors found.");
    return;
  }
  const w = Math.max(...rows.map((r) => r.title.length));
  const c = Math.max(...rows.map((r) => (r.connector ?? `i2c-${r.bus}`).length));
  for (const r of rows) {
    const value = r.brightness === undefined ? "  ?" : `${String(r.brightness).padStart(3)}%`;
    const notes = [!r.present ? "not found" : "", r.stale && r.brightness !== undefined ? "cached, not confirmed" : ""].filter(Boolean);
    line(out, `${r.title.padEnd(w)}  ${(r.connector ?? `i2c-${r.bus}`).padEnd(c)}  ${value}${notes.length ? `  (${notes.join(", ")})` : ""}`);
  }
}

const asRows = (v: unknown) => (v as Row[]).slice().sort((a, b) => a.title.localeCompare(b.title));

/** The same operations, either through the core or on a local service. */
interface Session {
  list(): Promise<Row[]>;
  action(name: string, args: JsonObject): Promise<unknown>;
  close(): Promise<void>;
}

function coreSession(c: CoreConnection): Session {
  return {
    // A fresh read: the serve process re-reads only while its page is watched.
    list: async () => asRows(await c.action("list", {})),
    action: (name, args) => c.action(name, args),
    close: async () => c.close(),
  };
}

async function directSession(io: CliIo): Promise<Session> {
  const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };
  const persisted = readPersistedState(TOOL_ID);
  const tool = createTool({ id: TOOL_ID, title: "Brightness", initialState: { ...INITIAL_STATE, ...(persisted ? { monitors: persisted.monitors ?? {} } : {}) }, persist: false, captureConsole: false });
  const service = new BrightnessService({ tool, backend: io.backend ?? (() => selectBackend(io.env)), log: quiet, pollMs: 0, readOnDetect: false });
  await service.start();
  const warning = tool.get("warning");
  if (typeof warning === "string") line(io.stderr, `brightctl: ${warning.replace(/^⚠️ /, "warning: ")}`);
  const status = tool.get("status");
  if (typeof status === "string" && tool.get("monitors") && Object.keys(tool.get("monitors") as object).length === 0) {
    await service.stop();
    throw new Error(status);
  }
  return {
    list: async () => asRows(await service.call("read", {})),
    action: async (name, args) => {
      // No serve process keeps the values fresh here; read before a relative step.
      if (name === "set") await service.call("read", { target: args.target ?? "all" });
      return service.call(name, args);
    },
    close: () => service.stop(),
  };
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const direct = argv.includes("--direct");
  const json = argv.includes("--json");
  const [cmd, ...args] = argv.filter((a) => a !== "--direct" && a !== "--json");
  let session: Session | undefined;
  const open = async (): Promise<Session> => {
    if (!direct) {
      const c = await connectCore(corePort(io.env));
      if (c) return coreSession(c);
    }
    const out = io.isolateStdout?.();
    if (out) io.stdout = out;
    return directSession(io);
  };
  try {
    switch (cmd) {
      case "list": {
        session = await open();
        const rows = await session.list();
        if (json) line(io.stdout, JSON.stringify(rows, null, 2));
        else printRows(io.stdout, rows);
        return 0;
      }
      case "get": {
        need(args, 1, "monitor");
        session = await open();
        const rows = asRows(await session.action("read", { target: args[0]! }));
        const r = rows[0];
        if (!r || r.brightness === undefined) throw new Error(`could not read ${args[0]}`);
        if (json) line(io.stdout, JSON.stringify(r, null, 2));
        else line(io.stdout, String(r.brightness));
        return 0;
      }
      case "set": {
        need(args, 2, "monitor (or all) and value");
        try {
          parseValueSpec(args[1]!); // fail on a typo before connecting anything
        } catch (e) {
          throw new UsageError((e as Error).message);
        }
        session = await open();
        const rows = asRows(await session.action("set", { target: args[0]!, value: args[1]! }));
        if (json) line(io.stdout, JSON.stringify(rows, null, 2));
        else for (const r of rows) line(io.stdout, `${r.title}: ${r.brightness ?? "?"}%`);
        return 0;
      }
      case "detect": {
        session = await open();
        const rows = asRows(await session.action("redetect", {}));
        if (json) line(io.stdout, JSON.stringify(rows, null, 2));
        else printRows(io.stdout, rows);
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
      line(io.stderr, `brightctl: ${e.message}\n\n${USAGE}`);
      return 2;
    }
    line(io.stderr, `brightctl: ${(e as Error).message}`);
    return 1;
  } finally {
    await session?.close();
  }
}
