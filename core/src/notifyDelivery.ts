// What a notification does on the desktop (DESIGN.md § 3 "Notifications"): a popup as the
// application "motherapp" (notify-send when it is installed, else straight to
// org.freedesktop.Notifications with gdbus), and a sound with pw-play. Both carry nothing but
// what the caller hands over; nothing here reads settings.
//
// MOTHERAPP_NOTIFY=off turns both off for a whole core (a test core, a dev core). A core started
// under `node --test` is off unless MOTHERAPP_NOTIFY=on, so no test can reach the real desktop.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { NO_SOUND } from "@motherapp/protocol";

/** The application name, and the desktop entry (`motherapp.desktop`, written by install.sh). */
export const APP_NAME = "motherapp";
export const SOUND_DIR = "/usr/share/sounds/freedesktop/stereo";
const SOUND_EXT = ".oga";
const POPUP_TIMEOUT_MS = 8000;
const RUN_TIMEOUT_MS = 5000;
/** The longest stock sound is a few seconds; anything still playing after this is killed. */
const PLAY_TIMEOUT_MS = 15_000;

export interface ExecResult {
  code: number | null;
  stderr: string;
}

export interface Running {
  /** Resolves on any exit; rejects (an error with `code: "ENOENT"`) when it can't be started. */
  done: Promise<ExecResult>;
  kill(): void;
}

/** Starts a command with an argv list (never a shell). Tests swap in a fake. */
export type Exec = (cmd: string, args: string[], timeoutMs: number) => Running;

export const realExec: Exec = (cmd, args, timeoutMs) => {
  const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
  const done = new Promise<ExecResult>((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    timer.unref();
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => {
      if (stderr.length < 4096) stderr += c;
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
  return { done, kill: () => void child.kill("SIGTERM") };
};

/** Does this core show popups and play sounds? See the header. */
export function deliveryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.MOTHERAPP_NOTIFY ?? "").toLowerCase();
  if (v === "off" || v === "0" || v === "false") return false;
  if (v === "on" || v === "1" || v === "true") return true;
  return env.NODE_TEST_CONTEXT === undefined;
}

/** GNOME Shell reads the body as markup, so a name like `a<b` must be escaped. */
export function escapeMarkup(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** The popup's second part: the tool's name, then the tool's own text on the next line. */
export function popupBody(toolTitle: string, body?: string): string {
  return body ? `${escapeMarkup(toolTitle)}\n${escapeMarkup(body)}` : escapeMarkup(toolTitle);
}

/**
 * `desktop-entry` is what makes GNOME file the popup under motherapp (its name and icon, and
 * its row in Settings -> Notifications) instead of under "notify-send". `--` so a title can't
 * be an option.
 */
export function notifySendArgs(icon: string, summary: string, body: string): string[] {
  return ["-a", APP_NAME, "-i", icon, "-h", `string:desktop-entry:${APP_NAME}`, "--", summary, body];
}

/** gdbus parses each argument as GVariant text, so a string must be quoted as one. */
const gvariantString = (s: string): string => `'${s.replaceAll("\\", "\\\\").replaceAll("'", "\\'").replaceAll("\n", "\\n")}'`;

/** No actions (`[]`): nothing happens on a click. */
export function gdbusArgs(icon: string, summary: string, body: string): string[] {
  return [
    "call", "--session",
    "--dest", "org.freedesktop.Notifications",
    "--object-path", "/org/freedesktop/Notifications",
    "--method", "org.freedesktop.Notifications.Notify",
    APP_NAME, "0", gvariantString(icon), gvariantString(summary), gvariantString(body), "[]",
    `{'desktop-entry': <'${APP_NAME}'>}`, String(POPUP_TIMEOUT_MS),
  ];
}

const SOUND_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The stock sounds: `<dir>/*.oga` without the extension, sorted. A missing dir is an empty list. */
export function listSounds(dir: string = SOUND_DIR): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(SOUND_EXT))
    .map((n) => n.slice(0, -SOUND_EXT.length))
    .filter((n) => SOUND_NAME_RE.test(n) && n !== NO_SOUND)
    .sort();
}

