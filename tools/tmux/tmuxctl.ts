#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// tmuxctl: the motherapp tmux tool. Lists tmux sessions on the default socket, gives the
// command that attaches to one, and kills them. `tmuxctl serve` is the mode the core starts
// (polls every 2 s); every other subcommand works on its own from a terminal (`tmuxctl help`).
import { createTool } from "@motherapp/tool-sdk";
import { runCli } from "./src/cli.ts";
import { layout } from "./src/layout.ts";
import { RealRunner } from "./src/runner.ts";
import { INITIAL_STATE, TmuxService } from "./src/service.ts";
import { Tmux } from "./src/tmux.ts";

const runner = new RealRunner();

if (process.argv[2] === "serve") {
  // Nothing worth persisting: the list is re-read in milliseconds.
  const tool = createTool({ id: "tmux", title: "tmux", icon: "🖥️", layout, initialState: INITIAL_STATE, persist: false });
  const tmux = new Tmux({ runner });
  const service = new TmuxService({ tool, tmux });
  const serving = tool.serve();
  tool.log.info("tmux tool serving", { socket: tmux.socketPath, uid: process.getuid?.() ?? null });
  service.start();
  await serving;
  service.stop();
} else {
  process.exitCode = await runCli(process.argv.slice(2), { tmux: { runner }, stdout: process.stdout, stderr: process.stderr });
}
