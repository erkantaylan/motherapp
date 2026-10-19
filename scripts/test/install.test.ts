// Runs the bash tests for install.sh (scripts/test-install.sh) as part of `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("install.sh (scripts/test-install.sh)", { skip: process.platform !== "linux" && "Linux only" }, () => {
  const r = spawnSync("bash", [path.join(repo, "scripts", "test-install.sh")], { encoding: "utf8", timeout: 120_000 });
  const failures = r.stdout.split("\n").filter((l) => l.startsWith("not ok"));
  assert.equal(r.status, 0, `${failures.join("\n")}\n\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /\d+ passed, 0 failed/);
});
