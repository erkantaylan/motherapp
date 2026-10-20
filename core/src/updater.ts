// Settings -> "Update now" (DESIGN.md § 3 "Releases"). Runs `motherapp install` outside the
// service, as the transient systemd user unit `motherapp-update`:
//
//   systemd-run --user --unit=motherapp-update --collect --quiet --setenv=… \
//     /bin/bash -c '<run and log>' motherapp-update ~/.local/state/motherapp/update.log \
//     ~/.local/bin/motherapp install
//
// so the restart it causes doesn't kill it. Everything it prints goes to update.log, which ends
// with a "finished … exit N" line; the core reads the log back (also after its own restart) for
// the page: running/done/failed, the tail, the old → new summary, the reason for a failure.
// MOTHERAPP_UNATTENDED=1 makes install.sh fail at once, with "run `motherapp install` in a
// terminal", where sudo would ask for a password; GIT_TERMINAL_PROMPT=0 does the same for git.
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { UpdateStatus } from "@motherapp/protocol";

export type CommandRunner = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export const realRunner: CommandRunner = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15_000, encoding: "utf8" }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
      const code = e === null ? 0 : typeof e.code === "number" ? e.code : 127;
      resolve({ code, stdout, stderr: stderr || (e && typeof e.code !== "number" ? e.message : "") });
    });
  });

export interface UpdaterOptions {
  /** ~/.local/state/motherapp/update.log */
  logFile: string;
  /** The update command, e.g. ["/home/u/.local/bin/motherapp", "install"]. */
  command: string[];
  /** Extra environment for the unit (on top of MOTHERAPP_UNATTENDED and GIT_TERMINAL_PROMPT). */
  env?: Record<string, string>;
  /** The running build's version string, for the log's first line. */
  running?: string;
  run?: CommandRunner;
  now?: () => number;
  unit?: string;
  systemdRun?: string;
  systemctl?: string;
  bash?: string;
  tailLines?: number;
}

export const UPDATE_UNIT = "motherapp-update";
const FINISHED = /^== motherapp update finished (\S+): exit (\d+) ==$/m;
const STARTED = /^== motherapp update started (\S+)/m;
// Runs the command with all output in the log, then appends the finish line with its exit code.
const WRAPPER = 'log=$1; shift; "$@" >>"$log" 2>&1; c=$?; printf \'\\n== motherapp update finished %s: exit %d ==\\n\' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$c" >>"$log"; exit "$c"';

export class UpdateBusyError extends Error {}

export class Updater {
  private o: Required<Omit<UpdaterOptions, "env" | "running">> & Pick<UpdaterOptions, "env" | "running">;
  /** Between writing the log's first line and systemd-run returning. */
  private starting = false;

  constructor(opts: UpdaterOptions) {
    this.o = {
      run: realRunner,
      now: Date.now,
      unit: UPDATE_UNIT,
      systemdRun: "systemd-run",
      systemctl: "systemctl",
      bash: "/bin/bash",
      tailLines: 200,
      ...opts,
    };
  }

  /** The `motherapp-update` unit is active (or starting/stopping). */
  async isRunning(): Promise<boolean> {
    const r = await this.o.run(this.o.systemctl, ["--user", "is-active", `${this.o.unit}.service`]);
    return ["active", "activating", "deactivating", "reloading"].includes(r.stdout.trim());
  }

  async status(): Promise<UpdateStatus> {
    const running = this.starting || (await this.isRunning());
    return parseUpdateLog(this.readLog(), running, this.o.tailLines);
  }

