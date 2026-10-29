// Plain subcommands for terminals, keybindings and scripts. They work without the core: each
// one reads the graph with a one-shot `pw-dump` and acts with the same commands serve mode uses.
import type { Writable } from "node:stream";
import { desktopNameLookup } from "./desktop.ts";
import { JsonStreamParser } from "./jsonStream.ts";
import { AudioOps } from "./ops.ts";
import type { OpsOptions } from "./ops.ts";
import {
  MAX_APP_VOLUME,
  MAX_MASTER_VOLUME,
  PwModel,
  appMuted,
  appVolume,
  buildView,
  defaultDevice,
  deviceVolume,
  findApp,
  findDevice,
  findTarget,
  viewToState,
} from "./pipewire.ts";
import type { AudioView, Device, MasterKind, RouteOption } from "./pipewire.ts";
import { runCommand } from "./runner.ts";
import type { Runner } from "./runner.ts";
import { selectRoute } from "./select.ts";

export const USAGE = `usage: audioctl <command> [args]

  list [--json]                   outputs, inputs (* = default) and apps playing sound
  volume [--input] [N|N%|+N|-N]   the default output's (--input: mic's) volume, 0-${MAX_MASTER_VOLUME};
                                  +N stops at 100 unless already above. No value: print it
  mute [--input] [on|off|toggle]  mute the default output (--input: mic). No value: print on|off
  set-default <id|name>           make an output or input the default. For one marked
                                  "(switches profile)" this switches the card first
  app-volume <app> <percent>      set an app's volume, 0-${MAX_APP_VOLUME} (same scale as wpctl);
                                  +N / -N change it relatively
  app-mute <app> on|off|toggle    mute or unmute all of an app's streams
  test-output <id|name>           play the left/right test sound on an output
  record-test <id|name>           record 3 s from an input, play it on the default output
  serve                           JSON-RPC serve mode (started by the motherapp core)

<app> is the app's name (e.g. Firefox), its binary or a unique part of either.
<name> is a node name, the title shown by "list", or a unique part of it.`;

export interface CliIO {
  runner: Runner;
  stdout: Writable;
  stderr: Writable;
  ops?: Omit<OpsOptions, "runner">;
  /** set-default on a route: how often to re-read pw-dump while waiting, and for how long. */
  pollMs?: number;
  switchTimeoutMs?: number;
  /** Desktop entry Name= for a binary (default: read from the XDG dirs when first needed). */
  desktopName?: (binary: string) => string | undefined;
}

export class UsageError extends Error {}

let defaultDesktopName: ((binary: string) => string | undefined) | undefined;

export async function readView(runner: Runner, desktopName?: (binary: string) => string | undefined): Promise<AudioView> {
  const res = await runCommand(runner, "pw-dump", [], { label: "pw-dump", timeoutMs: 10_000, env: { NO_COLOR: "1" } });
  // A one-shot pw-dump taken while the graph changes (a card switching profile) prints more
  // than one array: the dump, then the updates it saw. Apply them all, in order.
  const values = new JsonStreamParser().push(res.stdout.toString("utf8"));
  if (values.length === 0) throw new Error("cannot parse pw-dump output: no JSON in it");
  const model = new PwModel();
  for (const v of values) {
    try {
      model.apply(JSON.parse(v));
    } catch (e) {
      throw new Error(`cannot parse pw-dump output: ${(e as Error).message}`);
    }
  }
  return buildView(model.objects.values(), { desktopName: desktopName ?? (defaultDesktopName ??= desktopNameLookup()) });
}

/**
 * "70", "70%", "+5", "-5%" → the new percentage. An absolute value above MAX is a usage error
 * (#28: `volume 151` used to set 150 silently, so a typo could reach the speakers); a relative
 * change is clamped to 0..MAX. Call it once with any `current` before reading PipeWire, so
 * usage errors come first.
 */
