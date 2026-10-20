// Maps an I2C bus to its DRM connector name ("DP-1") through sysfs. libddcutil 1.4's display
// info has no connector field, so the libddcutil backend looks it up here; the CLI backend
// reads it from `ddcutil detect` instead. A connector directory either has a `ddc` symlink to
// its I2C adapter or (DisplayPort AUX) the adapter as an `i2c-N` subdirectory.
import * as fs from "node:fs";
import * as path from "node:path";

export const DRM_ROOT = "/sys/class/drm";

/** "card1-DP-1" -> "DP-1". */
export function stripCard(name: string): string {
  return name.replace(/^card\d+-/, "");
}

export function connectorForBus(bus: number, root = DRM_ROOT): string | undefined {
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return undefined;
  }
  const adapter = `i2c-${bus}`;
  for (const name of entries.sort()) {
    if (!/^card\d+-/.test(name)) continue;
    const dir = path.join(root, name);
    try {
      if (path.basename(fs.realpathSync(path.join(dir, "ddc"))) === adapter) return stripCard(name);
    } catch {
      // no ddc link
    }
    if (fs.existsSync(path.join(dir, adapter))) return stripCard(name);
  }
  return undefined;
}
