// Opening a session in a real terminal window on this machine.
//
// `--no-dbus` is mandatory: without it a running Terminator hands the command to `zsh -c` as a
// string, where the leading "=" of `-t =name` is zsh equals-expansion and the attach fails.
// Everything stays an argv list, so a name like `my app; echo x` needs no quoting.
//
// Under the systemd service a window would be in the service's cgroup, and `KillMode=mixed`
// SIGKILLs what's left there on every stop: updating motherapp would close the user's windows,
// however detached they are. So the window gets a scope of its own.
import { spawn } from "node:child_process";

export const TERMINAL = ["terminator", "--no-dbus", "-x"];
const SCOPE = ["systemd-run", "--user", "--scope", "--collect", "--quiet", "--"];
/** A window that fails to start exits within this. One that's still up has opened. */
export const GRACE_MS = 800;

export function openArgv(attach: string[], env: NodeJS.ProcessEnv): string[] {
  return [...(env.INVOCATION_ID ? SCOPE : []), ...TERMINAL, ...attach];
}

/** tmux refuses to nest: inside a session these two would stop `attach`. */
export function openEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  delete out.TMUX;
  delete out.TMUX_PANE;
  return out;
}

export type Launcher = (argv: string[], env: NodeJS.ProcessEnv) => Promise<void>;

/** Starts a detached process. Rejects if it can't start or fails at once. */
export const launch: Launcher = (argv, env) =>
  new Promise((resolve, reject) => {
    const [cmd, ...args] = argv as [string, ...string[]];
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", env });
    const timer = setTimeout(() => {
      child.removeAllListeners();
      child.unref();
      resolve();
    }, GRACE_MS);
    child.once("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new Error(e.code === "ENOENT" ? `${cmd} isn't installed.` : `Can't start ${cmd}: ${e.message}`));
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`The terminal closed at once (${signal ?? `exit code ${code}`}).`));
    });
  });
