import { test } from "node:test";
import assert from "node:assert/strict";
import type { NetworkInfo } from "@motherapp/protocol";
import { currentText, LAN_NOTE, networkView, typeLabel } from "../src/networkView.ts";

const home = { name: "Home", uuid: "u-home", type: "802-3-ethernet", device: "eth0", gatewayIp: "192.168.1.1", gatewayMac: "aa:bb:cc:dd:ee:01" };
const base: NetworkInfo = {
  lanEnabled: false,
  open: false,
  reason: "Closed: the Local network switch is off",
  current: home,
  currentTrusted: false,
  trusted: [],
  addresses: [],
  localhostSubdomains: true,
  canChange: true,
};

test("the note says plainly that there is no login", () => {
  assert.match(LAN_NOTE, /^Anyone on your local network can use motherapp while this is on \(no login\)\./);
});

test("current network text and type labels", () => {
  assert.equal(currentText(home), "Home · wired · gateway 192.168.1.1 (aa:bb:cc:dd:ee:01)");
  assert.equal(currentText({ error: "can't identify the network (NetworkManager not available)" }), "unknown network · can't identify the network (NetworkManager not available)");
  assert.equal(currentText(null), "…");
  assert.equal(typeLabel("802-11-wireless"), "Wi-Fi");
  assert.equal(typeLabel("vpn"), "vpn");
});

test("open on a trusted network: addresses shown, ok tone", () => {
  const v = networkView({ ...base, lanEnabled: true, open: true, reason: "Open on Home", currentTrusted: true, trusted: [{ uuid: "u-home", name: "Home", gatewayMac: home.gatewayMac }], addresses: ["http://192.168.1.20:7323/"] }, true);
  assert.equal(v.tone, "ok");
  assert.deepEqual(v.addresses, ["http://192.168.1.20:7323/"]);
  assert.equal(v.trustChecked, true);
  assert.equal(v.trustDisabled, false);
  assert.equal(v.locked, false);
});

test("switch on but closed: error tone with the reason", () => {
  const v = networkView({ ...base, lanEnabled: true, reason: "Closed: not on a trusted network (Wired connection 1)" }, true);
  assert.equal(v.tone, "error");
  assert.equal(v.reason, "Closed: not on a trusted network (Wired connection 1)");
});

test("an unidentifiable network can't be trusted; a different gateway is explained", () => {
  const nm = networkView({ ...base, current: { device: "eth0", error: "can't identify the network (NetworkManager not available)" } }, true);
  assert.equal(nm.trustDisabled, true);
  assert.match(nm.trustHint, /can't be identified/);
  const other = networkView({ ...base, trusted: [{ uuid: "u-home", name: "Home", gatewayMac: "66:66:66:66:66:66" }] }, true);
  assert.equal(other.trustChecked, false);
  assert.match(other.trustHint, /another gateway \(66:66:66:66:66:66\)/);
});

test("read-only from a LAN client or while disconnected", () => {
  const lanTab = networkView({ ...base, canChange: false }, true);
  assert.equal(lanTab.locked, true);
  assert.equal(lanTab.trustDisabled, true);
  assert.match(lanTab.lockedHint, /only on this computer/);
  const down = networkView(base, false);
  assert.equal(down.locked, true);
  assert.equal(down.lockedHint, "");
  assert.equal(networkView(undefined, true).locked, true);
});
