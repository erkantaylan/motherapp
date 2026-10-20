// Stand-ins for `tmux` and `cloudflared` in the end-to-end test:
//   node fake-bins.ts tmux [args…]          with FAKE_DIR set
//   node fake-bins.ts cloudflared [args…]
// tmux: the panes are $FAKE_DIR/panes.json (an array, see FakePane in fakes.ts); list-panes,
// capture-pane and send-keys work on it. cloudflared: prints the quick-tunnel banner and waits
// for SIGTERM. Every invocation is appended to $FAKE_DIR/calls.log as a JSON line.
import * as fs from "node:fs";
import * as path from "node:path";
import { QUICK_OUTPUT, screenOf } from "./fakes.ts";
import type { FakePane } from "./fakes.ts";

const dir = process.env.FAKE_DIR!;
const [bin, ...args] = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "calls.log"), JSON.stringify([bin, ...args]) + "\n");

if (bin === "cloudflared") {
  process.stderr.write(QUICK_OUTPUT("e2e-fake-host"));
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 1000);
} else {
  const file = path.join(dir, "panes.json");
  const panes = JSON.parse(fs.readFileSync(file, "utf8")) as FakePane[];
  const a = args.filter((x) => x !== "-u");
  if (a[0] === "-S") a.splice(0, 2);
  const cmd = a[0];
  const target = a[a.indexOf("-t") + 1];
  const p = panes.find((x) => x.id === target);
  if (cmd === "list-panes") {
    for (const x of panes) process.stdout.write([x.id, x.session, x.window, x.index, x.pid, x.inMode ? 1 : 0, x.attached, x.command, x.path].join("\t") + "\n");
  } else if (!p) {
    process.stderr.write(`can't find pane: ${target}\n`);
    process.exitCode = 1;
  } else if (cmd === "capture-pane") {
    process.stdout.write(screenOf(p));
  } else if (cmd === "send-keys" && a[3] === "-l") {
    let text = a[4] === "--" ? a[5]! : a[4]!;
    if (text.endsWith("\\;")) text = text.slice(0, -2) + ";";
    p.input += text;
  } else if (cmd === "send-keys" && a.length === 4 && a[3] === "Enter") {
    if (p.input) p.submitted.push(p.input);
    p.input = "";
  } else {
    process.stderr.write(`unexpected: ${a.join(" ")}\n`);
    process.exitCode = 1;
  }
  fs.writeFileSync(file, JSON.stringify(panes));
}
