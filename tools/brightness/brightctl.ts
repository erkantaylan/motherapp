#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// brightctl: the motherapp brightness tool. Monitor brightness over DDC/CI through libddcutil
// (kept loaded in a worker thread), with the ddcutil command as the fallback.
// `brightctl serve` is the mode the core starts; every other subcommand works from a terminal
// or a keybinding (`brightctl help`).
import { createTool, exitOnBrokenPipe } from "@motherapp/tool-sdk";
import { runCli } from "./src/cli.ts";
import { layout } from "./src/layout.ts";
import { selectBackend } from "./src/select.ts";
import { BrightnessService, INITIAL_STATE } from "./src/service.ts";
import { isolateStdout } from "./src/stdio.ts";

if (process.argv[2] === "serve") {
  // Before libddcutil is loaded: keep its C stdout output off the JSON-RPC channel.
  const output = process.env.BRIGHTCTL_BACKEND === "cli" ? undefined : isolateStdout();
  const tool = createTool({ id: "brightness", title: "Brightness", icon: "🔆", layout, initialState: INITIAL_STATE, ...(output ? { output } : {}) });
  const service = new BrightnessService({ tool, backend: () => selectBackend() });
  process.once("exit", () => void service.stop());
  const serving = tool.serve();
  tool.log.info("brightness tool serving");
  void service.start();
  await serving;
  await service.stop();
} else {
  exitOnBrokenPipe(); // `brightctl list | head -1`
  process.exitCode = await runCli(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
    isolateStdout: () => {
      if (process.env.BRIGHTCTL_BACKEND === "cli") return undefined;
      const out = isolateStdout();
      if (out) exitOnBrokenPipe(out); // the real stdout, on its duplicated fd
      return out;
    },
  });
}
