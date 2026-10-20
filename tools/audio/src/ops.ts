// The things the audio tool does to PipeWire, as commands: wpctl for defaults, volume and mute,
// pw-play/pw-record for the tests. Shared by serve mode and the plain CLI.
import * as fs from "node:fs";
import { LevelMeter, RATE } from "./level.ts";
import { percentToWpctl } from "./pipewire.ts";
import type { AppStream, Device } from "./pipewire.ts";
import { CommandError, runCommand, spawnErrorMessage, stderrSummary } from "./runner.ts";
import type { Proc, RunOptions, Runner } from "./runner.ts";

/** Same files audio-switch plays (package sound-theme-freedesktop). */
const SOUNDS = "/usr/share/sounds/freedesktop/stereo";
export const TEST_SOUNDS = [`${SOUNDS}/audio-channel-front-left.oga`, `${SOUNDS}/audio-channel-front-right.oga`];
export const RECORD_SECONDS = 3;
const RAW_FORMAT = ["--format", "s16", "--rate", String(RATE), "--channels", "1"];
const WPCTL_TIMEOUT_MS = 5000;

export interface OpsOptions {
  runner: Runner;
  testSounds?: string[];
  recordSeconds?: number;
  /** Told about every pw-play we start, so its stream isn't shown as an app. */
  ownPid?: (pid: number, running: boolean) => void;
  /** Grace before SIGKILL when stopping pw-record. Default 1000 ms. */
  killGraceMs?: number;
}

export class AudioOps {
  private runner: Runner;
  private opts: OpsOptions;

  constructor(opts: OpsOptions) {
    this.runner = opts.runner;
    this.opts = opts;
  }

  private wpctl(args: string[]): Promise<unknown> {
    return runCommand(this.runner, "wpctl", args, { timeoutMs: WPCTL_TIMEOUT_MS, label: `wpctl ${args[0]}` });
  }

  setDefault(dev: Device): Promise<unknown> {
    return this.wpctl(["set-default", String(dev.id)]);
  }

  /** Sets every stream to `percent` (the wpctl/cubic scale). */
  async setStreamsVolume(streams: readonly AppStream[], percent: number): Promise<void> {
    const v = percentToWpctl(percent);
    await Promise.all(streams.map((s) => this.wpctl(["set-volume", String(s.id), v])));
  }

  async setStreamsMute(streams: readonly AppStream[], muted: boolean): Promise<void> {
    await Promise.all(streams.map((s) => this.wpctl(["set-mute", String(s.id), muted ? "1" : "0"])));
  }

  /** Master volume: one `wpctl set-volume <id>` on that output or input, by its PipeWire id. */
  setDeviceVolume(dev: Device, percent: number): Promise<unknown> {
    return this.wpctl(["set-volume", String(dev.id), percentToWpctl(percent)]);
  }

  /** Master mute: `wpctl set-mute <id> 1|0|toggle`. */
  setDeviceMute(dev: Device, muted: boolean | "toggle"): Promise<unknown> {
    return this.wpctl(["set-mute", String(dev.id), muted === "toggle" ? "toggle" : muted ? "1" : "0"]);
  }

  private play(args: string[], input?: Buffer): Promise<unknown> {
    let pid: number | undefined;
    const opts: RunOptions = {
      label: "pw-play",
      timeoutMs: 30_000,
      onPid: (p) => {
        pid = p;
        this.opts.ownPid?.(p, true);
      },
    };
    if (input) opts.input = input;
    return runCommand(this.runner, "pw-play", args, opts).finally(() => {
      if (pid !== undefined) this.opts.ownPid?.(pid, false);
    });
  }

  /** Plays the left, then the right channel test sound on that sink. */
  async testOutput(dev: Device): Promise<void> {
    const sounds = this.opts.testSounds ?? TEST_SOUNDS;
    const missing = sounds.find((f) => !fs.existsSync(f));
    if (missing) throw new Error(`Test sound not found: ${missing} (install sound-theme-freedesktop)`);
    for (const f of sounds) await this.play(["--target", dev.name, f]);
  }

