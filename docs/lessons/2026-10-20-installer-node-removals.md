# Installer: Node install removed 133 packages; null-byte warnings (2026-10-20, sub-agent: installer fixes for issues #3 and #4)

## Lessons

- [both] The installer was built and tested in a cloud container with a clean apt state, but the
  real machine had Ubuntu's `nodejs` 18.19.1 (plus `npm`, `eslint`, `webpack`, ~125 `node-*`) and
  nvm's Node 22. NodeSource's `nodejs` conflicts with the distro build, so `apt-get install -y
  nodejs` silently removed 133 packages. → Before an apt install that might replace something,
  simulate it (`LC_ALL=C apt-get -s install <pkg>`, no sudo needed) and show the `Remv` lines in
  the prompt. Never pass `-y` to an install that removes packages. `--yes` stops there unless
  `--allow-removals` is given. Prefer a no-sudo route (nvm/fnm) when one is already installed.
- [both] The test fakes only modelled the machine we imagined. → When a case's fake machine is
  "clean", add a case for the messy version as well: distro package already installed, a second
  Node under `~/.nvm`, binaries in `~/.local/bin`. `scripts/test-install.sh` now has
  `distro_node` (fake `apt-get -s` output with `Remv` lines) and `fake_nvm` (a `nvm.sh` whose
  `nvm install` drops a fake Node under `~/.nvm/versions/node`).
- [both] nvm is a shell function, not a binary. → Run it as
  `bash -c '. "$NVM_DIR/nvm.sh" --no-use; nvm install 24'`, in a fresh bash so the installer's
  `set -u`/`pipefail` don't break nvm.sh. The `;` (not `&&`) is deliberate, because sourcing
  nvm.sh can return non-zero when the default alias points at a missing version.
- [both] Inside `$(...)`, bash itself prints `warning: command substitution: ignored null byte in
  input` (not the command), so `2>/dev/null` on the command doesn't help. → Strip NULs in the
  pipe (`| tr -d '\0'`) before the substitution, for any file that may be binary. `is_managed`
  now also needs a `#!` on line 1, so an ELF that happens to have the marker on line 2 isn't
  treated as ours (the old code would have deleted it on `--uninstall`).
- [cloud] The new tests were checked against the old `install.sh` (copy the repo to the scratchpad,
  put `git show HEAD:install.sh` in it, run its `scripts/test-install.sh`): 34 of them failed
  there, so they really catch the bugs.

## Open

- The `Remv`/`Inst` parsing has only been tested against hand-written `apt-get -s` output that
  matches the format the local tester reported. It hasn't been checked against a real simulation
  on the machine, which is already on NodeSource Node 24, so there is nothing left to remove.
- `fnm install 24` is offered when `fnm` is on PATH or at `$FNM_DIR/fnm`
  (`~/.local/share/fnm/fnm`). Not tested with a real fnm.
