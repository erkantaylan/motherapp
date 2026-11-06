// OS notifications from the service, so they work with no browser open. notify-send when it is
// installed, else straight to org.freedesktop.Notifications with gdbus. Only the session name and
// the state word ever go in: never pane text, prompts or Claude's messages.
import { run, SpawnError } from "./runner.ts";
import type { Runner } from "./runner.ts";

export interface Notifier {
  send(name: string, word: string): void;
}

export const SUMMARY = "tmux";
const ICON = "utilities-terminal";
const TIMEOUT_MS = 8000;

/** GNOME Shell reads the body as markup, so a name like `a<b` must be escaped. */
export function notifyBody(name: string, word: string): string {
  return `${name.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}: ${word}`;
}

export function notifySendArgs(body: string): string[] {
  return ["-a", "motherapp", "-i", ICON, "--", SUMMARY, body];
}

/** gdbus parses each argument as GVariant text, so a string must be quoted as one. */
const gvariantString = (s: string): string => `'${s.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

export function gdbusArgs(body: string): string[] {
  return [
    "call", "--session",
    "--dest", "org.freedesktop.Notifications",
    "--object-path", "/org/freedesktop/Notifications",
    "--method", "org.freedesktop.Notifications.Notify",
    "motherapp", "0", ICON, SUMMARY, gvariantString(body), "[]", "{}", String(TIMEOUT_MS),
  ];
}

export interface DesktopLog {
  warn(msg: string): void;
}

export class DesktopNotifier implements Notifier {
  private runner: Runner;
  private log: DesktopLog;
  /** Which sender works, once one has been tried. */
  private cmd: "notify-send" | "gdbus" | undefined = "notify-send";
  private warned = "";

  constructor(runner: Runner, log: DesktopLog) {
    this.runner = runner;
    this.log = log;
  }

  send(name: string, word: string): void {
    void this.deliver(notifyBody(name, word));
  }

  private async deliver(body: string): Promise<void> {
    while (this.cmd) {
      const cmd = this.cmd;
      try {
        const res = await run(this.runner, cmd, cmd === "gdbus" ? gdbusArgs(body) : notifySendArgs(body), 5000);
        if (res.code !== 0) this.warnOnce(`${cmd} failed: ${res.stderr.split("\n")[0] || `exit code ${res.code}`}`);
        return;
      } catch (e) {
        if (!(e instanceof SpawnError)) throw e;
        if (this.cmd === cmd) this.cmd = cmd === "notify-send" ? "gdbus" : undefined;
      }
    }
    this.warnOnce("No notifications: neither notify-send nor gdbus could be started.");
  }

  private warnOnce(msg: string): void {
    if (msg === this.warned) return;
    this.warned = msg;
    this.log.warn(msg);
  }
}

/** MOTHERAPP_TMUX_NOTIFY=off: for a test core, which sees the user's real sessions. */
export const silentNotifier: Notifier = { send() {} };
