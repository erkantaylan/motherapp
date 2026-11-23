// The details card's collapse toggle, in a real browser against the real core and tmux tool with
// the fake `tmux` first on PATH (never the real server): expanded by default, collapsed to one
// line that names the session, the choice kept across a reload, the wide layout's preview taking
// the freed height, and a refresh of the details leaving the toggle, its focus, the preview's
// scroll, the draft and the selection alone. Skipped when no browser is installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { findBrowser, startSite } from "../../../web/test/browser.ts";
import type { Cdp } from "../../../web/test/browser.ts";
import { session } from "./fakes.ts";
import { DETAILS_KEY } from "../src/view.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const browserBin = findBrowser();
const LONG_NAME = "work on a session whose name is far too long to fit in one line of a phone screen";

interface Seen {
  expanded: string | null;
  controls: boolean;
  listShown: boolean;
  summary: string | null;
  summaryCut: boolean;
  headH: number;
  cardH: number;
  screenH: number;
  screenFromBottom: number;
  mainOverflow: number;
  pageOverflowX: number;
  focused: boolean;
  sameToggle: boolean;
  sameScreen: boolean;
  stored: string | null;
  draft: string;
  current: string[];
  path: string | null;
  screenShown: boolean;
}

// What the test reads off the page, in one go.
const SEEN = `(() => {
  const q = (s) => document.querySelector(s);
  const t = q(".mtx-details-head"), dl = q(".mtx-claude dl"), sum = q(".mtx-details-sum"), screen = q(".mtx-screen"), main = q(".mtx-main");
  const shown = (e) => !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().height > 0;
  window.__toggle ??= t; window.__screen ??= screen;
  return {
    expanded: t.getAttribute("aria-expanded"),
    controls: document.getElementById(t.getAttribute("aria-controls")) === dl,
    listShown: shown(dl),
    summary: shown(sum) ? sum.textContent : null,
    summaryCut: sum.scrollWidth > sum.clientWidth,
    headH: t.getBoundingClientRect().height,
    cardH: q(".mtx-claude").getBoundingClientRect().height,
    screenH: screen.getBoundingClientRect().height,
    screenFromBottom: screen.scrollHeight - screen.scrollTop - screen.clientHeight,
    mainOverflow: main.scrollHeight - main.clientHeight,
    pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    focused: document.activeElement === t,
    sameToggle: window.__toggle === t,
    sameScreen: window.__screen === screen,
    stored: localStorage.getItem(${JSON.stringify(DETAILS_KEY)}),
    draft: q(".mtx-send textarea").value,
    current: [...document.querySelectorAll('.mtx-row[aria-current="true"] .mtx-name')].map((e) => e.textContent),
    path: [...dl.querySelectorAll("dt")].find((d) => d.textContent === "Pane path")?.nextElementSibling.textContent ?? null,
    screenShown: shown(screen),
  };
})()`;

async function key(cdp: Cdp, k: "Enter" | " "): Promise<void> {
  const base = k === "Enter" ? { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" } : { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " };
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base, text: undefined });
}

