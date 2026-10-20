// motherapp core entry point: `node core/src/main.ts` (systemd user service in production).
//
// Environment overrides (mainly for development and tests):
//   MOTHERAPP_PORT       listen port (otherwise config.json `port`, default 7323)
//   MOTHERAPP_TOOLS_DIR  directory scanned for tools/*/manifest.json (default <repo>/tools)
//   MOTHERAPP_WEB_DIR    built frontend (default <repo>/web/dist)
//   MOTHERAPP_BUILD_INFO build-info.json to report (default <repo>/build-info.json)
//   XDG_CONFIG_HOME, XDG_STATE_HOME as usual
import * as path from "node:path";
import { LogService, RotatingFile } from "./logService.ts";
import { Manager } from "./manager.ts";
import { buildInfoFile, configDir, defaultToolsDir, defaultWebDir, repoRoot, stateDir } from "./paths.ts";
import { startServer } from "./server.ts";
import { Checkout, readBuildInfo, VersionSource } from "./version.ts";

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
  const version = new VersionSource(build, new Checkout({ repo: repoRoot }));

  const manager = new Manager({
    toolsDir: defaultToolsDir(),
    configFile: path.join(configDir(), "config.json"),
    log,
  });
  manager.init();

  const envPort = process.env.MOTHERAPP_PORT;
  const port = envPort !== undefined && envPort !== "" ? Number(envPort) : manager.config.port;
  let server;
  try {
    server = await startServer({ manager, log, webDir: defaultWebDir(), port, version });
  } catch (e) {
    log.core("error", `cannot listen on 127.0.0.1:${port}: ${(e as Error).message}`);
    await manager.shutdown();
    process.exit(1);
  }
  log.core("info", `listening on http://127.0.0.1:${server.port}/`, { port: server.port });

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.core("info", `shutting down (${signal})`);
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
