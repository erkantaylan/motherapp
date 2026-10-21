import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig, saveConfig } from "../src/config.ts";
import { discoverTools, validateManifest } from "../src/manifest.ts";
import { resolveCommand } from "../src/toolHost.ts";
import { fixturesDir } from "./helpers.ts";

test("discoverTools: reads valid manifests, reports bad ones, skips dirs without one", () => {
  const r = discoverTools(fixturesDir);
  assert.deepEqual(r.tools.map((t) => t.manifest.id), ["crash", "custom", "ok"]);
  const ok = r.tools.find((t) => t.manifest.id === "ok")!;
  assert.equal(ok.dir, path.join(fixturesDir, "ok"));
  assert.deepEqual(ok.manifest.serve, ["node", "ok.ts"]);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0]!.error, /id must match/);
  assert.ok(r.errors[0]!.dir.endsWith("badmanifest"));
});

test("discoverTools: duplicate ids and broken JSON", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ma-disc-"));
  for (const [name, body] of [["a", '{"id":"x","title":"A","serve":["a"]}'], ["b", '{"id":"x","title":"B","serve":["b"]}'], ["c", "{nope"]]) {
    fs.mkdirSync(path.join(dir, name!));
    fs.writeFileSync(path.join(dir, name!, "manifest.json"), body!);
  }
  const r = discoverTools(dir);
  assert.deepEqual(r.tools.map((t) => t.dir), [path.join(dir, "a")]);
  assert.equal(r.errors.length, 2);
  assert.deepEqual(discoverTools(path.join(dir, "missing")).tools, []);
  fs.rmSync(dir, { recursive: true });
});

test("validateManifest", () => {
  assert.equal(typeof validateManifest({ id: "a", title: "A", serve: [] }), "string");
  assert.equal(typeof validateManifest({ id: "core", title: "A", serve: ["x"] }), "string");
  assert.equal(typeof validateManifest({ id: "a", title: "A", serve: ["x"], page: "../x.ts" }), "string");
  assert.deepEqual(validateManifest({ id: "a", title: "A", serve: ["x"], page: "p.ts", extra: 1 }), { id: "a", title: "A", serve: ["x"], page: "p.ts" });
  // "bin" is for install.sh only; the core accepts and ignores it.
  assert.deepEqual(validateManifest({ id: "a", title: "A", serve: ["x"], bin: { actl: "a.ts" } }), { id: "a", title: "A", serve: ["x"] });
});

test("discoverTools: the repo's own tools/ load without errors (audio declares bin)", () => {
  const r = discoverTools(path.join(fixturesDir, "..", "..", "..", "..", "tools"));
  assert.deepEqual(r.errors, []);
  assert.ok(r.tools.some((t) => t.manifest.id === "audio"));
});

test("resolveCommand: node is the core's own Node, ./ paths are tool-relative", () => {
  assert.deepEqual(resolveCommand(["node", "x.ts", "serve"], "/t", "/usr/bin/node24"), {
    cmd: "/usr/bin/node24",
    args: ["--disable-warning=ExperimentalWarning", "x.ts", "serve"],
  });
  assert.deepEqual(resolveCommand(["./bin/tool", "serve"], "/t"), { cmd: "/t/bin/tool", args: ["serve"] });
  assert.deepEqual(resolveCommand(["python3", "t.py"], "/t"), { cmd: "python3", args: ["t.py"] });
});

test("config: created with defaults when missing, normalized when partial, kept when broken", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ma-cfg-"));
  const file = path.join(dir, "sub", "config.json");
  const first = loadConfig(file);
  assert.equal(first.created, true);
  assert.deepEqual(first.config, { port: 7323, tools: {}, lan: { enabled: false, trusted: [] }, localhostSubdomains: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { port: 7323, tools: {} });

  saveConfig(file, { port: 9000, tools: { demo: { enabled: true } } });
  fs.writeFileSync(file, JSON.stringify({ port: 9000, tools: { demo: { enabled: true }, bad: { enabled: "yes" } }, junk: 1 }));
  assert.deepEqual(loadConfig(file).config, { port: 9000, tools: { demo: { enabled: true } }, lan: { enabled: false, trusted: [] }, localhostSubdomains: true });

  fs.writeFileSync(file, "{broken");
  const broken = loadConfig(file);
  assert.ok(broken.error);
  assert.equal(fs.readFileSync(file, "utf8"), "{broken");
  fs.rmSync(dir, { recursive: true });
});
