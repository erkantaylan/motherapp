// `npm run dev`: the core (restarted on source changes) plus the Vite dev server, which
// proxies /ws and /tools to the core. Open the URL Vite prints.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const children: ChildProcess[] = [];

function run(cmd: string, args: string[], cwd: string): void {
  const child = spawn(cmd, args, { cwd, stdio: "inherit", env: process.env });
  child.on("exit", (code) => {
    for (const c of children) if (c !== child) c.kill("SIGTERM");
    process.exit(code ?? 0);
  });
  children.push(child);
}

run(process.execPath, ["--watch-path=core/src", "--watch-path=packages", "core/src/main.ts"], root);
run(process.execPath, [path.join(root, "node_modules", "vite", "bin", "vite.js")], path.join(root, "web"));

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    for (const c of children) c.kill("SIGTERM");
  });
}
