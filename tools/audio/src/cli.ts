// Plain subcommands for terminals, keybindings and scripts. They work without the core: each
// one reads the graph with a one-shot `pw-dump` and acts with the same commands serve mode uses.
import type { Writable } from "node:stream";
import { AudioOps } from "./ops.ts";
import type { OpsOptions } from "./ops.ts";
import { MAX_APP_VOLUME, PwModel, appMuted, appVolume, buildView, findApp, findDevice, viewToState } from "./pipewire.ts";
import type { AudioView, Device } from "./pipewire.ts";
import { runCommand } from "./runner.ts";
import type { Runner } from "./runner.ts";

export const USAGE = `usage: audioctl <command> [args]

  list [--json]                   outputs, inputs (* = default) and apps playing sound
  set-default <id|name>           make an output or input the default
  app-volume <app> <percent>      set an app's volume, 0-${MAX_APP_VOLUME} (same scale as wpctl);
                                  +N / -N change it relatively
  app-mute <app> on|off|toggle    mute or unmute all of an app's streams
  test-output <id|name>           play the left/right test sound on an output
  record-test <id|name>           record 3 s from an input, play it on the default output
  serve                           JSON-RPC serve mode (started by the motherapp core)

<app> is the app's name (e.g. Firefox), its binary or a unique part of either.
<name> is a node name, the description shown by "list", or a unique part of it.`;

export interface CliIO {
  runner: Runner;
  stdout: Writable;
  stderr: Writable;
  ops?: Omit<OpsOptions, "runner">;
}

export class UsageError extends Error {}

export async function readView(runner: Runner): Promise<AudioView> {
  const res = await runCommand(runner, "pw-dump", [], { label: "pw-dump", timeoutMs: 10_000, env: { NO_COLOR: "1" } });
  let dump: unknown;
  try {
    dump = JSON.parse(res.stdout.toString("utf8"));
  } catch (e) {
    throw new Error(`cannot parse pw-dump output: ${(e as Error).message}`);
  }
  const model = new PwModel();
  model.apply(dump);
  return buildView(model.objects.values());
}

/** "70", "70%", "+5", "-5%" → the new percentage, clamped to 0..MAX. */
export function parsePercent(arg: string, current: number): number {
  const m = /^([+-]?)(\d+(?:\.\d+)?)%?$/.exec(arg.trim());
  if (!m) throw new UsageError(`volume must be a percentage like 70, 70%, +5 or -5 (got "${arg}")`);
  const n = Number(m[2]);
  const v = m[1] === "+" ? current + n : m[1] === "-" ? current - n : n;
  return Math.round(Math.max(0, Math.min(MAX_APP_VOLUME, v)));
}

function need(args: string[], n: number, what: string): void {
  if (args.length < n) throw new UsageError(`missing ${what}`);
}

const line = (out: Writable, s = "") => out.write(s + "\n");

function printDevices(out: Writable, title: string, list: Device[], defaultName: string | undefined): void {
  line(out, title);
  if (list.length === 0) line(out, "    (none)");
  for (const d of list) {
    const mark = d.name === defaultName ? "*" : " ";
    const sub = d.subtitle !== d.title ? `  (${d.subtitle})` : "";
    line(out, `  ${mark} ${String(d.id).padStart(4)}  ${d.title}${sub}`);
  }
}

/** Runs one subcommand; returns the exit code. */
export async function runCli(argv: string[], io: CliIO): Promise<number> {
  const [cmd, ...args] = argv;
  const ops = new AudioOps({ ...io.ops, runner: io.runner });
  try {
    switch (cmd) {
      case "list": {
        const view = await readView(io.runner);
        if (args.includes("--json")) {
          line(io.stdout, JSON.stringify(viewToState(view), null, 2));
          return 0;
        }
        printDevices(io.stdout, "Outputs", view.sinks, view.defaultSinkName);
        printDevices(io.stdout, "Inputs", view.sources, view.defaultSourceName);
        line(io.stdout, "Apps");
        if (view.apps.length === 0) line(io.stdout, "    (none playing sound)");
        const w = Math.max(0, ...view.apps.map((a) => a.name.length));
        for (const a of view.apps) {
          const n = a.streams.length;
          line(io.stdout, `    ${a.name.padEnd(w)}  ${String(appVolume(a)).padStart(3)}%${appMuted(a) ? "  muted" : ""}${n > 1 ? `  (${n} streams)` : ""}`);
        }
        return 0;
      }
      case "set-default": {
        need(args, 1, "device id or name");
        const dev = findDevice(await readView(io.runner), args[0]!);
        await ops.setDefault(dev);
        line(io.stdout, `default ${dev.kind === "sink" ? "output" : "input"}: ${dev.title}`);
        return 0;
      }
      case "app-volume": {
        need(args, 2, "app and volume");
        const app = findApp(await readView(io.runner), args[0]!);
        const v = parsePercent(args[1]!, appVolume(app));
        await ops.setStreamsVolume(app.streams, v);
        line(io.stdout, `${app.name}: ${v}%`);
        return 0;
      }
      case "app-mute": {
        need(args, 2, "app and on|off|toggle");
        const mode = args[1]!;
        if (!["on", "off", "toggle"].includes(mode)) throw new UsageError(`app-mute takes on, off or toggle (got "${mode}")`);
        const app = findApp(await readView(io.runner), args[0]!);
        const muted = mode === "toggle" ? !appMuted(app) : mode === "on";
        await ops.setStreamsMute(app.streams, muted);
        line(io.stdout, `${app.name}: ${muted ? "muted" : "unmuted"}`);
        return 0;
      }
      case "test-output": {
        need(args, 1, "output id or name");
        const dev = findDevice(await readView(io.runner), args[0]!, "sink");
        line(io.stdout, `playing left/right test sound on ${dev.title}`);
        await ops.testOutput(dev);
        return 0;
      }
      case "record-test": {
        need(args, 1, "input id or name");
        const dev = findDevice(await readView(io.runner), args[0]!, "source");
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
