#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// cpuctl: the motherapp CPU tool. Shows the CPU's per-CCX and per-core frequencies, cpufreq
// settings and temperatures from sysfs, and the saved profiles from ~/.config/motherapp/cpu.json.
// On AMD Ryzen it is read-only (the ClockTuner for Ryzen profiles are shown, not applied). On
// Intel it applies the profiles' clock caps, turbo, governor, EPP and PL1/PL2 (src/intel.ts).
// `cpuctl serve` is the mode the core starts (reads every second while its custom page, page.ts,
// is watched); every other subcommand works on its own from a terminal (`cpuctl help`).
import { createTool, exitOnBrokenPipe } from "@motherapp/tool-sdk";
import { runCli } from "./src/cli.ts";
import { stockFile } from "./src/intel.ts";
import { PowerMeter } from "./src/power.ts";
import { Voltage, guardFile, spawnRunner, voltageCommand } from "./src/voltage.ts";
import { toolTitle } from "./src/model.ts";
import { CpuService, INITIAL_STATE } from "./src/service.ts";
import { settingsFile } from "./src/settings.ts";
import { DEFAULT_ROOT, SysReader, readCpuinfo, readSnapshot } from "./src/sysfs.ts";

const root = process.env.MOTHERAPP_CPU_ROOT || DEFAULT_ROOT;
// Only on Intel: the helper refuses anything else, and there is no point asking sudo.
const intel = readCpuinfo(new SysReader(root)).vendor === "GenuineIntel";
const voltage = intel ? new Voltage(spawnRunner(voltageCommand())) : undefined;

if (process.argv[2] === "serve") {
  // Nothing worth persisting: every value is re-read from sysfs in about a millisecond.
  // "CPU - AMD" / "CPU - Intel": describe's title replaces the manifest's neutral "CPU" in the sidebar.
  const title = toolTitle(intel ? "GenuineIntel" : readCpuinfo(new SysReader(root)).vendor);
  const tool = createTool({ id: "cpu", title, icon: "🌡️", page: "custom", initialState: INITIAL_STATE, persist: false });
  const service = new CpuService({ tool, read: () => readSnapshot(root), settingsFile: settingsFile(), limits: { root, stockFile: stockFile(), guardFile: guardFile(), ...(voltage ? { voltage } : {}) }, power: new PowerMeter(root) });
  const serving = tool.serve();
  tool.log.info("cpu tool serving", { root, title, settings: settingsFile() });
  service.start();
  await serving;
  service.stop();
} else {
  exitOnBrokenPipe(); // `cpuctl status | head -1`
  process.exitCode = await runCli(process.argv.slice(2), { root, settingsFile: settingsFile(), stockFile: stockFile(), guardFile: guardFile(), ...(voltage ? { voltage } : {}), stdout: process.stdout, stderr: process.stderr });
}
