// Stand-in for pw-dump, wpctl, pw-cli, pw-play and pw-record in the end-to-end test (no PipeWire in CI).
//   node fake-pipewire.ts <command> [args…]      with FAKE_PW_DIR set
// Every invocation is appended to $FAKE_PW_DIR/calls.log as a JSON line.
// `pw-dump --monitor` prints the fixture dump ($FAKE_PW_DUMP, default pw-dump.json), then every
// file dropped into $FAKE_PW_DIR/queue. `wpctl set-profile <card> <index>` copies
// $FAKE_PW_DIR/profiles/<card>-<index>.txt (pw-dump --monitor batches) into the queue, the way
// WirePlumber recreates the card's nodes.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const dir = process.env.FAKE_PW_DIR!;
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const [cmd, ...args] = process.argv.slice(2);
const log = (entry: Record<string, unknown>) => fs.appendFileSync(path.join(dir, "calls.log"), JSON.stringify({ cmd, ...entry }) + "\n");
log({ args });
process.on("SIGTERM", () => {
  log({ signal: "SIGTERM" });
  process.exit(0);
});

const dump = () => fs.readFileSync(path.join(fixtures, process.env.FAKE_PW_DUMP ?? "pw-dump.json"), "utf8");

if (cmd === "pw-dump" && args[0] === "--monitor") {
  process.stdout.write(dump());
  const queue = path.join(dir, "queue");
  setInterval(() => {
    let files: string[] = [];
    try {
      files = fs.readdirSync(queue).filter((f) => f.endsWith(".json")).sort();
    } catch {
      return;
    }
    for (const f of files) {
      process.stdout.write(fs.readFileSync(path.join(queue, f), "utf8") + "\n");
      fs.unlinkSync(path.join(queue, f));
    }
  }, 20);
} else if (cmd === "pw-dump") {
  process.stdout.write(dump());
} else if (cmd === "pw-record") {
  // a steady -20 dBFS square wave, 50 ms at a time
  const chunk = Buffer.alloc(4800);
  for (let i = 0; i < 2400; i++) chunk.writeInt16LE(i % 2 ? 3277 : -3277, i * 2);
  setInterval(() => process.stdout.write(chunk), 50);
} else if (cmd === "wpctl" && args[0] === "set-profile") {
  const batches = path.join(dir, "profiles", `${args[1]}-${args[2]}.txt`);
  if (fs.existsSync(batches)) {
    const parts = fs.readFileSync(batches, "utf8").trim().split(/\n(?=\[)/);
    parts.forEach((b, i) => {
      const f = path.join(dir, "queue", `p${Date.now()}-${String(i).padStart(3, "0")}`);
      fs.writeFileSync(f + ".tmp", b);
      fs.renameSync(f + ".tmp", f + ".json"); // the monitor never sees half a batch
    });
  }
} else if (cmd === "wpctl" && args[0] === "set-mute" && args[1] === "115") {
  process.stderr.write("Object '115' not found\n");
  process.exit(1);
}
// wpctl and pw-play: exit 0
