// Saving a pane's screen for idle-detector fixtures: `tmux capture-pane -p -t <pane>` written to
// `~/.local/state/motherapp/inbox/screens/<timestamp>.txt` (directory 0700, file 0600: the
// screen can show anything the session showed). Used by the page's "Save screen" button and by
// `inboxctl screen <pane>`. Nothing about the screen is logged; only the file name is reported.
import * as fs from "node:fs";
import * as path from "node:path";
import { idleState } from "./idle.ts";
import type { Idle } from "./idle.ts";

export interface ScreenSource {
  capture(id: string): Promise<string>;
}

export interface SavedScreen {
  file: string;
  /** What the idle detector makes of this screen (copy mode as tmux reported it). */
  verdict: Idle;
}

/** `2026-10-20T12-34-56-789Z`: an ISO time that is a safe file name and sorts by time. */
export function screenStamp(now: number): string {
  return new Date(now).toISOString().replace(/:/g, "-").replace(".", "-");
}

export function screensDir(stateDir: string): string {
  return path.join(stateDir, "screens");
}

export async function saveScreen(src: ScreenSource, stateDir: string, paneId: string, inMode: boolean, now: number): Promise<SavedScreen> {
  const text = await src.capture(paneId);
  const dir = screensDir(stateDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  let file = path.join(dir, `${screenStamp(now)}.txt`);
  for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `${screenStamp(now)}-${i}.txt`);
  fs.writeFileSync(file, text, { mode: 0o600, flag: "wx" });
  return { file, verdict: idleState(text, inMode) };
}
