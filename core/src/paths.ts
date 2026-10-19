import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function configDir(env = process.env): string {
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "motherapp");
}

export function stateDir(env = process.env): string {
  return path.join(env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "motherapp");
}

export function defaultToolsDir(env = process.env): string {
  return env.MOTHERAPP_TOOLS_DIR ? path.resolve(env.MOTHERAPP_TOOLS_DIR) : path.join(repoRoot, "tools");
}

export function defaultWebDir(env = process.env): string {
  return env.MOTHERAPP_WEB_DIR ? path.resolve(env.MOTHERAPP_WEB_DIR) : path.join(repoRoot, "web", "dist");
}
