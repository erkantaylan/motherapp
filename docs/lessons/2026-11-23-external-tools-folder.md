# External tools folder in the core (2026-11-23, sub-agent: core side of the Nebula tool)

The core now also loads tools from `${XDG_CONFIG_HOME:-~/.config}/motherapp/tools/<id>/`
(`core/src/manifest.ts` `discoverAllTools`, `core/src/paths.ts` `externalToolsDir`), for the
Nebula tool that lives in another repo (see `2026-11-23-nebula-investigation.md`). DESIGN.md
§ 4.8 and `docs/extension-contract.md` § 1 "A tool outside this repo" have the rules.

## Lessons

- [both] An absolute `serve[0]` needed no code: `resolveCommand` already did
  `path.resolve(dir, first)` for anything with a `/`, which leaves an absolute path alone, and
  the cwd was already the tool's folder. Only the comment and a test are new.
- [both] A test that needs "a native executable, no Node in the manifest" without depending on
  python or a compiler: write a script whose shebang is `#!${process.execPath}` (extensionless,
  so CommonJS), mode 0755, and put its absolute path in `serve[0]`
  (`writeExternalTool` in `core/test/e2e.test.ts`). The core execs it as it would a binary.
  A tool like that speaks the protocol by hand: answer `describe` and `state.get`, then `action`.
- [both] A core under `node --test` reads no external folder unless
  `MOTHERAPP_EXTERNAL_TOOLS_DIR` names one (`NODE_TEST_CONTEXT`, the same trick as the release
  check, popups and the tray). To test the default location from a test, spawn the core with
  `NODE_TEST_CONTEXT` removed from its environment and a private `XDG_CONFIG_HOME`; then also
  pass `MOTHERAPP_NOTIFY=off`, `MOTHERAPP_TRAY=off` and `MOTHERAPP_RELEASE_URL=off` by hand,
  because the three defaults that variable gave are gone with it.
- [both] `new Manager({ toolsDir, … })` without `externalToolsDir` scans one folder, so the unit
  tests that build a Manager directly needed no change. Only `main.ts` passes the second folder.
- [both] `fs.readdirSync(dir, { withFileTypes: true })` reports a symlink to a directory as a
  symlink, not a directory, so `tools/` has never followed links. The external folder follows
  them on purpose (`fs.statSync`); the tool's `dir` stays the link's own path, which is what
  `/tools/<id>/…` and the cwd use.
- [local] `install.sh` needed no change: it reads `bin` only from `<repo>/tools/*/manifest.json`,
  so external tools get no wrappers. `--uninstall --purge` deletes `~/.config/motherapp` and the
  external tools with it.
- [local] On this machine the installer's Node 24 is `/usr/bin/node` (see the unit file); nvm's
  22 is first on PATH. → `PATH=/usr/bin:$PATH make verify`. `make verify` rebuilds `web/dist`
  and `build-info.json` in the checkout the running service serves from.

## Open

- Not tried with a real compiled binary (the Rust `nebula`), only with the shebang script.
- The running service was not restarted, so the real `~/.config/motherapp/tools` has never been
  read by a real core. A restart is needed after `nebula motherapp install` in any case: the
  folder is read at startup only (no rescan, no watch).
- The web UI doesn't tell external tools from built-in ones (`ToolInfo` has no such field).
- The shortcuts tool reads `commands` from `<repo>/tools` only, so an external tool's commands
  are not suggested there.
- `motherapp doctor` says nothing about external tools.