export interface Delivery {
  /** False: popup() and play() do nothing. */
  readonly enabled: boolean;
  popup(summary: string, body: string): void;
  /** Plays a sound by name; "none" and names that aren't in sounds() play nothing. */
  play(sound: string, opts?: { preview?: boolean }): void;
  sounds(): string[];
}

export interface DesktopDeliveryOptions {
  enabled?: boolean;
  exec?: Exec;
  /** The popup's icon: an absolute file path or an icon name. */
  icon?: string;
  soundDir?: string;
  warn(msg: string): void;
}

export class DesktopDelivery implements Delivery {
  readonly enabled: boolean;
  private exec: Exec;
  private icon: string;
  private soundDir: string;
  private warn: (msg: string) => void;
  /** Which popup sender works, once one has been tried. */
  private cmd: "notify-send" | "gdbus" | undefined = "notify-send";
  private warned = new Set<string>();
  private preview: Running | undefined;

  constructor(opts: DesktopDeliveryOptions) {
    this.enabled = opts.enabled ?? true;
    this.exec = opts.exec ?? realExec;
    this.icon = opts.icon ?? APP_NAME;
    this.soundDir = opts.soundDir ?? SOUND_DIR;
    this.warn = opts.warn;
  }

  sounds(): string[] {
    const list = listSounds(this.soundDir);
    if (list.length === 0) this.warnOnce(`No notification sounds: no ${SOUND_EXT} files in ${this.soundDir} (Ubuntu package: sound-theme-freedesktop).`);
    return list;
  }

  popup(summary: string, body: string): void {
    if (!this.enabled) return;
    void this.sendPopup(summary, body).catch((e: Error) => this.warnOnce(`notification popup failed: ${e.message}`));
  }

  private async sendPopup(summary: string, body: string): Promise<void> {
    while (this.cmd) {
      const cmd = this.cmd;
      const args = cmd === "gdbus" ? gdbusArgs(this.icon, summary, body) : notifySendArgs(this.icon, summary, body);
      try {
        const res = await this.exec(cmd, args, RUN_TIMEOUT_MS).done;
        if (res.code !== 0) this.warnOnce(`${cmd} failed: ${res.stderr.split("\n")[0] || `exit code ${res.code}`}`);
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        if (this.cmd === cmd) this.cmd = cmd === "notify-send" ? "gdbus" : undefined;
      }
    }
    this.warnOnce("No notification popups: neither notify-send nor gdbus could be started.");
  }

  play(sound: string, opts: { preview?: boolean } = {}): void {
    if (!this.enabled || sound === NO_SOUND) return;
    // Only a name from the directory listing ever becomes a path.
    if (!this.sounds().includes(sound)) {
      this.warnOnce(`No sound "${sound.slice(0, 64)}" in ${this.soundDir}; playing nothing for it.`);
      return;
    }
    if (opts.preview) this.preview?.kill();
    const running = this.exec("pw-play", [path.join(this.soundDir, sound + SOUND_EXT)], PLAY_TIMEOUT_MS);
    if (opts.preview) this.preview = running;
    running.done.then(
      (res) => {
        if (res.code !== 0 && res.code !== null) this.warnOnce(`pw-play failed: ${res.stderr.split("\n")[0] || `exit code ${res.code}`}`);
      },
      (e: NodeJS.ErrnoException) =>
        this.warnOnce(e.code === "ENOENT" ? "No notification sounds: pw-play could not be started (Ubuntu package: pipewire-bin)." : `pw-play failed: ${e.message}`),
    ).finally(() => {
      if (this.preview === running) this.preview = undefined;
    });
  }

  private warnOnce(msg: string): void {
    if (this.warned.has(msg)) return;
    this.warned.add(msg);
    this.warn(msg);
  }
}
