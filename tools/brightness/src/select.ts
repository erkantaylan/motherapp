// Picks the backend: libddcutil in a worker thread if it loads, otherwise the ddcutil command
// (with a warning the page shows). Environment overrides, mainly for testing the fallback:
//   BRIGHTCTL_BACKEND=lib|cli     force one backend (lib: fail instead of falling back)
//   BRIGHTCTL_LIBDDCUTIL=<file>   library to load instead of libddcutil.so.4
//   BRIGHTCTL_DDCUTIL=<command>   ddcutil command for the fallback
import type { Backend } from "./backend.ts";
import { CliBackend } from "./cliBackend.ts";
import { SONAME } from "./ddca.ts";
import { LibBackend } from "./libBackend.ts";

export interface Selected {
  backend: Backend;
  /** Shown on the page and logged as a warning when set. */
  warning?: string;
}

export async function selectBackend(env: NodeJS.ProcessEnv = process.env): Promise<Selected> {
  const mode = env.BRIGHTCTL_BACKEND;
  const soname = env.BRIGHTCTL_LIBDDCUTIL || SONAME;
  let reason = "";
  if (mode !== "cli") {
    try {
      return { backend: await LibBackend.start({ soname }) };
    } catch (e) {
      if (mode === "lib") throw new Error(`cannot load ${soname}: ${(e as Error).message}`);
      reason = (e as Error).message;
    }
  }
  const cli = new CliBackend(env.BRIGHTCTL_DDCUTIL ? { command: env.BRIGHTCTL_DDCUTIL, env } : { env });
  const missing = await cli.probe();
  if (mode === "cli") return missing ? { backend: cli, warning: missing } : { backend: cli };
  let warning =
    `libddcutil could not be loaded (${reason}), so the slower ddcutil command is used instead. ` +
    `Install the libddcutil4 package and restart the brightness tool.`;
  if (missing) warning += ` The fallback doesn't work either: ${missing}.`;
  return { backend: cli, warning };
}