export function parsePercent(arg: string, current: number): number {
  const m = /^([+-]?)(\d+(?:\.\d+)?)%?$/.exec(arg.trim());
  if (!m) throw new UsageError(`volume must be a percentage like 70, 70%, +5 or -5 (got "${arg}")`);
  const n = Number(m[2]);
  if (m[1] === "" && n > MAX_APP_VOLUME) throw new UsageError(`volume must be 0-${MAX_APP_VOLUME} (got ${m[2]})`);
  const v = m[1] === "+" ? current + n : m[1] === "-" ? current - n : n;
  return Math.round(Math.max(0, Math.min(MAX_APP_VOLUME, v)));
}

/**
 * Master volume argument. Like parsePercent, but a relative increase stops at 100 unless the
 * volume is already above it, as GNOME's volume keys do: a key bound to `volume +5` can't
 * push the speakers into over-amplification by being held down.
 */
export function parseMasterPercent(arg: string, current: number): number {
  const v = parsePercent(arg, current);
  if (arg.trim().startsWith("+") && current <= 100) return Math.min(v, 100);
  return Math.min(v, MAX_MASTER_VOLUME);
}

/** `volume` / `mute` arguments: `--input` anywhere, at most one value. */
export function parseMasterArgs(cmd: string, args: string[]): { kind: MasterKind; value?: string } {
  const rest = args.filter((a) => a !== "--input");
  if (rest.length > 1) throw new UsageError(`${cmd} takes at most one value (got ${rest.join(" ")})`);
  const out: { kind: MasterKind; value?: string } = { kind: args.includes("--input") ? "input" : "output" };
  if (rest[0] !== undefined) out.value = rest[0];
  return out;
}

function masterDevice(view: AudioView, kind: MasterKind): Device {
  const d = defaultDevice(view, kind);
  if (!d) throw new Error(`there is no default ${kind} right now`);
  return d;
}

function need(args: string[], n: number, what: string): void {
  if (args.length < n) throw new UsageError(`missing ${what}`);
}

const line = (out: Writable, s = "") => out.write(s + "\n");

function printDevices(out: Writable, title: string, list: Device[], routes: RouteOption[], defaultName: string | undefined): void {
  line(out, title);
  if (list.length === 0 && routes.length === 0) line(out, "    (none)");
  const sub = (s: string, t: string) => (s && s !== t ? `  (${s})` : "");
  for (const d of list) {
    const mark = d.name === defaultName ? "*" : " ";
    line(out, `  ${mark} ${String(d.id).padStart(4)}  ${d.title}${sub(d.subtitle, d.title)}`);
  }
  // Routes with no node: selecting them switches the card's profile (or port).
  for (const r of routes) {
    const note = r.profile !== undefined ? "switches profile" : "switches port";
    line(out, `    ${r.key}  ${r.title}${sub(r.subtitle, r.title)}  [${note}]`);
  }
}

/** The CLI has no monitor: re-read pw-dump until the switched card's node shows up. */
function pollView(runner: Runner, pollMs: number, desktopName?: (binary: string) => string | undefined) {
  return async <T>(pick: (v: AudioView) => T | undefined, timeoutMs: number): Promise<T | undefined> => {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const v = pick(await readView(runner, desktopName));
      if (v !== undefined || Date.now() >= end) return v;
      await new Promise((r) => setTimeout(r, pollMs));
    }
  };
}

