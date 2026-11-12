// What Settings → Desktop says under "Show tray icon" (DOM-free, so it's unit-tested).
import type { TrayInfo } from "@motherapp/protocol";

export function trayText(t: TrayInfo | undefined): string {
  if (!t) return "…";
  if (!t.available) return "This motherapp was started with the tray icon off: it never shows one. The setting is still saved.";
  if (t.state === "failed") return `Couldn't show it: ${t.message ?? "unknown error"}`;
  if (t.state === "starting") return t.message ?? "Starting…";
  if (t.state === "running") return "An icon in the tray of the computer motherapp runs on";
  return t.message ?? "No icon in the tray";
}
