#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// inboxctl: the motherapp inbox tool. Makes links that let a peer agent (a cloud Claude
// session) type a short message into a Claude Code pane in tmux, through a cloudflared tunnel
// that exposes only the inbox's own 127.0.0.1 listener. `inboxctl serve` is the mode the core
// starts; the other subcommands work from a terminal (`inboxctl help`).
import * as path from "node:path";
import { createTool, defaultStateDir, exitOnBrokenPipe } from "@motherapp/tool-sdk";
import { RealRunner } from "../tmux/src/runner.ts";
import { runCli } from "./src/cli.ts";
import { TmuxPanes } from "./src/panes.ts";
import { InboxService, INITIAL_STATE } from "./src/service.ts";
import { loadSettings, settingsFile } from "./src/settings.ts";
import { Store } from "./src/store.ts";

const runner = new RealRunner();
const stateDir = path.join(defaultStateDir(), "inbox");

if (process.argv[2] === "serve") {
  // persist: false — the links live in the inbox's own 0600 files, not the SDK state file.
  const tool = createTool({ id: "inbox", title: "Inbox", icon: "📨", page: "custom", initialState: INITIAL_STATE, persist: false });
  const file = settingsFile();
  const { settings, error } = loadSettings(file);
  const panes = new TmuxPanes({ runner });
  const service = new InboxService({ tool, panes, store: new Store(stateDir), settings, runner, stateDir });
  // The SDK exits right after SIGTERM; take cloudflared down with us.
  process.once("exit", () => service.tunnel.stop());
  const serving = tool.serve();
  tool.log.info("inbox tool serving", { port: settings.port, socket: panes.socketPath });
  if (error) tool.log.warn(error);
  await service.start();
  await serving;
  await service.stop();
} else {
  exitOnBrokenPipe(); // `inboxctl log | head -1`
  process.exitCode = await runCli(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr, stateDir, panes: { runner } });
}
