// The sidebar footer, the Settings banner, the "Latest release" row and the "Update now" line
// for each state of the release check and of an update.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReleaseInfo, UpdateStatus, VersionInfo } from "@motherapp/protocol";
import { bannerText, footerText, releaseText, updateView } from "../src/versionText.ts";

const AT = "2026-10-21T10:00:00.000Z";

function version(release?: ReleaseInfo, behind = false): VersionInfo {
  const v: VersionInfo = {
    running: { version: "2", hash: "abc1234", dirty: false, builtAt: AT, string: "v2-abc1234" },
    checkout: { hash: "a".repeat(40), short: "aaaaaaa", version: "2", string: behind ? "v2-def5678" : "v2-abc1234", checkedAt: AT },
    status: behind ? "behind" : "current",
  };
  if (behind) v.message = "running v2-abc1234, checkout is at v2-def5678, run `motherapp install`";
  if (release) v.release = release;
  return v;
}
const rel = (r: Partial<ReleaseInfo>): ReleaseInfo => ({ latest: null, latestUrl: null, newer: false, checkedAt: null, ...r });

test("footer: newer release, up to date, checkout behind, error, disabled, not loaded", () => {
  assert.deepEqual(footerText(undefined), { text: "", title: "" });
  const newer = footerText(version(rel({ latest: "v3", newer: true, checkedAt: AT })));
  assert.equal(newer.text, "v2-abc1234 · v3 available");
  assert.match(newer.title, /v3 is out \(you run v2-abc1234\)/);
  assert.equal(footerText(version(rel({ latest: "v2", checkedAt: AT }))).text, "v2-abc1234", "up to date: just the version");
  assert.equal(footerText(version(rel({ latest: "v2" }), true)).text, "v2-abc1234 · update available", "checkout behind");
  assert.equal(footerText(version(rel({ latest: "v3", newer: true }), true)).text, "v2-abc1234 · v3 available", "a release wins over the checkout");
  assert.equal(footerText(version(rel({ error: "network error (ENOTFOUND)" }))).text, "v2-abc1234", "a failed check adds nothing");
  assert.equal(footerText(version(rel({ disabled: true }))).text, "v2-abc1234");
  assert.equal(footerText(version()).text, "v2-abc1234", "an old core without release info");
});

test("Settings: latest-release row and banner", () => {
  assert.equal(releaseText(undefined), "…");
  assert.equal(releaseText(rel({ disabled: true })), "not checked (updateCheck is false in config.json)");
  assert.equal(releaseText(rel({})), "not checked yet");
  assert.equal(releaseText(rel({ error: "rate-limited by GitHub until x" })), "couldn't check: rate-limited by GitHub until x");
  assert.match(releaseText(rel({ checkedAt: AT })), /^no release published yet · checked /);
  assert.match(releaseText(rel({ latest: "v3", newer: true, checkedAt: AT })), /^v3 available · checked /);
  assert.match(releaseText(rel({ latest: "v2", checkedAt: AT })), /^v2 · up to date · checked /);
  assert.match(releaseText(rel({ latest: "v3", newer: true, checkedAt: AT, error: "network error (EAI_AGAIN)" })), /^v3 available · checked .* · couldn't check: network error \(EAI_AGAIN\)$/, "last good answer plus the error");

  assert.equal(bannerText(undefined), undefined);
  assert.equal(bannerText(version(rel({ latest: "v2" }))), undefined, "up to date: no banner");
  assert.match(bannerText(version(rel({ latest: "v3", newer: true })))!, /^v3 is available \(you run v2-abc1234\)\. Update now below/);
  assert.equal(bannerText(version(rel({}), true)), "running v2-abc1234, checkout is at v2-def5678, run `motherapp install`");
});

test("Update now: idle, running (connected or restarting), done, failed", () => {
  const st = (s: Partial<UpdateStatus>): UpdateStatus => ({ state: "idle", log: "", ...s });
  assert.deepEqual(updateView(undefined), { busy: false, tone: "none", text: "" });
  assert.deepEqual(updateView(st({})), { busy: false, tone: "none", text: "" });
  const running = updateView(st({ state: "running" }));
  assert.equal(running.busy, true);
  assert.match(running.text, /^Updating…/);
  assert.match(updateView(st({ state: "running" }), false).text, /restarting, reconnecting/);
  const done = updateView(st({ state: "done", finishedAt: AT, summary: "v1-aaaaaaa → v2-bbbbbbb", exitCode: 0 }));
  assert.equal(done.busy, false);
  assert.equal(done.tone, "ok");
  assert.match(done.text, /^Last update \(.+\): v1-aaaaaaa → v2-bbbbbbb$/);
  const failed = updateView(st({ state: "failed", exitCode: 1, message: "refusing: the checkout has local changes: commit or discard them yourself" }));
  assert.equal(failed.tone, "error");
  assert.equal(failed.busy, false);
  assert.equal(failed.text, "Last update failed: refusing: the checkout has local changes: commit or discard them yourself");
});