  /** Records from the source, then plays the recording on the default output. */
  async recordTest(dev: Device, progress: (text: string, fraction?: number) => void): Promise<void> {
    const seconds = this.opts.recordSeconds ?? RECORD_SECONDS;
    progress(`Recording ${seconds} s from ${dev.title}, speak now`, 0);
    const audio = await this.record(dev, seconds, (seconds + 5) * 1000);
    progress("Playing back", 0.5);
    await this.play([...RAW_FORMAT, "-"], audio);
    progress("Done", 1);
  }

  private spawnRecorder(dev: Device): Proc {
    try {
      return this.runner.spawn("pw-record", ["--target", dev.name, ...RAW_FORMAT, "-"]);
    } catch (e) {
      throw new CommandError(spawnErrorMessage("pw-record", e as Error));
    }
  }

  /** Stops a recorder: SIGTERM, then SIGKILL if it hasn't exited after the grace period. */
  private stopRecorder(proc: Proc, exited: () => boolean): void {
    if (exited()) return;
    proc.kill("SIGTERM");
    const t = setTimeout(() => {
      if (!exited()) proc.kill("SIGKILL");
    }, this.opts.killGraceMs ?? 1000);
    t.unref?.();
  }

  private record(dev: Device, seconds: number, timeoutMs: number): Promise<Buffer> {
    const bytes = RATE * 2 * seconds;
    return new Promise((resolve, reject) => {
      const proc = this.spawnRecorder(dev);
      const chunks: Buffer[] = [];
      let have = 0;
      let done = false;
      let exited = false;
      let stderr = "";
      const finish = (err?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.stopRecorder(proc, () => exited);
        if (err) reject(err);
        else resolve(Buffer.concat(chunks).subarray(0, bytes));
      };
      const timer = setTimeout(() => finish(new Error(`No audio from ${dev.title} (is it muted or in use?)`)), timeoutMs);
      timer.unref?.();
      proc.stdout?.on("data", (c: Buffer) => {
        if (done) return;
        chunks.push(c);
        have += c.length;
        if (have >= bytes) finish();
      });
      proc.stderr?.on("data", (c: Buffer | string) => (stderr += String(c)));
      proc.on("error", (e) => {
        exited = true;
        finish(new CommandError(spawnErrorMessage("pw-record", e)));
      });
      proc.on("exit", (code, signal) => {
        exited = true;
        const why = stderrSummary(stderr) || (signal ? `killed by ${signal}` : `exit code ${code}`);
        finish(new CommandError(`pw-record stopped before ${seconds} s were recorded: ${why}`));
      });
      proc.stdin?.on("error", () => {});
      proc.stdin?.end();
    });
  }

  /**
   * Starts a live level meter on a source: `pw-record` → RMS per 50 ms → `emit`.
   * Returns a stop function that kills the recorder.
   */
  startLevel(dev: Device, emit: (level: number) => void, onEnd: (reason: string) => void): () => void {
    let proc: Proc;
    try {
      proc = this.spawnRecorder(dev);
    } catch (e) {
      onEnd((e as Error).message);
      return () => {};
    }
    const meter = new LevelMeter();
    let exited = false;
    let stopped = false;
    let stderr = "";
    proc.stdout?.on("data", (c: Buffer) => {
      if (stopped) return;
      const level = meter.push(c);
      if (level !== undefined) emit(level);
    });
    proc.stderr?.on("data", (c: Buffer | string) => (stderr = (stderr + String(c)).slice(-2000)));
    proc.on("error", (e) => {
      exited = true;
      if (!stopped) onEnd(spawnErrorMessage("pw-record", e));
    });
    proc.on("exit", (code, signal) => {
      exited = true;
      if (!stopped) onEnd(stderrSummary(stderr) || (signal ? `killed by ${signal}` : `exit code ${code}`));
    });
    proc.stdin?.on("error", () => {});
    proc.stdin?.end();
    return () => {
      if (stopped) return;
      stopped = true;
      this.stopRecorder(proc, () => exited);
    };
  }
}
