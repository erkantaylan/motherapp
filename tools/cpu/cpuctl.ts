#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// cpuctl: the motherapp CPU tool (read-only for now). Shows the CPU's per-CCX and per-core
// frequencies, cpufreq settings and temperatures from sysfs, and the saved ClockTuner for
// Ryzen profiles from ~/.config/motherapp/cpu.json. `cpuctl serve` is the mode the core starts
// (reads every second while its custom page, page.ts, is watched); every other subcommand works on its own
// from a terminal (`cpuctl help`). Nothing here writes to the hardware or to sysfs.
import { createTool, exitOnBrokenPipe } from "@motherapp/tool-sdk";
import { runCli } from "./src/cli.ts";
import { toolTitle } from "./src/model.ts";
import { CpuService, INITIAL_STATE } from "./src/service.ts";
import { settingsFile } from "./src/settings.ts";
import { DEFAULT_ROOT, SysReader, readCpuinfo, readSnapshot } from "./src/sysfs.ts";

const root = process.env.MOTHERAPP_CPU_ROOT || DEFAULT_ROOT;

if (process.argv[2] === "serve") {
  // Nothing worth persisting: every value is re-read from sysfs in about a millisecond.
  // "CPU - AMD" / "CPU - Intel": describe's title replaces the manifest's neutral "CPU" in the sidebar.
  const title = toolTitle(readCpuinfo(new SysReader(root)).vendor);
  const tool = createTool({ id: "cpu", title, icon: "🌡️", page: "custom", initialState: INITIAL_STATE, persist: false });
  const service = new CpuService({ tool, read: () => readSnapshot(root), settingsFile: settingsFile() });
  const serving = tool.serve();
  tool.log.info("cpu tool serving", { root, title, settings: settingsFile() });
  service.start();
  await serving;
  service.stop();
} else {
  exitOnBrokenPipe(); // `cpuctl status | head -1`
  process.exitCode = await runCli(process.argv.slice(2), { root, settingsFile: settingsFile(), stdout: process.stdout, stderr: process.stderr });
}
