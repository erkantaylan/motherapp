// Runs the bash tests for scripts/get.sh (scripts/test-get.sh) as part of `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("get.sh (scripts/test-get.sh)", { skip: process.platform !== "linux" && "Linux only" }, () => {
  const r = spawnSync("bash", [path.join(repo, "scripts", "test-get.sh")], { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
  const failures = r.stdout.split("\n").filter((l) => l.startsWith("not ok"));
  assert.equal(r.status, 0, `${failures.join("\n")}\n\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /\d+ passed, 0 failed/);
});
