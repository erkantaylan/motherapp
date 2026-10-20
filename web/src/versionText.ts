// What the sidebar footer and the Settings "Version" section say about the running build, the
// latest release and an update from the browser. Pure functions (no DOM), so they are tested
// on their own (web/test/versionText.test.ts).
import type { ReleaseInfo, UpdateStatus, VersionInfo } from "@motherapp/protocol";

export const when = (iso: string | null | undefined): string => (iso ? new Date(iso).toLocaleString() : "unknown");

/** Sidebar footer: "v1-abc1234 · v3 available", or "· update available" when the checkout moved on. */
export function footerText(v: VersionInfo | undefined): { text: string; title: string } {
  if (!v) return { text: "", title: "" };
  const r = v.release;
  let suffix = "";
  let title = v.message ?? `built ${v.running.builtAt ?? "(unknown)"}`;
  if (r?.newer && r.latest) {
    suffix = ` · ${r.latest} available`;
    title = `${r.latest} is out (you run ${v.running.string}): Settings → Update now, or \`motherapp install\``;
  } else if (v.status === "behind") {
    suffix = " · update available";
  }
  return { text: `${v.running.string}${suffix}`, title };
}

/** The Settings "Latest release" row. */
export function releaseText(r: ReleaseInfo | undefined): string {
  if (!r) return "…";
  if (r.disabled) return "not checked (updateCheck is false in config.json)";
  const err = r.error ? `couldn't check: ${r.error}` : "";
  if (r.latest === null) {
    if (err) return err;
    return r.checkedAt ? `no release published yet · checked ${when(r.checkedAt)}` : "not checked yet";
  }
  const parts = [r.newer ? `${r.latest} available` : `${r.latest} · up to date`];
  if (r.checkedAt) parts.push(`checked ${when(r.checkedAt)}`);
  if (err) parts.push(err);
  return parts.join(" · ");
}

/** The banner on Settings: a newer release, else the checkout moved on, else nothing. */
export function bannerText(v: VersionInfo | undefined): string | undefined {
  if (!v) return undefined;
  const r = v.release;
  if (r?.newer && r.latest) return `${r.latest} is available (you run ${v.running.string}). Update now below, or run \`motherapp install\` in a terminal.`;
  if (v.status === "behind") return v.message;
  return undefined;
}

export interface UpdateView {
  /** An update is running: the button is disabled. */
  busy: boolean;
  tone: "none" | "info" | "ok" | "error";
  text: string;
}

/** The line under "Update now". `connected` false while the service restarts. */
export function updateView(s: UpdateStatus | undefined, connected = true): UpdateView {
  if (!s || s.state === "idle") return { busy: false, tone: "none", text: "" };
  if (s.state === "running") {
    return { busy: true, tone: "info", text: connected ? "Updating… (motherapp install is running; the service restarts at the end)" : "Updating… the service is restarting, reconnecting…" };
  }
  const at = s.finishedAt ? ` (${when(s.finishedAt)})` : "";
  if (s.state === "done") return { busy: false, tone: "ok", text: `Last update${at}: ${s.summary ?? "finished"}` };
  return { busy: false, tone: "error", text: `Last update failed${at}: ${s.message ?? "see the log"}` };
}
