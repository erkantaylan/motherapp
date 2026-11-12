// The tool strip, the bell's panel and Settings → Notifications, in a real browser: the panel
// docks beside the page on a wide window (the page narrows, nothing is covered), lies over the
// page on a narrower one and covers it on a phone; the badge counts what arrived while the
// panel was closed, across a reload; a dropped connection doesn't list anything twice; the
// Settings rows share their columns. Skipped when no browser is installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findBrowser, startSite, waitFor } from "./browser.ts";

const browserBin = findBrowser();
const PANEL_PX = 340;
const MAX_OFF_PX = 0.5;

test("notifications: strip, docked and covering panel, badge, reconnect, Settings rows", { skip: !browserBin && "no Chrome/Chromium found (set MOTHERAPP_TEST_CHROME)", timeout: 120_000 }, async (t) => {
  // A second tool with two kinds. It stays disabled: Settings lists kinds from the manifest.
  const extra = fs.mkdtempSync(path.join(os.tmpdir(), "ma-notify-tool-"));
  t.after(() => fs.rmSync(extra, { recursive: true, force: true }));
  const watcher = path.join(extra, "watcher");
  fs.mkdirSync(watcher);
  fs.writeFileSync(
    path.join(watcher, "manifest.json"),
    JSON.stringify({ id: "watcher", title: "Watcher", icon: "👀", serve: ["node", "none.ts"], defaultEnabled: false, notifications: [{ id: "done", label: "Something finished", sound: "bell" }, { id: "stuck", label: "Something is stuck" }] }),
  );
  const { port, cdp, tmp } = await startSite(t, browserBin!, "notify-panel", ["demo", { dir: watcher, enabled: false }]);
  const config = () => JSON.parse(fs.readFileSync(path.join(tmp, "config", "motherapp", "config.json"), "utf8")) as { notifications?: { muted?: boolean; tools?: Record<string, { enabled?: boolean; kinds?: Record<string, { sound?: string }> }> } };

  // Every WebSocket the page opens, so the test can drop the connection.
  await cdp.send("Page.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__sockets = []; const WS = window.WebSocket; window.WebSocket = class extends WS { constructor(...a) { super(...a); window.__sockets.push(this); } };`,
  });

  const demo = `http://127.0.0.1:${port}/#/tool/demo`;
  const button = (label: string) => `[...document.querySelectorAll(".page-body button")].find((b) => b.textContent === ${JSON.stringify(label)})`;
  const click = (sel: string) => cdp.eval(`document.querySelector(${JSON.stringify(sel)}).click()`);
  const send = () => cdp.eval(`${button("Send a notification")}.click()`);
  const BADGE = `(() => { const b = document.querySelector(".strip-badge"); return b.hidden ? "" : b.textContent; })()`;
  const OPEN = `!document.querySelector(".side-panel").hidden`;
  const NOTES = `[...document.querySelectorAll(".note")].map((n) => ({ title: n.querySelector(".note-title").textContent, time: n.querySelector(".note-time").textContent, body: n.querySelector(".note-body")?.textContent ?? "", muted: n.classList.contains("is-muted") && !!n.querySelector(".note-muted") }))`;
  const BOX = `(() => {
    const r = (s) => { const b = document.querySelector(s).getBoundingClientRect(); return { left: b.left, top: b.top, width: b.width, height: b.height, right: b.right }; };
    // "vw" is the shell's width: the window less the page scrollbar's gutter.
    return { main: r(".main-col"), panel: r(".side-panel"), strip: r(".tool-strip"), bell: r(".strip-btn"), topbar: r(".topbar"), position: getComputedStyle(document.querySelector(".side-panel")).position,
      vw: r(".shell").right, vh: innerHeight, scroll: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  })()`;
  interface Rect { left: number; top: number; width: number; height: number; right: number }
  interface Box { main: Rect; panel: Rect; strip: Rect; bell: Rect; topbar: Rect; position: string; vw: number; vh: number; scroll: number }
  interface Note { title: string; time: string; body: string; muted: boolean }
  const ready = () => cdp.until(button("Send a notification"), "the demo page");

  // ---- wide window: the strip, the badge, docking ----
  await cdp.viewport(1600, 900);
  await cdp.load(demo);
  await ready();
  assert.equal(await cdp.eval<boolean>(OPEN), false, "the panel starts hidden");
  assert.equal(await cdp.eval<string>(BADGE), "", "no badge before anything arrived");
  const closed = await cdp.eval<Box>(BOX);
  assert.ok(Math.abs(closed.strip.right - closed.vw) <= MAX_OFF_PX, `the strip is at the right edge (${closed.strip.right} of ${closed.vw})`);
  assert.ok(closed.strip.height >= closed.vh - 1, "the strip runs the height of the window");
  assert.ok(Math.abs(closed.main.right - closed.strip.left) <= MAX_OFF_PX, "the page reaches the strip");

  await send();
  await cdp.until(`${BADGE} === "1"`, "badge 1");
  await cdp.eval(`${button("Increment")}.click()`);
  await cdp.until(`document.querySelector(".page-body").textContent.includes("1")`, "the counter at 1");
  await send();
  await cdp.until(`${BADGE} === "2"`, "badge 2");
  assert.equal(await cdp.eval<string>(`document.querySelector(".strip-btn").getAttribute("aria-label")`), "Notifications, 2 new");

  await click(".strip-btn");
  await cdp.until(OPEN, "the panel open");
  const docked = await cdp.eval<Box>(BOX);
  assert.equal(docked.position, "sticky", "docked: part of the layout, not over the page");
  assert.ok(Math.abs(docked.main.width - (closed.main.width - PANEL_PX)) <= MAX_OFF_PX, `the page narrowed by the panel's width (${closed.main.width} -> ${docked.main.width})`);
  assert.ok(Math.abs(docked.panel.left - docked.main.right) <= MAX_OFF_PX && Math.abs(docked.panel.right - docked.strip.left) <= MAX_OFF_PX, "the panel sits between the page and the strip");
  assert.ok(docked.scroll <= 0, `no horizontal scroll (${docked.scroll} px)`);
  assert.equal(await cdp.eval<string>(BADGE), "", "opening the panel clears the badge");
  assert.equal(await cdp.eval<string>(`document.querySelector(".strip-btn").getAttribute("aria-expanded")`), "true");
  let notes = await cdp.eval<Note[]>(NOTES);
  assert.deepEqual(notes.map((n) => n.body), ["The counter is at 1.", "The counter is at 0."], "newest on top");
  assert.equal(notes[0]!.title, "Hello from the demo");
  assert.match(notes[0]!.time, /^\d\d:\d\d$/);
  assert.equal(await cdp.eval<string>(`document.querySelector(".note-icon").textContent`), "🧪");

  // ---- a dropped connection: the history comes again, nothing twice ----
  await cdp.eval(`window.__sockets.at(-1).close()`);
  await cdp.until(`window.__sockets.length >= 2 && window.__sockets.at(-1).readyState === 1 && document.querySelector(".conn-banner").hidden`, "reconnected");
  await send();
  await cdp.until(`document.querySelectorAll(".note").length >= 3`, "the notification after the reconnect");
  await cdp.eval(`new Promise((r) => setTimeout(r, 300))`); // a duplicate would have come by now
  assert.equal(await cdp.eval<number>(`document.querySelectorAll(".note").length`), 3, "three entries, none twice");

  // ---- mute all from the panel: still listed, marked ----
  await click(".note-mute input");
  await waitFor(() => config().notifications?.muted === true, "mute saved to config.json", 10_000);
  await send();
  await cdp.until(`document.querySelectorAll(".note").length === 4`, "the muted notification");
  notes = await cdp.eval<Note[]>(NOTES);
  assert.deepEqual(notes.map((n) => n.muted), [true, false, false, false], "only the one sent while muted is marked");
  await click(".note-mute input");
  await waitFor(() => config().notifications?.muted === false, "unmute saved", 10_000);

  // ---- hide: the page gets its width back; the badge counts from here, across a reload ----
  await click(".strip-btn");
  await cdp.until(`!(${OPEN})`, "the panel hidden");
  const again = await cdp.eval<Box>(BOX);
  assert.ok(Math.abs(again.main.width - closed.main.width) <= MAX_OFF_PX, "the page has its full width again");
  await send();
  await cdp.until(`${BADGE} === "1"`, "badge 1 after closing");
  await cdp.load(demo);
  await ready();
  await cdp.until(`${BADGE} === "1"`, "the badge survives a reload");
  assert.equal(await cdp.eval<boolean>(OPEN), false, "a hidden panel stays hidden after a reload");
  await click(".strip-btn");
  await cdp.until(`document.querySelectorAll(".note").length === 5`, "the whole history after a reload");
  await cdp.load(demo);
  await ready();
  await cdp.until(OPEN, "an open, docked panel is open again after a reload");
  assert.equal(await cdp.eval<string>(BADGE), "");

  // ---- medium window: no room to dock, the panel lies over the page ----
  await cdp.viewport(1000, 800);
  await cdp.load(demo);
  await ready();
  assert.equal(await cdp.eval<boolean>(OPEN), false, "not opened over the page by itself");
  const mid = await cdp.eval<Box>(BOX);
  await click(".strip-btn");
  await cdp.until(OPEN, "the panel open at 1000 px");
  const over = await cdp.eval<Box>(BOX);
  assert.equal(over.position, "fixed");
  assert.ok(Math.abs(over.main.width - mid.main.width) <= MAX_OFF_PX, "the page keeps its width");
  assert.ok(Math.abs(over.panel.right - over.strip.left) <= MAX_OFF_PX, "the panel is beside the strip");
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await cdp.until(`!(${OPEN})`, "Escape hides a panel that lies over the page");

  // ---- phone: the bell is in the top bar, the panel covers the page until closed ----
  await cdp.viewport(390, 800);
  await cdp.load(demo);
  await ready();
  const phone = await cdp.eval<Box>(BOX);
  assert.ok(phone.bell.top >= phone.topbar.top && phone.bell.top + phone.bell.height <= phone.topbar.top + phone.topbar.height, "the bell is inside the top bar");
  assert.ok(phone.scroll <= 0, `phone: no horizontal scroll (${phone.scroll} px)`);
  assert.ok(Math.abs(phone.main.width - phone.vw) <= MAX_OFF_PX, "phone: the strip takes no width from the page");
  await click(".strip-btn");
  await cdp.until(OPEN, "the panel open on a phone");
  const cover = await cdp.eval<Box>(BOX);
  assert.ok(cover.panel.left <= MAX_OFF_PX && cover.panel.top <= MAX_OFF_PX && cover.panel.width >= cover.vw - MAX_OFF_PX && cover.panel.height >= cover.vh - MAX_OFF_PX, `the panel covers the page (${JSON.stringify(cover.panel)})`);
  assert.equal(await cdp.eval<boolean>(`document.querySelector(".side-panel").contains(document.elementFromPoint(${Math.round(cover.vw / 2)}, 400))`), true, "the panel is on top");
  await click(".side-panel-close");
  await cdp.until(`!(${OPEN})`, "the close button hides it");

  // ---- Settings: the rows share their columns; changes are saved and reach the panel ----
  const ROWS = String.raw`(() => {
    const rows = [...document.querySelectorAll(".notify-rows > .list-row")];
    const left = (e) => (e && e.getClientRects().length ? e.getBoundingClientRect().left : null);
    const col = (sel) => rows.map((r) => left(r.querySelector(sel))).filter((x) => x !== null);
    return { titles: rows.map((r) => r.querySelector(".row-title").textContent), switch: col("input[role=switch]"), sound: col("select"), play: col(".row-play"), dot: col(".dot") };
  })()`;
  for (const width of [1280, 390]) {
    await cdp.viewport(width, 900);
    await cdp.load(`http://127.0.0.1:${port}/#/settings`);
    await cdp.until(`document.querySelectorAll(".notify-rows > .list-row").length === 6`, `${width}px: six notification rows`);
    const c = await cdp.eval<{ titles: string[]; switch: number[]; sound: number[]; play: number[]; dot: number[] }>(ROWS);
    assert.deepEqual(c.titles, ["Mute all", "🧪 Demo", "Demo notification", "👀 Watcher", "Something finished", "Something is stuck"]);
    for (const [k, n] of [["switch", 6], ["sound", 3], ["play", 3], ["dot", 6]] as const) {
      const xs = c[k];
      assert.equal(xs.length, n, `${width}px: ${k} found`);
      const spread = Math.max(...xs) - Math.min(...xs);
      assert.ok(spread <= MAX_OFF_PX, `${width}px: ${k} lefts differ by ${spread.toFixed(1)} px (${xs.join(", ")})`);
    }
    const scroll = await cdp.eval<number>("document.documentElement.scrollWidth - document.documentElement.clientWidth");
    assert.ok(scroll <= 0, `${width}px: no horizontal scroll (${scroll} px)`);
  }
  assert.match(await cdp.eval<string>(`(() => { const b = document.querySelector(".notify-settings .banner"); return b.hidden ? "" : b.textContent; })()`), /no popups and plays no sounds/, "a core with delivery off says so");

  // The tray row: this core never shows an icon and says so; the switch still saves.
  await cdp.until(`/never shows one/.test(document.querySelector(".desktop-settings .row-sub").textContent)`, "the tray row's note");
  const trayWas = await cdp.eval<boolean>(`document.querySelector(".desktop-settings input").checked`);
  await cdp.eval(`document.querySelector(".desktop-settings input").click()`);
  await waitFor(() => (JSON.parse(fs.readFileSync(path.join(tmp, "config", "motherapp", "config.json"), "utf8")) as { tray?: boolean }).tray === !trayWas, "the tray switch saved", 10_000);

  // A tool off: saved, and its kinds are dimmed. The switch keeps the focus (rows aren't rebuilt).
  await cdp.eval(`(() => { const i = document.querySelector('.notify-tool[data-tool="watcher"] input'); i.focus(); i.click(); })()`);
  await waitFor(() => config().notifications?.tools?.watcher?.enabled === false, "the tool's switch saved", 10_000);
  await cdp.until(`document.querySelectorAll('.notify-kind[data-tool="watcher"].is-off').length === 2`, "the tool's kinds dimmed");
  assert.equal(await cdp.eval<boolean>(`document.activeElement === document.querySelector('.notify-tool[data-tool="watcher"] input')`), true, "focus stays on the switch");
  // A kind's sound: "No sound" is always a choice, and then there is nothing to play.
  const SELECT = `document.querySelector('.notify-kind[data-tool="demo"] select')`;
  assert.equal(await cdp.eval<string>(`${SELECT}.options[0].value + "|" + ${SELECT}.options[0].textContent`), "none|No sound");
  await cdp.eval(`(() => { const s = ${SELECT}; s.value = "none"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await waitFor(() => config().notifications?.tools?.demo?.kinds?.hello?.sound === "none", "the sound saved", 10_000);
  await cdp.until(`document.querySelector('.notify-kind[data-tool="demo"] .row-play').disabled && document.querySelector('.notify-kind[data-tool="demo"] .row-play').title === "No sound to play"`, "no play button for no sound");
  // Mute all on Settings reaches the panel's switch (the settings push).
  await cdp.eval(`document.querySelector(".notify-rows > .list-row input").click()`);
  await waitFor(() => config().notifications?.muted === true, "mute all saved from Settings", 10_000);
  await click(".strip-btn");
  await cdp.until(`${OPEN} && document.querySelector(".note-mute input").checked`, "the panel's mute switch follows Settings");
});
