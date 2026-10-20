// Stand-in for the ddcutil command (no monitors or /dev/i2c in CI), in the output format
// ddcutil 1.4.1 printed on the machine (machine-facts/raw-output.txt).
//   node fake-ddcutil.ts [args…]      with FAKE_DDC_DIR set
// $FAKE_DDC_DIR/bus-<N>.json is one monitor: { connector, mfg, model, serial, value, max, off? }.
// Every call is appended to $FAKE_DDC_DIR/calls.log; FAKE_DDC_DELAY_MS delays each call.
import * as fs from "node:fs";
import * as path from "node:path";

const dir = process.env.FAKE_DDC_DIR!;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "calls.log"), JSON.stringify(args) + "\n");
const delay = Number(process.env.FAKE_DDC_DELAY_MS ?? 0);
if (delay > 0) await new Promise((r) => setTimeout(r, delay));

interface Mon {
  connector: string;
  mfg: string;
  model: string;
  serial: string;
  value: number;
  max: number;
  off?: boolean;
}
const file = (bus: string) => path.join(dir, `bus-${bus}.json`);
const load = (bus: string): Mon | undefined => {
  try {
    return JSON.parse(fs.readFileSync(file(bus), "utf8")) as Mon;
  } catch {
    return undefined;
  }
};

if (args[0] === "--version") {
  process.stdout.write("ddcutil 1.4.1\nCopyright (C) 2015-2023 Sanford Rockowitz\n");
} else if (args[0] === "detect") {
  const buses = fs.readdirSync(dir).map((f) => f.match(/^bus-(\d+)\.json$/)?.[1]).filter((b): b is string => b !== undefined).sort();
  let n = 0;
  for (const bus of buses) {
    const m = load(bus)!;
    if (m.off) {
      process.stdout.write(`Invalid display\n   I2C bus:          /dev/i2c-${bus}\n   DRM connector:    card1-${m.connector}\n   EDID synopsis:\n      Mfg id:               ${m.mfg}\n   DDC communication failed\n\n`);
      continue;
    }
    n++;
    process.stdout.write(`Display ${n}\n   I2C bus:          /dev/i2c-${bus}\n   DRM connector:    card1-${m.connector}\n   Monitor:          ${m.mfg}:${m.model}:${m.serial}\n\n`);
  }
  if (n === 0 && buses.length === 0) process.stdout.write("No displays found.\n");
} else if (args[0] === "--bus") {
  const bus = args[1]!;
  const m = load(bus);
  if (!m) {
    process.stdout.write(`No monitor detected on bus /dev/i2c-${bus}\n`);
    process.exit(1);
  }
  if (m.off) {
    process.stdout.write(`DDC communication failed for monitor on bus /dev/i2c-${bus}\n`);
    process.exit(1);
  }
  if (args[2] === "getvcp" && args[3] === "10") {
    process.stdout.write(`VCP code 0x10 (Brightness                    ): current value = ${String(m.value).padStart(5)}, max value = ${String(m.max).padStart(5)}\n`);
  } else if (args[2] === "setvcp" && args[3] === "10") {
    m.value = Number(args[4]);
    fs.writeFileSync(file(bus), JSON.stringify(m));
  } else {
    process.stderr.write(`fake ddcutil: unsupported ${args.join(" ")}\n`);
    process.exit(2);
  }
} else {
  process.stderr.write(`fake ddcutil: unsupported ${args.join(" ")}\n`);
  process.exit(2);
}
