#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// audioctl: the motherapp audio tool. PipeWire output/input switching, master volume and mute
// of the defaults, test sounds, a mic level meter and per-app volume and mute, over the PipeWire CLI tools (pw-dump, wpctl,
// pw-play, pw-record). `audioctl serve` is the mode the core starts; every other subcommand
// works on its own from a terminal or a keybinding (`audioctl help`).
import { createTool, exitOnBrokenPipe } from "@motherapp/tool-sdk";
import { runCli } from "./src/cli.ts";
import { layout } from "./src/layout.ts";
import { RealRunner } from "./src/runner.ts";
import { AudioService, INITIAL_STATE } from "./src/service.ts";

const runner = new RealRunner();

if (process.argv[2] === "serve") {
  const tool = createTool({ id: "audio", title: "Audio", icon: "🔊", layout, initialState: INITIAL_STATE });
  const service = new AudioService({ tool, runner });
  const serving = tool.serve();
  tool.log.info("audio tool serving");
  service.start();
  await serving;
  service.stop();
  runner.killAll();
} else {
  exitOnBrokenPipe(); // `audioctl list | head -1`
  process.exitCode = await runCli(process.argv.slice(2), { runner, stdout: process.stdout, stderr: process.stderr });
}
