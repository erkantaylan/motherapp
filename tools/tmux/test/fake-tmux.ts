// Stand-in for `tmux` in the end-to-end test:   node fake-tmux.ts [args…]   with FAKE_TMUX_DIR set.
// The "server" is $FAKE_TMUX_DIR/server.json: an array of sessions, or "none" for no server.
// Every invocation is appended to $FAKE_TMUX_DIR/calls.log as a JSON line.
import * as fs from "node:fs";
import * as path from "node:path";

type S = { id: string; name: string; windows: number; created: number; attached: number; activity: number; command: string; path: string };

const dir = process.env.FAKE_TMUX_DIR!;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "calls.log"), JSON.stringify(args) + "\n");
const file = path.join(dir, "server.json");
const server = JSON.parse(fs.readFileSync(file, "utf8")) as S[] | "none";
const cmd = args.find((a) => !a.startsWith("-") && a !== "-u");

if (server === "none") {
  process.stderr.write("no server running on /tmp/tmux-fake/default\n");
  process.exit(1);
}
if (cmd === "list-sessions") {
  for (const s of server) process.stdout.write([s.id, s.name, s.windows, s.created, s.attached, s.activity, s.command, s.path].join("\t") + "\n");
} else if (cmd === "kill-session") {
  const t = args[args.indexOf("-t") + 1]!;
  const rest = server.filter((s) => (t.startsWith("=") ? s.name !== t.slice(1) : s.id !== t));
  if (rest.length === server.length) {
    process.stderr.write(`can't find session: ${t}\n`);
    process.exit(1);
  }
  fs.writeFileSync(file, JSON.stringify(rest));
} else {
  process.stderr.write(`unknown command ${cmd}\n`);
  process.exit(1);
}