test("tmux page: the details card collapses to one line, remembers it, and gives the wide preview its room", { skip: !browserBin && "no Chrome/Chromium found (set MOTHERAPP_TEST_CHROME)", timeout: 120_000 }, async (t) => {
  const extra = fs.mkdtempSync(path.join(os.tmpdir(), "ma-tmux-details-"));
  t.after(() => fs.rmSync(extra, { recursive: true, force: true }));
  const bin = path.join(extra, "bin");
  const fake = path.join(extra, "tmux");
  fs.mkdirSync(bin);
  fs.mkdirSync(fake);
  const now = Math.floor(Date.now() / 1000);
  const server = (pathOfFirst: string) =>
    fs.writeFileSync(path.join(fake, "server.json"), JSON.stringify([session(0, LONG_NAME, { created: now, activity: now, path: pathOfFirst }), session(1, "zz other", { created: now, activity: now })]));
  server("/home/u/one");
  // Taller than any preview box here, so there is a bottom to stay at.
  fs.writeFileSync(path.join(fake, "screen.txt"), Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  fs.writeFileSync(path.join(bin, "tmux"), `#!/bin/sh\nexec "${process.execPath}" --disable-warning=ExperimentalWarning "${path.join(here, "fake-tmux.ts")}" "$@"\n`, { mode: 0o755 });

  const site = await startSite(t, browserBin!, "tmux-details", ["tmux"], {
    env: { PATH: `${bin}:${process.env.PATH ?? ""}`, FAKE_TMUX_DIR: fake, CLAUDE_CONFIG_DIR: path.join(extra, "claude"), MOTHERAPP_EXTERNAL_TOOLS_DIR: "off" },
  });
  const { cdp } = site;
  const url = `http://127.0.0.1:${site.port}/#/tool/tmux`;
  const seen = () => cdp.eval<Seen>(SEEN);
  const ready = () => cdp.until(`document.querySelector(".mtx-screen")?.textContent.includes("line 200") && document.querySelector(".mtx-claude dd")`, "the preview and the details");
  const focusToggle = () => cdp.eval(`document.querySelector(".mtx-details-head").focus()`);

  // ---- wide ----
  await cdp.viewport(1400, 900);
  await cdp.load(url);
  await ready();
  const first = await seen();
  assert.deepEqual([first.expanded, first.controls, first.listShown, first.summary, first.stored], ["true", true, true, null, null], "expanded by default, nothing stored");
  assert.deepEqual(first.current, [LONG_NAME]);
  assert.equal(first.path, "/home/u/one");
  assert.ok(Math.abs(first.screenH - 0.56 * 900) < 1, `expanded, the preview is 56vh as before (${first.screenH})`);
  assert.ok(first.screenFromBottom < 1, "the live preview is at its bottom");

  await cdp.eval(`(() => { const a = document.querySelector(".mtx-send textarea"); a.value = "a draft"; a.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await focusToggle();
  await key(cdp, "Enter");
  await cdp.until(`document.querySelector(".mtx-details-head").getAttribute("aria-expanded") === "false"`, "collapsed by Enter");
  const shut = await seen();
  assert.deepEqual([shut.listShown, shut.summary, shut.stored, shut.focused], [false, LONG_NAME, "1", true], "one line naming the session; stored; focus kept");
  assert.ok(shut.cardH < 50 && shut.headH < 32, `the card is its header line (${shut.cardH} px)`);
  assert.ok(shut.screenH > first.screenH + 20, `the preview grew: ${first.screenH} -> ${shut.screenH}`);
  assert.ok(shut.mainOverflow <= 1, `and the column still fits without scrolling (${shut.mainOverflow})`);
  assert.ok(shut.screenFromBottom < 1, "still at the bottom of the live preview");
  assert.deepEqual([shut.draft, shut.current, shut.sameScreen], ["a draft", [LONG_NAME], true]);

  // A refresh that changes the details: the hidden list is updated, nothing else is touched.
  server("/home/u/two");
  await cdp.until(`[...document.querySelectorAll(".mtx-claude dd")].some((d) => d.textContent === "/home/u/two")`, "the new pane path in the details");
  const after = await seen();
  assert.deepEqual([after.expanded, after.listShown, after.sameToggle, after.focused, after.sameScreen, after.draft, after.current], ["false", false, true, true, true, "a draft", [LONG_NAME]], "still collapsed, same toggle, still focused");
  assert.ok(Math.abs(after.screenH - shut.screenH) < 1 && after.screenFromBottom < 1);

  // Scrolled up in the preview: it is paused there, and toggling leaves it where the user reads.
  const PAUSED = `[document.querySelector(".mtx-screen").scrollTop, document.querySelector(".mtx-screenbar span").textContent]`;
  await cdp.eval(`document.querySelector(".mtx-screen").scrollTop = 100`);
  await cdp.until(`document.querySelector(".mtx-screenbar span").textContent === "Paused while scrolled up"`, "the preview paused");
  for (const want of ["true", "false"]) {
    await cdp.eval(`document.querySelector(".mtx-details-head").click()`);
    assert.equal(await cdp.eval<string>(`document.querySelector(".mtx-details-head").getAttribute("aria-expanded")`), want);
    await cdp.eval(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);
    assert.deepEqual(await cdp.eval<[number, string]>(PAUSED), [100, "Paused while scrolled up"], `aria-expanded=${want}: the preview stays where it was scrolled to`);
  }

  // Reload: the choice is kept. Space expands again, back to the old size.
  await cdp.load(url);
  await ready();
  const again = await seen();
  assert.deepEqual([again.expanded, again.listShown, again.summary], ["false", false, LONG_NAME], "collapsed after a reload");
  assert.ok(Math.abs(again.screenH - shut.screenH) < 1);
  await focusToggle();
  await key(cdp, " ");
  await cdp.until(`document.querySelector(".mtx-details-head").getAttribute("aria-expanded") === "true"`, "expanded by Space");
  const open = await seen();
  assert.deepEqual([open.listShown, open.summary, open.stored, open.focused, open.path], [true, null, "0", true, "/home/u/two"]);
  assert.ok(Math.abs(open.screenH - first.screenH) < 1 && open.screenFromBottom < 1, "the preview is back at 56vh, at its bottom");

  // ---- phone: stacked, the page scrolls; the preview is as tall as before either way ----
  await cdp.viewport(390, 844);
  await cdp.load(url);
  await ready();
  const phoneOpen = await seen();
  assert.deepEqual([phoneOpen.expanded, phoneOpen.listShown, phoneOpen.pageOverflowX <= 0], ["true", true, true]);
  await cdp.eval(`document.querySelector(".mtx-details-head").click()`);
  const phoneShut = await seen();
  assert.deepEqual([phoneShut.expanded, phoneShut.listShown, phoneShut.summary, phoneShut.stored], ["false", false, LONG_NAME, "1"]);
  assert.ok(phoneShut.summaryCut && phoneShut.headH < 32, `one truncated line (${phoneShut.headH} px)`);
  assert.ok(phoneShut.pageOverflowX <= 0, "nothing sticks out sideways");
  assert.ok(phoneShut.cardH < phoneOpen.cardH - 10, `the card shrank: ${phoneOpen.cardH} -> ${phoneShut.cardH}`);
  assert.ok(Math.abs(phoneShut.screenH - phoneOpen.screenH) < 1 && phoneShut.screenShown, "the stacked preview keeps its size");

  // Without storage the page still works, expanded.
  await cdp.send("Page.enable"); // without it the script below is never run
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `for (const m of ["getItem", "setItem"]) Storage.prototype[m] = () => { throw new DOMException("denied", "SecurityError"); };` });
  await cdp.load(url);
  await cdp.until(`document.querySelector(".mtx-details-head")?.getAttribute("aria-expanded") === "true" && document.querySelector(".mtx-claude dd")`, "the page without storage, expanded");
  assert.equal(await cdp.eval<boolean>(`(() => { try { localStorage.getItem("x"); return false; } catch { return true; } })()`), true, "storage really is refused");
  await cdp.eval(`document.querySelector(".mtx-details-head").click()`);
  assert.equal(await cdp.eval<string>(`document.querySelector(".mtx-details-head").getAttribute("aria-expanded")`), "false", "the toggle works without storage");
});
