// Stand-in for `gsettings` and `dconf` in the end-to-end test:
//   node fake-gnome.ts <gsettings|dconf> [args…]   with FAKE_GNOME_DIR set.
// The store is $FAKE_GNOME_DIR/store.json (see fake-gnome-core.ts); every call is appended to
// $FAKE_GNOME_DIR/calls.log as a JSON line, with the LC_ALL it saw.
import * as fs from "node:fs";
import * as path from "node:path";
import { handle } from "./fake-gnome-core.ts";
import type { Store } from "./fake-gnome-core.ts";

const dir = process.env.FAKE_GNOME_DIR!;
const [cmd, ...args] = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "calls.log"), JSON.stringify({ argv: [cmd, ...args], lcAll: process.env.LC_ALL ?? null }) + "\n");
const file = path.join(dir, "store.json");
const store = JSON.parse(fs.readFileSync(file, "utf8")) as Store;
const r = handle(store, cmd!, args);
if (r.code === 0 && /^(set|reset)$/.test(args[0] ?? "")) fs.writeFileSync(file, JSON.stringify(store));
process.stdout.write(r.stdout);
process.stderr.write(r.stderr);
process.exitCode = r.code;
