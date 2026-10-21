// What Settings → Network shows, as plain data (DOM-free, so it's unit-tested without a browser).
import type { ActiveNetwork, NetworkInfo } from "@motherapp/protocol";

export const LAN_NOTE = "Anyone on your local network can use motherapp while this is on (no login). It opens only on networks you trust below.";

/** NetworkManager's connection TYPE in words. */
export function typeLabel(type: string | undefined): string {
  if (!type) return "";
  if (type === "802-3-ethernet" || type === "ethernet") return "wired";
  if (type === "802-11-wireless" || type === "wifi") return "Wi-Fi";
  return type;
}

/** "Home · wired · gateway 192.168.1.1 (aa:bb:…)", or why it can't be identified. */
export function currentText(c: ActiveNetwork | null | undefined): string {
  if (!c) return "…";
  const parts = [c.name || c.device || "unknown network"];
  const t = typeLabel(c.type);
  if (t) parts.push(t);
  if (c.gatewayIp) parts.push(`gateway ${c.gatewayIp}${c.gatewayMac ? ` (${c.gatewayMac})` : ""}`);
  return c.error ? `${parts.join(" · ")} · ${c.error}` : parts.join(" · ");
}

export interface NetworkView {
  lanChecked: boolean;
  reason: string;
  tone: "ok" | "info" | "error";
  addresses: string[];
  current: string;
  trustChecked: boolean;
  /** The current network can't be trusted (not identified), or this tab can't change things. */
  trustDisabled: boolean;
  trustHint: string;
  subdomainsChecked: boolean;
  /** Every control is read-only: not connected, or not from this computer. */
  locked: boolean;
  lockedHint: string;
}

export function networkView(info: NetworkInfo | undefined, connected: boolean): NetworkView {
  if (!info) {
    return { lanChecked: false, reason: "…", tone: "info", addresses: [], current: "…", trustChecked: false, trustDisabled: true, trustHint: "", subdomainsChecked: true, locked: true, lockedHint: "" };
  }
  const locked = !connected || !info.canChange;
  const c = info.current;
  const identified = !!c?.uuid && !!c.gatewayMac && !c.error;
  const other = c?.uuid ? info.trusted.find((t) => t.uuid === c.uuid) : undefined;
  let trustHint = "";
  if (!identified) trustHint = "Can't be trusted: it can't be identified";
  else if (other && !info.currentTrusted) trustHint = `Trusted with another gateway (${other.gatewayMac}); trusting it again records this one`;
  return {
    lanChecked: info.lanEnabled,
    reason: info.reason,
    tone: info.open ? "ok" : info.lanEnabled ? "error" : "info",
    addresses: info.addresses,
    current: currentText(c),
    trustChecked: info.currentTrusted,
    trustDisabled: locked || (!identified && !info.currentTrusted),
    trustHint,
    subdomainsChecked: info.localhostSubdomains,
    locked,
    lockedHint: !connected ? "" : info.canChange ? "" : "Read-only here: these settings change only on this computer, with motherapp opened at a localhost address.",
  };
}
