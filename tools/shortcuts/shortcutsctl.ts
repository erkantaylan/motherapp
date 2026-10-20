#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// shortcutsctl: the motherapp shortcuts tool. Lists GNOME's custom keyboard shortcuts and adds,
// edits and removes the ones motherapp owns (dconf paths …/custom-keybindings/motherapp-*/).
// `shortcutsctl serve` is the mode the core starts; every other subcommand works on its own
// from a terminal (`shortcutsctl help`).
import { createTool } from "@motherapp/tool-sdk";
import { runCli } from "./src/cli.ts";
import { Gnome } from "./src/gnome.ts";
import { defaultEnv } from "./src/ops.ts";
import { RealRunner } from "./src/runner.ts";
import { INITIAL_STATE, ShortcutsService } from "./src/service.ts";

const runner = new RealRunner();
const env = defaultEnv();

if (process.argv[2] === "serve") {
  // Nothing worth persisting: the list is re-read from dconf in milliseconds.
  const tool = createTool({ id: "shortcuts", title: "Shortcuts", icon: "⌨️", page: "custom", initialState: INITIAL_STATE, persist: false });
  const service = new ShortcutsService({ tool, gnome: new Gnome({ runner }), env });
  const serving = tool.serve();
  tool.log.info("shortcuts tool serving", { binDir: env.binDir, dbus: process.env.DBUS_SESSION_BUS_ADDRESS ?? null });
  service.start();
  await serving;
  service.stop();
} else {
  process.exitCode = await runCli(process.argv.slice(2), { runner, env, stdout: process.stdout, stderr: process.stderr });
}
