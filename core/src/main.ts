// motherapp core entry point: `node core/src/main.ts` (systemd user service in production).
//
// Environment overrides (mainly for development and tests):
//   MOTHERAPP_PORT       listen port (otherwise config.json `port`, default 7323)
//   MOTHERAPP_TOOLS_DIR  directory scanned for tools/*/manifest.json (default <repo>/tools)
//   MOTHERAPP_WEB_DIR    built frontend (default <repo>/web/dist)
//   MOTHERAPP_BUILD_INFO build-info.json to report (default <repo>/build-info.json)
//   MOTHERAPP_RELEASE_URL the "latest release" API URL, or "off" (default GitHub's; off under
//                        node --test unless set)
//   MOTHERAPP_NOTIFY     "off": no desktop popups and no sounds for tools' notifications (the
//                        history and settings still work); off under node --test unless "on"
//   MOTHERAPP_TRAY       "off": no tray icon from this core, whatever config.json `tray` says;
//                        off under node --test unless "on"
//   XDG_CONFIG_HOME, XDG_STATE_HOME as usual
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LogService, RotatingFile } from "./logService.ts";
import { Manager } from "./manager.ts";
import { buildInfoFile, configDir, defaultToolsDir, defaultWebDir, repoRoot, stateDir } from "./paths.ts";
import { startServer } from "./server.ts";
import { ReleaseChecker } from "./releases.ts";
import { openInBrowser } from "./tray.ts";
import { Updater } from "./updater.ts";
import { Checkout, readBuildInfo, VersionSource } from "./version.ts";

/**
 * What "Update now" runs: the installer's ~/.local/bin/motherapp wrapper (it carries the
 * installer's Node), else the checkout's scripts/motherapp.sh with this core's Node. This
 * Node's directory goes first on PATH either way.
 */
function updateCommand(): { command: string[]; env: Record<string, string> } {
  const env: Record<string, string> = { PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}` };
  const wrapper = path.join(os.homedir(), ".local", "bin", "motherapp");
  try {
    if (fs.statSync(wrapper).isFile()) return { command: [wrapper, "install"], env };
  } catch {
    // no wrapper (never installed with install.sh): use the repo script
  }
  return { command: ["/bin/bash", path.join(repoRoot, "scripts", "motherapp.sh"), "install"], env: { ...env, MOTHERAPP_NODE: process.execPath } };
}

/** The popup's icon by path, so it shows without install.sh's copy in the icon theme. */
const appIcon = path.join(repoRoot, "web", "public", "icon.png");
/** The tray helper and the icon it shows while a tool is in trouble (core/src/tray.ts). */
const trayHelper = path.join(repoRoot, "core", "tray", "motherapp-tray.py");
const trayWarningIcon = path.join(repoRoot, "core", "tray", "warning.png");

async function main(): Promise<void> {
  const log = new LogService({ file: new RotatingFile({ file: path.join(stateDir(), "log.jsonl") }) });
  const build = readBuildInfo(buildInfoFile());
  log.core("info", `motherapp core starting ${build.string}`, {
    version: build.string,
    builtAt: build.builtAt,
    ...(build.error ? { buildInfo: build.error } : {}),
    node: process.version,
    pid: process.pid,
  });
  const manager = new Manager({
    toolsDir: defaultToolsDir(),
    configFile: path.join(configDir(), "config.json"),
    log,
    ...(fs.existsSync(appIcon) ? { notifyIcon: appIcon } : {}),
    tray: {
      // The distribution's Python: that is the one apt's python3-gi is installed for.
      command: [fs.existsSync("/usr/bin/python3") ? "/usr/bin/python3" : "python3", trayHelper, appIcon, trayWarningIcon],
      // The address the desktop entry opens too (install.sh renders the same port into it).
      onOpen: () => void openInBrowser(panelUrl(), (msg) => log.core("warn", msg)),
    },
  });
  manager.init();

  // Cores that tests start (node --test sets NODE_TEST_CONTEXT) never ask GitHub on their own.
  const releaseUrl = process.env.MOTHERAPP_RELEASE_URL || undefined;
  const releaseOff = releaseUrl === "off" || (releaseUrl === undefined && process.env.NODE_TEST_CONTEXT !== undefined);
  const release = new ReleaseChecker({
    current: build.version,
    enabled: manager.config.updateCheck !== false && !releaseOff,
    ...(releaseUrl && !releaseOff ? { url: releaseUrl } : {}),
    cacheFile: path.join(stateDir(), "release-check.json"),
    log: (level, msg, data) => log.core(level, msg, data),
  });
  const version = new VersionSource(build, new Checkout({ repo: repoRoot }), release);
  const updater = new Updater({ logFile: path.join(stateDir(), "update.log"), running: build.string, ...updateCommand() });

  let listeningOn: number | undefined;
  const panelUrl = () => `http://127.0.0.1:${listeningOn ?? manager.config.port}/`;
  const envPort = process.env.MOTHERAPP_PORT;
  const port = envPort !== undefined && envPort !== "" ? Number(envPort) : manager.config.port;
  let server;
  try {
    server = await startServer({ manager, log, webDir: defaultWebDir(), port, version, updater });
  } catch (e) {
    log.core("error", `cannot listen on 127.0.0.1:${port}: ${(e as Error).message}`);
    await manager.shutdown();
    process.exit(1);
  }
  log.core("info", `listening on http://127.0.0.1:${server.port}/`, { port: server.port });
  listeningOn = server.port;
  release.start();
  manager.tray.start();

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.core("info", `shutting down (${signal})`);
    release.stop();
    await manager.shutdown();
    await server.close();
    log.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("uncaughtException", (e) => {
    log.core("error", `uncaught exception: ${e.stack ?? e.message}`);
    process.exit(1);
  });
}

void main();