/** Runs one subcommand; returns the exit code. */
export async function runCli(argv: string[], io: CliIO): Promise<number> {
  const [cmd, ...args] = argv;
  const ops = new AudioOps({ ...io.ops, runner: io.runner });
  try {
    switch (cmd) {
      case "list": {
        const view = await readView(io.runner, io.desktopName);
        if (args.includes("--json")) {
          line(io.stdout, JSON.stringify(viewToState(view), null, 2));
          return 0;
        }
        printDevices(io.stdout, "Outputs", view.sinks, view.sinkRoutes, view.defaultSinkName);
        printDevices(io.stdout, "Inputs", view.sources, view.sourceRoutes, view.defaultSourceName);
        line(io.stdout, "Apps");
        if (view.apps.length === 0) line(io.stdout, "    (none playing sound)");
        const w = Math.max(0, ...view.apps.map((a) => a.name.length));
        for (const a of view.apps) {
          const n = a.streams.length;
          line(io.stdout, `    ${a.name.padEnd(w)}  ${String(appVolume(a)).padStart(3)}%${appMuted(a) ? "  muted" : ""}${n > 1 ? `  (${n} streams)` : ""}`);
        }
        return 0;
      }
      // volume / mute: for GNOME shortcuts, so quiet on success; with no value, print it.
      case "volume": {
        const { kind, value } = parseMasterArgs(cmd, args);
        if (value !== undefined) parseMasterPercent(value, 0); // usage errors before touching PipeWire
        const dev = masterDevice(await readView(io.runner, io.desktopName), kind);
        const current = deviceVolume(dev);
        if (value === undefined) {
          line(io.stdout, String(current));
          return 0;
        }
        await ops.setDeviceVolume(dev, parseMasterPercent(value, current));
        return 0;
      }
      case "mute": {
        const { kind, value } = parseMasterArgs(cmd, args);
        if (value !== undefined && !["on", "off", "toggle"].includes(value)) throw new UsageError(`mute takes on, off or toggle (got "${value}")`);
        const dev = masterDevice(await readView(io.runner, io.desktopName), kind);
        if (value === undefined) {
          line(io.stdout, dev.muted ? "on" : "off");
          return 0;
        }
        await ops.setDeviceMute(dev, value === "toggle" ? "toggle" : value === "on");
        return 0;
      }
      case "set-default": {
        need(args, 1, "device id or name");
        const target = findTarget(await readView(io.runner, io.desktopName), args[0]!);
        if ("route" in target) {
          const deps = { ops, waitView: pollView(io.runner, io.pollMs ?? 200, io.desktopName) };
          const node = await selectRoute(target.route, io.switchTimeoutMs === undefined ? deps : { ...deps, timeoutMs: io.switchTimeoutMs });
          line(io.stdout, `default ${node.kind === "sink" ? "output" : "input"}: ${target.route.title} (now ${node.id}, ${node.title})`);
          return 0;
        }
        const dev = target.device;
        await ops.setDefault(dev);
        line(io.stdout, `default ${dev.kind === "sink" ? "output" : "input"}: ${dev.title}`);
        return 0;
      }
      case "app-volume": {
        need(args, 2, "app and volume");
        parsePercent(args[1]!, 0); // usage errors before touching PipeWire
        const app = findApp(await readView(io.runner, io.desktopName), args[0]!);
        const v = parsePercent(args[1]!, appVolume(app));
        await ops.setStreamsVolume(app.streams, v);
        line(io.stdout, `${app.name}: ${v}%`);
        return 0;
      }
      case "app-mute": {
        need(args, 2, "app and on|off|toggle");
        const mode = args[1]!;
        if (!["on", "off", "toggle"].includes(mode)) throw new UsageError(`app-mute takes on, off or toggle (got "${mode}")`);
        const app = findApp(await readView(io.runner, io.desktopName), args[0]!);
        const muted = mode === "toggle" ? !appMuted(app) : mode === "on";
        await ops.setStreamsMute(app.streams, muted);
        line(io.stdout, `${app.name}: ${muted ? "muted" : "unmuted"}`);
        return 0;
      }
      case "test-output": {
        need(args, 1, "output id or name");
        const dev = findDevice(await readView(io.runner, io.desktopName), args[0]!, "sink");
        line(io.stdout, `playing left/right test sound on ${dev.title}`);
        await ops.testOutput(dev);
        return 0;
      }
      case "record-test": {
        need(args, 1, "input id or name");
        const dev = findDevice(await readView(io.runner, io.desktopName), args[0]!, "source");
        await ops.recordTest(dev, (text) => line(io.stdout, text));
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
      line(io.stderr, `audioctl: ${e.message}\n\n${USAGE}`);
      return 2;
    }
    line(io.stderr, `audioctl: ${(e as Error).message}`);
    return 1;
  }
}