  /** Starts the update. Throws UpdateBusyError when one is already running. */
  async start(): Promise<UpdateStatus> {
    if (this.starting || (await this.isRunning())) {
      throw new UpdateBusyError(`an update is already running (${this.o.unit}); wait for it to finish`);
    }
    this.starting = true;
    try {
      const at = new Date(this.o.now()).toISOString();
      fs.mkdirSync(path.dirname(this.o.logFile), { recursive: true });
      fs.writeFileSync(this.o.logFile, `== motherapp update started ${at} (Settings -> Update now; running ${this.o.running ?? "unknown"}) ==\n+ ${this.o.command.join(" ")}\n`);
      const env = { MOTHERAPP_UNATTENDED: "1", GIT_TERMINAL_PROMPT: "0", ...this.o.env };
      const args = [
        "--user",
        `--unit=${this.o.unit}`,
        "--collect",
        "--quiet",
        `--description=motherapp update (Settings -> Update now)`,
        ...Object.entries(env).map(([k, v]) => `--setenv=${k}=${v}`),
        this.o.bash,
        "-c",
        WRAPPER,
        this.o.unit,
        this.o.logFile,
        ...this.o.command,
      ];
      const r = await this.o.run(this.o.systemdRun, args);
      if (r.code !== 0) {
        const why = (r.stderr || r.stdout).trim() || `exit ${r.code}`;
        fs.appendFileSync(this.o.logFile, `motherapp: couldn't start the update: systemd-run: ${why}\n\n== motherapp update finished ${new Date(this.o.now()).toISOString()}: exit ${r.code || 1} ==\n`);
      }
    } finally {
      this.starting = false;
    }
    return this.status();
  }

  private readLog(): string | undefined {
    try {
      return fs.readFileSync(this.o.logFile, "utf8");
    } catch {
      return undefined;
    }
  }
}

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/** Turns update.log (undefined: none yet) into what the page shows. */
export function parseUpdateLog(text: string | undefined, running: boolean, tailLines = 200): UpdateStatus {
  if (text === undefined) return running ? { state: "running", log: "" } : { state: "idle", log: "" };
  const clean = text.replace(ANSI, "");
  const lines = clean.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let log = lines.slice(-tailLines).join("\n");
  if (log.length > 32 * 1024) log = log.slice(-32 * 1024);
  const out: UpdateStatus = { state: "running", log };
  const started = STARTED.exec(clean);
  if (started) out.startedAt = started[1]!;
  // "    v1-abc1234 → v2-def5678" (motherapp install's summary) or "already up to date (…)".
  const arrow = /^\s+(\S+ → \S+)\s*$/m.exec(clean);
  const upToDate = /^(already up to date.*)$/m.exec(clean);
  if (arrow) out.summary = arrow[1]!;
  else if (upToDate) out.summary = upToDate[1]!;
  const finished = FINISHED.exec(clean);
  if (running && !finished) return out;
  if (!finished) {
    out.state = "failed";
    out.message = "the update stopped without finishing (see the log)";
    return out;
  }
  out.finishedAt = finished[1]!;
  out.exitCode = Number(finished[2]);
  if (out.exitCode === 0) {
    out.state = "done";
    return out;
  }
  out.state = "failed";
  out.message = failureReason(clean, out.exitCode);
  return out;
}

function failureReason(log: string, code: number): string {
  const lines = log.split("\n");
  // install.sh's row when sudo needed a password (MOTHERAPP_UNATTENDED).
  const sudo = lines.find((l) => /^FAIL +sudo +/.test(l));
  if (sudo) return sudo.replace(/^FAIL +sudo +/, "");
  // motherapp.sh's die(): "motherapp: refusing: …" (several lines for local changes).
  const own = lines.filter((l) => l.startsWith("motherapp: ")).map((l) => l.slice("motherapp: ".length));
  if (own.length) return own.join(" ");
  const failRows = lines.filter((l) => /^(FAIL|MISSING) +\S+/.test(l)).map((l) => l.replace(/ +/g, " "));
  const installer = lines.find((l) => /\.\/install\.sh exited with \d+/.test(l));
  if (failRows.length) return `./install.sh failed: ${[...new Set(failRows)].slice(0, 3).join("; ")}`;
  if (installer) return installer.trim();
  return `motherapp install exited with ${code} (see the log)`;
}
