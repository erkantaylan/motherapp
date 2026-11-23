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

/**
 * The second folder scanned for tools, outside the checkout (DESIGN.md § 4.8):
 * `<config dir>/tools`, or MOTHERAPP_EXTERNAL_TOOLS_DIR. Undefined means none: the variable set
 * to "" or "off", or a core started under `node --test` (NODE_TEST_CONTEXT, inherited by the
 * cores tests spawn) that wasn't given the variable, so a test never loads the user's own tools.
 */
export function externalToolsDir(env = process.env): string | undefined {
  const v = env.MOTHERAPP_EXTERNAL_TOOLS_DIR;
  if (v !== undefined) return v === "" || v.toLowerCase() === "off" ? undefined : path.resolve(v);
  if (env.NODE_TEST_CONTEXT !== undefined) return undefined;
  return path.join(configDir(env), "tools");
}

/** build-info.json, written by scripts/build-info.sh (npm run build, ./install.sh). */
export function buildInfoFile(env = process.env): string {
  return env.MOTHERAPP_BUILD_INFO ? path.resolve(env.MOTHERAPP_BUILD_INFO) : path.join(repoRoot, "build-info.json");
}

export function defaultWebDir(env = process.env): string {
  return env.MOTHERAPP_WEB_DIR ? path.resolve(env.MOTHERAPP_WEB_DIR) : path.join(repoRoot, "web", "dist");
}
