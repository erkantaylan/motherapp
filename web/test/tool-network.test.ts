// Settings → Tools → "On the network", in a real browser against the real core: on a page
// opened at a localhost address every tool has the switch, and flipping it updates the row in
// place; a page opened at this machine's LAN address has no such switch, never sees a tool that
// is off the network, and loses a tool's open page the moment it is turned off (DESIGN.md § 3
// "Network switch scope"). The core is made to trust "the current network" with stand-in `ip`
// and `nmcli` commands first on its PATH; a connection to the machine's own LAN address has
// that address as its source, so the core counts it as a LAN client. Skipped when no browser
// is installed; the LAN half is skipped on a machine without a private IPv4 address.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findBrowser, startSite } from "./browser.ts";

const browserBin = findBrowser();
const MAX_OFF_PX = 0.5;

/** This machine's first private IPv4 address that isn't loopback. */
function lanAddress(): string | undefined {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) {
      if (!i.internal && i.family === "IPv4" && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address)) return i.address;
    }
  }
  return undefined;
}

test("Settings: “On the network” per tool on this computer; a LAN page has no switch and loses a hidden tool at once", { skip: !browserBin && "no Chrome/Chromium found (set MOTHERAPP_TEST_CHROME)", timeout: 120_000 }, async (t) => {
  const extra = fs.mkdtempSync(path.join(os.tmpdir(), "ma-toolnet-"));
  t.after(() => fs.rmSync(extra, { recursive: true, force: true }));
  // A second tool, disabled (so its row has no Restart button), with a notification kind.
  const watcher = path.join(extra, "watcher");
  fs.mkdirSync(watcher);
  fs.writeFileSync(path.join(watcher, "manifest.json"), JSON.stringify({ id: "watcher", title: "Watcher", icon: "👀", serve: ["node", "none.ts"], defaultEnabled: false, notifications: [{ id: "done", label: "Something finished" }] }));
  // Stand-ins for the two commands the core identifies the network with (core/src/netIdentity.ts).
  const bin = path.join(extra, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "ip"), `#!/bin/sh\nif [ "$1" = route ]; then echo "default via 10.99.99.1 dev test0 proto dhcp metric 100"; else echo "10.99.99.1 lladdr aa:bb:cc:dd:ee:01 REACHABLE"; fi\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "nmcli"), `#!/bin/sh\nif [ "$1" = monitor ]; then exec sleep 600; fi\necho "Test net:u-test:test0:802-3-ethernet"\n`, { mode: 0o755 });

  const site = await startSite(t, browserBin!, "tool-network", ["demo", { dir: watcher, enabled: false }], {
    config: { lan: { enabled: true, trusted: [{ uuid: "u-test", name: "Test net", gatewayMac: "aa:bb:cc:dd:ee:01" }] } },
    env: { PATH: `${bin}:${process.env.PATH ?? ""}`, MOTHERAPP_EXTERNAL_TOOLS_DIR: "off" },
  });
  const { port, cdp: local } = site;
  const tools = () => (JSON.parse(fs.readFileSync(path.join(site.tmp, "config", "motherapp", "config.json"), "utf8")) as { tools: Record<string, { enabled?: boolean; network?: boolean }> }).tools;

  interface Row { tool: string; label: string | null; checked: boolean | null; switchLeft: number | null; right: number; inside: boolean }
  // Per tool row: the switch if it is shown, where it is, and whether every control is inside the row.
  const ROWS = `[...document.querySelectorAll(".tool-order > .list-row")].map((r) => {
    const n = r.querySelector(".row-network");
    const shown = !!n && !n.hidden && getComputedStyle(n).display !== "none";
    const box = r.getBoundingClientRect();
    return { tool: r.dataset.tool, label: shown ? n.querySelector(".control-label").textContent : null, checked: shown ? n.querySelector("input").checked : null,
      switchLeft: shown ? n.querySelector("input").getBoundingClientRect().left : null, right: box.right,
      inside: [...r.children].every((c) => c.hidden || getComputedStyle(c).display === "none" || c.getBoundingClientRect().right <= box.right + 0.5) };
  })`;
  const HINT = `(() => { const h = document.querySelector(".network-hint"); return h && !h.hidden ? h.textContent : ""; })()`;
  const SIDEBAR = `[...document.querySelectorAll(".nav-tools .nav-label")].map((e) => e.textContent)`;
  const NET_INPUT = (id: string) => `document.querySelector('.tool-order > .list-row[data-tool="${id}"] .row-network input')`;
  const settled = async (what: string, cond: () => boolean) => {
    const end = Date.now() + 10_000;
    while (!cond()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 30));
    }
  };

  // ---- this computer ----
  await local.viewport(1280, 900);
  await local.load(`http://127.0.0.1:${port}/#/settings`);
  await local.until(`document.querySelectorAll(".tool-order > .list-row").length === 2`, "the tool rows");
  let rows = await local.eval<Row[]>(ROWS);
  assert.deepEqual(rows.map((r) => [r.tool, r.label, r.checked]), [["demo", "On the network", true], ["watcher", "On the network", true]]);
  assert.ok(Math.abs(rows[0]!.switchLeft! - rows[1]!.switchLeft!) <= MAX_OFF_PX, `the switches share a column with and without Restart (${rows[0]!.switchLeft} / ${rows[1]!.switchLeft})`);
  assert.ok(rows.every((r) => r.inside), "every control inside its row");
  assert.match(await local.eval<string>(HINT), /only matters while “Local network” below is on/);
  assert.equal(await local.eval<string>(`${NET_INPUT("watcher")}.getAttribute("aria-label")`), "On the network: Watcher");

  // off: saved, and the row is updated in place (the same node, the focus still on the switch)
  await local.eval(`(() => { const i = ${NET_INPUT("watcher")}; i.closest(".list-row").__mark = 1; i.focus(); i.click(); })()`);
  await settled("tools.watcher.network false in config.json", () => tools().watcher?.network === false);
  assert.deepEqual(tools().watcher, { enabled: false, network: false });
  // "set": the core answered, and its `tools` push (sent before the answer) has been applied
  await local.until(`document.querySelector('.tool-order > .list-row[data-tool="watcher"] .dot').dataset.status === "set"`, "the row's dot to say Set");
  assert.equal(await local.eval<boolean>(`${NET_INPUT("watcher")}.closest(".list-row").__mark === 1 && document.activeElement === ${NET_INPUT("watcher")} && !${NET_INPUT("watcher")}.checked`), true, "same row, focus kept, switch off");
  assert.deepEqual(await local.eval<string[]>(`[...document.querySelectorAll(".tool-order > .list-row")].map((r) => r.dataset.tool)`), ["demo", "watcher"], "this computer still lists it");

  // a phone-wide window: the switch gets a line of its own, nothing sticks out of a row
  await local.viewport(390, 800);
  await local.until(`innerWidth === 390`, "the narrow viewport");
  rows = await local.eval<Row[]>(ROWS);
  assert.ok(rows.every((r) => r.inside && r.label === "On the network"), `every control inside its row at 390 px: ${JSON.stringify(rows)}`);
  await local.viewport(1280, 900);

  // ---- a LAN client ----
  const address = lanAddress();
  if (!address) {
    t.diagnostic("no private IPv4 address on this machine: the LAN half was not run");
    return;
  }
  const lan = await site.newPage();
  await lan.viewport(1280, 900);
  await lan.load(`http://${address}:${port}/#/settings`);
  await lan.until(`document.querySelectorAll(".tool-order > .list-row").length >= 1 && document.querySelector(".notify-rows .notify-tool")`, "the LAN page's Settings");
  const lanRows = await lan.eval<Row[]>(ROWS);
  assert.deepEqual(lanRows.map((r) => [r.tool, r.label]), [["demo", null]], "only the tool on the network, and no switch");
  assert.equal(await lan.eval<string>(HINT), "", "no hint either");
  assert.equal(await lan.eval<boolean>(`/watcher/i.test(document.body.textContent)`), false, "the hidden tool is nowhere on the page");
  assert.deepEqual(await lan.eval<string[]>(`[...document.querySelectorAll(".notify-rows .notify-tool")].map((r) => r.dataset.tool)`), ["demo"]);
  assert.deepEqual(await lan.eval<{ status: string[]; hidden: number; never: number }>(`(async () => ({ status: (await (await fetch("/api/status")).json()).tools.map((x) => x.id), hidden: (await fetch("/tools/watcher/page.ts")).status, never: (await fetch("/tools/nosuch/page.ts")).status }))()`), { status: ["demo"], hidden: 404, never: 404 });

  // The LAN page shows the demo; this computer takes the demo off the network.
  await lan.eval(`location.hash = "#/tool/demo"`);
  await lan.until(`document.querySelectorAll(".page-body button").length > 0`, "the demo page on the LAN client");
  await local.eval(`${NET_INPUT("demo")}.click()`);
  await lan.until(`!${SIDEBAR}.includes("Demo") && document.querySelector(".content .banner")?.textContent === "Unknown tool."`, "the demo gone from the LAN page");
  assert.equal(await lan.eval<number>(`document.querySelector(".page-body").childNodes.length`), 0, "its page is gone too, not only its name");
  assert.deepEqual(await lan.eval<string[]>(SIDEBAR), []);
  assert.deepEqual(tools().demo, { enabled: true, network: false });
  assert.deepEqual(await local.eval<string[]>(SIDEBAR), ["Demo"], "nothing changed on this computer");

  // And puts it back: the LAN page has it again, without a reload.
  await local.eval(`${NET_INPUT("demo")}.click()`);
  await lan.until(`${SIDEBAR}.includes("Demo") && document.querySelectorAll(".page-body button").length > 0`, "the demo back on the LAN page");
  assert.deepEqual(tools().demo, { enabled: true }, "back to the default: nothing stored");
});
