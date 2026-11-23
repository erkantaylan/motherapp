import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig, saveConfig } from "../src/config.ts";
import { discoverAllTools, discoverTools, validateManifest } from "../src/manifest.ts";
import { externalToolsDir } from "../src/paths.ts";
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
  assert.equal(validateManifest({ id: "a", title: "A", serve: ["x"], wide: "yes" }), "wide must be a boolean");
  assert.deepEqual(validateManifest({ id: "a", title: "A", serve: ["x"], wide: true }), { id: "a", title: "A", serve: ["x"], wide: true });
  assert.equal(validateManifest({ id: "a", title: "A", serve: ["x"], localActions: "open" }), "localActions must be an array of strings");
  assert.deepEqual(validateManifest({ id: "a", title: "A", serve: ["x"], localActions: ["open"] }), { id: "a", title: "A", serve: ["x"], localActions: ["open"] });
  assert.deepEqual(validateManifest({ id: "a", title: "A", serve: ["x"], page: "p.ts", extra: 1 }), { id: "a", title: "A", serve: ["x"], page: "p.ts" });
  const kinds = [{ id: "finished", label: "Finished", sound: "bell" }, { id: "waiting", label: "Waiting" }];
  assert.deepEqual(validateManifest({ id: "a", title: "A", serve: ["x"], notifications: kinds }), { id: "a", title: "A", serve: ["x"], notifications: kinds });
  assert.match(validateManifest({ id: "a", title: "A", serve: ["x"], notifications: [{ id: "Bad id", label: "x" }] }) as string, /kind's id must match/);
  assert.match(validateManifest({ id: "a", title: "A", serve: ["x"], notifications: [{ id: "k", label: "x" }, { id: "k", label: "y" }] }) as string, /duplicate kind "k"/);
  assert.match(validateManifest({ id: "a", title: "A", serve: ["x"], notifications: [{ id: "k" }] }) as string, /needs a label/);
  assert.match(validateManifest({ id: "a", title: "A", serve: ["x"], notifications: [{ id: "k", label: "x", sound: "/etc/passwd" }] }) as string, /sound must be a sound name/);
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

test("resolveCommand: an absolute serve[0] (an external tool's own binary) is kept as it is", () => {
  assert.deepEqual(resolveCommand(["/home/x/.local/bin/nebula", "motherapp", "serve"], "/c/motherapp/tools/nebula", "/usr/bin/node24"), {
    cmd: "/home/x/.local/bin/nebula",
    args: ["motherapp", "serve"],
  });
});

test("externalToolsDir: <config dir>/tools, the variable overrides, off under node --test", () => {
  assert.equal(externalToolsDir({ XDG_CONFIG_HOME: "/c" }), "/c/motherapp/tools");
  assert.equal(externalToolsDir({}), path.join(os.homedir(), ".config", "motherapp", "tools"));
  assert.equal(externalToolsDir({ XDG_CONFIG_HOME: "/c", MOTHERAPP_EXTERNAL_TOOLS_DIR: "/x/tools" }), "/x/tools");
  assert.equal(externalToolsDir({ XDG_CONFIG_HOME: "/c", MOTHERAPP_EXTERNAL_TOOLS_DIR: "" }), undefined);
  assert.equal(externalToolsDir({ XDG_CONFIG_HOME: "/c", MOTHERAPP_EXTERNAL_TOOLS_DIR: "off" }), undefined);
  assert.equal(externalToolsDir({ XDG_CONFIG_HOME: "/c", MOTHERAPP_EXTERNAL_TOOLS_DIR: "OFF" }), undefined);
  // a core started by a test never reads the user's own folder, unless the test names one
  assert.equal(externalToolsDir({ XDG_CONFIG_HOME: "/c", NODE_TEST_CONTEXT: "child-v8" }), undefined);
  assert.equal(externalToolsDir({ NODE_TEST_CONTEXT: "child-v8", MOTHERAPP_EXTERNAL_TOOLS_DIR: "/x/tools" }), "/x/tools");
  // this very process runs under node --test
  assert.equal(externalToolsDir(), undefined);
});

test("discoverAllTools: external folder is optional, a built-in id wins, symlinked dirs are followed there", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ma-ext-"));
  const builtIn = path.join(tmp, "repo-tools");
  const ext = path.join(tmp, "ext");
  const put = (root: string, name: string, body: string) => {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.writeFileSync(path.join(root, name, "manifest.json"), body);
  };
  put(builtIn, "a", '{"id":"a","title":"A","serve":["node","a.ts"]}');
  put(builtIn, "b", '{"id":"b","title":"B","serve":["node","b.ts"]}');

  // no external folder given, a missing one, and the same folder twice: the built-in tools only
  for (const dir of [undefined, path.join(tmp, "missing"), builtIn]) {
    const r = discoverAllTools(builtIn, dir);
    assert.deepEqual(r.tools.map((t) => [t.manifest.id, t.external]), [["a", undefined], ["b", undefined]]);
    assert.deepEqual(r.errors, []);
  }

  put(ext, "nebula", '{"id":"nebula","title":"Nebula","serve":["/usr/local/bin/nebula","motherapp","serve"],"page":"page.ts"}');
  put(ext, "clash", '{"id":"b","title":"Other B","serve":["/bin/b"]}');
  put(ext, "broken", "{nope");
  fs.writeFileSync(path.join(ext, "a-file"), "not a tool");
  // a tool installed as a link to a directory elsewhere, a dangling link, and a link to a file
  put(path.join(tmp, "elsewhere"), "linked", '{"id":"linked","title":"Linked","serve":["./run"]}');
  fs.symlinkSync(path.join(tmp, "elsewhere", "linked"), path.join(ext, "linked"));
  fs.symlinkSync(path.join(tmp, "gone"), path.join(ext, "dangling"));
  fs.symlinkSync(path.join(ext, "a-file"), path.join(ext, "file-link"));

  const r = discoverAllTools(builtIn, ext);
  assert.deepEqual(r.tools.map((t) => [t.manifest.id, t.external, t.dir]), [
    ["a", undefined, path.join(builtIn, "a")],
    ["b", undefined, path.join(builtIn, "b")],
    ["linked", true, path.join(ext, "linked")], // the link's own path, not its target
    ["nebula", true, path.join(ext, "nebula")],
  ]);
  assert.equal(r.tools.find((t) => t.manifest.id === "b")!.manifest.title, "B");
  assert.deepEqual(r.errors.map((e) => path.basename(e.dir)).sort(), ["broken", "clash"]);
  assert.match(r.errors.find((e) => e.dir.endsWith("clash"))!.error, /external tool id "b" is taken by the built-in tool in .*repo-tools/);

  // the checkout's own folder does not follow links (unchanged)
  fs.symlinkSync(path.join(tmp, "elsewhere", "linked"), path.join(builtIn, "linked"));
  assert.deepEqual(discoverTools(builtIn).tools.map((t) => t.manifest.id), ["a", "b"]);

  // an external folder that is a file is an error, not a crash
  const asFile = discoverAllTools(builtIn, path.join(ext, "a-file"));
  assert.equal(asFile.tools.length, 2);
  assert.equal(asFile.errors.length, 1);
  fs.rmSync(tmp, { recursive: true });
});

test("config: created with defaults when missing, normalized when partial, kept when broken", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ma-cfg-"));
  const file = path.join(dir, "sub", "config.json");
  const first = loadConfig(file);
  assert.equal(first.created, true);
  assert.deepEqual(first.config, { port: 7323, tools: {}, lan: { enabled: false, trusted: [] }, localhostSubdomains: true, notifications: { muted: false, tools: {} }, tray: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { port: 7323, tools: {} });

  saveConfig(file, { port: 9000, tools: { demo: { enabled: true } } });
  fs.writeFileSync(file, JSON.stringify({ port: 9000, tools: { demo: { enabled: true }, bad: { enabled: "yes" } }, junk: 1 }));
  assert.deepEqual(loadConfig(file).config, { port: 9000, tools: { demo: { enabled: true } }, lan: { enabled: false, trusted: [] }, localhostSubdomains: true, notifications: { muted: false, tools: {} }, tray: true });

  fs.writeFileSync(file, "{broken");
  const broken = loadConfig(file);
  assert.ok(broken.error);
  assert.equal(fs.readFileSync(file, "utf8"), "{broken");
  fs.rmSync(dir, { recursive: true });
});
