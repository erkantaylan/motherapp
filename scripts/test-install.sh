#!/usr/bin/env bash
# Tests for install.sh. Runs the real installer against a fake machine: a copy of the repo,
# a fake $HOME, a fake system root (MOTHERAPP_INSTALL_ROOT) and stub commands on PATH
# (node, npm, apt-cache, apt-get, dpkg-query, systemctl, sudo, id, getent, curl, pw-*, ...).
# Nothing outside a temp dir is touched. Usage: bash scripts/test-install.sh
# Stub bodies are single-quoted on purpose: they expand when the stub runs.
# shellcheck disable=SC2016
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TMP="$(mktemp -d)"
# MOTHERAPP_TEST_KEEP=1 keeps the fake machines (and every installer output) for a look.
if [[ -n ${MOTHERAPP_TEST_KEEP:-} ]]; then echo "# keeping $TMP"; else trap 'rm -rf "$TMP"' EXIT; fi
ENV_BIN="$(command -v env)"
# Fake node binaries answer --version themselves, print their arguments when started the way the
# ~/.local/bin wrappers start them, and hand everything else (the installer's `node -e` manifest
# read) to the real Node running these tests.
REAL_NODE="$(command -v node)" || { echo "Bail out! needs node on PATH"; exit 1; }
# The VERSION number the fake repos get (they copy the real VERSION).
V="$(<"$REPO/VERSION")"

PASSED=0 FAILED=0 CASE="" C="" OUT="" CODE=0

# git for the test's own repos: no system or user config, a fixed identity.
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME=tester GIT_AUTHOR_EMAIL=tester@example.com GIT_COMMITTER_NAME=tester GIT_COMMITTER_EMAIL=tester@example.com

# Real utilities the installer (and the stubs) may use; nothing else from the host is on PATH.
SYSBIN="$TMP/sysbin"
mkdir -p "$SYSBIN"
for t in bash sh env cat cp mv rm mkdir rmdir ls ln chmod touch readlink dirname basename head \
  tail tr cut sort uniq wc grep sed awk sleep install mktemp diff cmp uname find tee date printf git; do
  p="$(command -v "$t")" && [[ $p == /* ]] && ln -s "$p" "$SYSBIN/$t"
done

# ------------------------------------------------------------------ fake machine

stub() { # name body  (body gets "$@"; FAKE, FAKE_STUB and MOTHERAPP_INSTALL_ROOT are exported)
  printf '#!/usr/bin/env bash\n%s\n' "$2" >"$STUB/$1"
  chmod +x "$STUB/$1"
}

make_node() { # dir version
  mkdir -p "$1"
  printf '#!/usr/bin/env bash\ncase ${1:-} in\n  --version) echo %s ;;\n  --disable-warning=*) echo "fake-node $*" ;;\n  -e) exec "$REAL_NODE" "$@" ;;\nesac\nexit 0\n' "$2" >"$1/node"
  cat >"$1/npm" <<'EOF'
#!/usr/bin/env bash
echo "npm $* (node=$(command -v node))" >>"$FAKE/calls"
case "$*" in
  ci) mkdir -p node_modules && touch node_modules/.package-lock.json ;;
  "run build") mkdir -p web/dist && touch web/dist/index.html ;;
esac
EOF
  chmod +x "$1/node" "$1/npm"
}

pw_stubs() { local t; for t in "$@"; do stub "$t" 'exit 0'; done; }
sound_files() {
  mkdir -p "$ROOT/usr/share/sounds/freedesktop/stereo"
  touch "$ROOT/usr/share/sounds/freedesktop/stereo/audio-channel-front-"{left,right}.oga
}

# A machine where everything is in place; cases then break one thing.
new_case() {
  CASE="$1"
  C="$TMP/$CASE"
  R="$C/repo dir"            # space on purpose: quoting must hold
  HOME_="$C/home" ROOT="$C/root" FAKE="$C/fake" STUB="$C/stub"
  mkdir -p "$R/packaging" "$R/scripts" "$HOME_" "$ROOT" "$FAKE"/{apt,dpkg,active,enabled} "$STUB"
  cp "$REPO/install.sh" "$REPO/VERSION" "$REPO/.gitignore" "$R/"
  cp "$REPO/scripts/build-info.sh" "$REPO/scripts/motherapp.sh" "$R/scripts/"
  cp "$REPO/packaging/motherapp.service" "$R/packaging/"
  local t
  for t in "$REPO"/tools/*/manifest.json; do   # the real manifests (audio declares "bin")
    t="${t%/manifest.json}"
    mkdir -p "$R/tools/${t##*/}"
    cp "$t/manifest.json" "$t"/*.ts "$R/tools/${t##*/}/"
  done
  : >"$FAKE/calls"
  NODE_PATH_DIR="$C/node24/bin"
  make_node "$NODE_PATH_DIR" v24.1.0
  EXTRA_ENV=() EXTRA_PATH=""

  # apt archive (candidates) and dpkg database (installed)
  echo 1.4.1-1build2 >"$FAKE/apt/ddcutil"
  echo 1.4.1-1build2 >"$FAKE/apt/libddcutil4"
  echo 1.4.1-1build2 >"$FAKE/apt/libddcutil-dev"
  echo 1.0.5-1ubuntu3.3 >"$FAKE/apt/pipewire-bin"
  echo 0.4.17-1ubuntu4.1 >"$FAKE/apt/wireplumber"
  echo 0.8-2ubuntu1 >"$FAKE/apt/sound-theme-freedesktop"
  echo 4.3-4build2 >"$FAKE/apt/i2c-tools"
  echo 24.1.0-1nodesource1 >"$FAKE/apt/nodejs"
  echo 1.4.1-1build2 >"$FAKE/dpkg/ddcutil"
  echo 1.4.1-1build2 >"$FAKE/dpkg/libddcutil4"
  mkdir -p "$ROOT/usr/lib/x86_64-linux-gnu"
  touch "$ROOT/usr/lib/x86_64-linux-gnu/libddcutil.so.4"

  pw_stubs pw-dump pw-play pw-record pw-metadata wpctl
  sound_files
  stub ddcutil '[[ ${1:-} == --version ]] && echo "ddcutil 1.4.1"; exit 0'

  mkdir -p "$ROOT/sys/module/i2c_dev" "$ROOT/etc/modules-load.d" "$ROOT/etc/apt/sources.list.d" "$ROOT/dev"
  echo i2c-dev >"$ROOT/etc/modules-load.d/i2c-dev.conf"
  touch "$ROOT/dev/i2c-1" "$ROOT/dev/i2c-3"
  echo "tester adm i2c" >"$FAKE/user_groups"
  echo "tester adm i2c" >"$FAKE/proc_groups"
  touch "$FAKE/group_i2c"
  touch "$FAKE/active/pipewire" "$FAKE/active/wireplumber" "$FAKE/active/pipewire-pulse"

  # $FAKE/sudo_password: sudo needs a password, so `sudo -n` fails like the real one.
  stub sudo 'echo "sudo $*" >>"$FAKE/calls"
if [[ ${1:-} == -n ]]; then
  [[ -f $FAKE/sudo_password ]] && { echo "sudo: a password is required" >&2; exit 1; }
  shift
fi
[[ $* == true ]] && exit 0
exec "$@"'
  stub id 'case "$*" in
  -u) echo 1000 ;;
  -un) echo tester ;;
  "-nG tester") cat "$FAKE/user_groups" ;;
  -nG) cat "$FAKE/proc_groups" ;;
  *) exit 1 ;;
esac'
  stub getent '[[ "$*" == "group i2c" && -f $FAKE/group_i2c ]] && echo "i2c:x:998:" && exit 0; exit 2'
  stub apt-cache '[[ $1 == policy ]] || exit 1; shift
for p in "$@"; do
  echo "$p:"
  if [[ -f $FAKE/dpkg/$p ]]; then echo "  Installed: $(cat "$FAKE/dpkg/$p")"; else echo "  Installed: (none)"; fi
  if [[ -f $FAKE/apt/$p ]]; then echo "  Candidate: $(cat "$FAKE/apt/$p")"; else echo "  Candidate: (none)"; fi
done'
  stub dpkg-query 'case "$1" in
  -W) p="${*: -1}"; [[ -f $FAKE/dpkg/$p ]] || { echo "dpkg-query: no packages found matching $p" >&2; exit 1; }
      echo "installed $(cat "$FAKE/dpkg/$p")" ;;
  -S) echo "dpkg-query: no path found matching pattern $2" >&2; exit 1 ;;
esac'
  # apt-get -s prints $FAKE/apt_sim (Remv/Inst lines) when a case writes one.
  stub apt-get 'echo "apt-get $*" >>"$FAKE/calls"
if [[ $1 == -s ]]; then
  if [[ -f $FAKE/apt_sim ]]; then cat "$FAKE/apt_sim"; else echo "Inst nodejs (24.1.0-1nodesource1 NodeSource:nodistro [amd64])"; fi
  exit 0
fi
[[ $1 == install ]] || exit 0
R="$MOTHERAPP_INSTALL_ROOT"
for p in "${@:2}"; do
  [[ $p == -* ]] && continue
  [[ -f $FAKE/apt/$p ]] || { echo "E: Unable to locate package $p"; exit 100; }
  cp "$FAKE/apt/$p" "$FAKE/dpkg/$p"
  case $p in
    pipewire-bin) for t in pw-dump pw-play pw-record pw-metadata; do printf "#!/bin/sh\n" >"$FAKE_STUB/$t"; chmod +x "$FAKE_STUB/$t"; done ;;
    wireplumber) printf "#!/bin/sh\n" >"$FAKE_STUB/wpctl"; chmod +x "$FAKE_STUB/wpctl" ;;
    sound-theme-freedesktop) mkdir -p "$R/usr/share/sounds/freedesktop/stereo"; touch "$R/usr/share/sounds/freedesktop/stereo/audio-channel-front-"{left,right}.oga ;;
    libddcutil4) mkdir -p "$R/usr/lib/x86_64-linux-gnu"; touch "$R/usr/lib/x86_64-linux-gnu/libddcutil.so.4" ;;
    nodejs) mkdir -p "$R/usr/bin"; cp "$FAKE/node_template" "$R/usr/bin/node"; cp "$FAKE/npm_template" "$R/usr/bin/npm"; chmod +x "$R/usr/bin/node" "$R/usr/bin/npm" ;;
  esac
done'
  cp "$NODE_PATH_DIR/npm" "$FAKE/npm_template"
  cp "$NODE_PATH_DIR/node" "$FAKE/node_template"
  stub gpg 'out=""; while (($#)); do [[ $1 == -o ]] && out=$2; shift; done; echo "gpg -o $out" >>"$FAKE/calls"; cat >"$out"'
  stub modprobe 'echo "modprobe $*" >>"$FAKE/calls"; mkdir -p "$MOTHERAPP_INSTALL_ROOT/sys/module/i2c_dev"; touch "$MOTHERAPP_INSTALL_ROOT/dev/i2c-1" "$MOTHERAPP_INSTALL_ROOT/dev/i2c-3"'
  stub usermod 'echo "usermod $*" >>"$FAKE/calls"; [[ $1 == -aG ]] && echo "$(cat "$FAKE/user_groups") $2" >"$FAKE/user_groups"'
  stub systemctl 'echo "systemctl $*" >>"$FAKE/calls"
[[ $1 == --user ]] || exit 1; shift
cmd=$1; shift; q=0; [[ ${1:-} == --quiet ]] && { q=1; shift; }; [[ ${1:-} == --now ]] && shift
u=${1:-}
case $cmd in
  show-environment) [[ -f $FAKE/no_user_bus ]] && exit 1; echo HOME=x ;;
  is-active) if [[ -f $FAKE/active/$u ]]; then ((q)) || echo active; else ((q)) || echo inactive; exit 3; fi ;;
  is-enabled) if [[ -f $FAKE/enabled/$u ]]; then ((q)) || echo enabled; else ((q)) || echo disabled; exit 1; fi ;;
  enable) touch "$FAKE/enabled/$u" "$FAKE/active/$u"; [[ -f $FAKE/http_broken ]] || touch "$FAKE/http_up" ;;
  restart|start) touch "$FAKE/active/$u"; [[ -f $FAKE/http_broken ]] || touch "$FAKE/http_up" ;;
  disable) rm -f "$FAKE/enabled/$u" "$FAKE/active/$u" "$FAKE/http_up" ;;
esac
exit 0'
  # $FAKE/api_status, when a case writes one, is the running core's /api/status answer.
  stub curl 'url="${*: -1}"; echo "curl $url" >>"$FAKE/calls"
case $url in
  *nodesource*) echo FAKE-KEY ;;
  http://127.0.0.1:*/api/status*) [[ -f $FAKE/api_status ]] || exit 7; cat "$FAKE/api_status" ;;
  http://127.0.0.1:*) [[ -f $FAKE/http_up ]] || exit 7 ;;
esac'
  stub journalctl 'echo "journalctl $*" >>"$FAKE/calls"; echo "fake journal line"'
}

# run_installer [args...]  (stdin is passed through; default </dev/null)
run_installer() {
  local path="$STUB:$SYSBIN"
  [[ -n $NODE_PATH_DIR ]] && path="$NODE_PATH_DIR:$path"
  [[ -n $EXTRA_PATH ]] && path="$EXTRA_PATH:$path"
  OUT="$C/out.$(date +%s%N)"
  (cd "$C" && "$ENV_BIN" -i HOME="$HOME_" PATH="$path" FAKE="$FAKE" FAKE_STUB="$STUB" REAL_NODE="$REAL_NODE" \
    MOTHERAPP_INSTALL_ROOT="$ROOT" MOTHERAPP_INSTALL_WAIT=1 "${EXTRA_ENV[@]}" \
    bash "$R/install.sh" "$@") >"$OUT" 2>&1
  CODE=$?
}

# run_motherapp [args...]  runs the checkout's scripts/motherapp.sh like the wrapper does, from
# another directory, with the same fake machine as run_installer.
run_motherapp() {
  local path="$STUB:$SYSBIN"
  [[ -n $NODE_PATH_DIR ]] && path="$NODE_PATH_DIR:$path"
  OUT="$C/out.$(date +%s%N)"
  (cd / && "$ENV_BIN" -i HOME="$HOME_" PATH="$path" FAKE="$FAKE" FAKE_STUB="$STUB" REAL_NODE="$REAL_NODE" \
    MOTHERAPP_INSTALL_ROOT="$ROOT" "${EXTRA_ENV[@]}" bash "$R/scripts/motherapp.sh" "$@") >"$OUT" 2>&1
  CODE=$?
}

git_commit_all() { # repo message
  git -C "$1" add -A && git -C "$1" commit -q -m "$2"
}

# ------------------------------------------------------------------ assertions

fail() {
  FAILED=$((FAILED + 1))
  printf 'not ok - %s: %s\n' "$CASE" "$1"
  [[ -n $OUT && -f $OUT ]] && sed 's/^/    | /' "$OUT"
  printf '    calls:\n'; sed 's/^/    > /' "$FAKE/calls"
}
pass() { PASSED=$((PASSED + 1)); printf 'ok - %s: %s\n' "$CASE" "$1"; }
check() { local d=$1; shift; if "$@"; then pass "$d"; else fail "$d"; fi; }

out_has() { grep -qE -- "$1" "$OUT"; }
out_lacks() { ! grep -qE -- "$1" "$OUT"; }
calls_has() { grep -qF -- "$1" "$FAKE/calls"; }
calls_lacks() { ! grep -qE -- "$1" "$FAKE/calls"; }
exit_is() { [[ $CODE == "$1" ]]; }
file_has() { grep -qF -- "$2" "$1"; }

UNIT() { printf '%s' "$HOME_/.config/systemd/user/motherapp.service"; }
WRAP() { printf '%s' "$HOME_/.local/bin/${1:-audioctl}"; }
MARKER="# managed by motherapp install.sh"

# ------------------------------------------------------------------ cases

new_case all-ok
run_installer --yes
check "exit 0" exit_is 0
check "RESULT: OK" out_has '^RESULT: OK'
check "node OK" out_has '^OK +node +v24\.1\.0 at '"$NODE_PATH_DIR/node"
check "libddcutil OK" out_has '^OK +libddcutil +libddcutil4 1\.4\.1-1build2'
check "no sudo used" calls_lacks '^sudo'
check "npm ci ran with Node 24 first on PATH" calls_has "npm ci (node=$NODE_PATH_DIR/node)"
check "npm run build ran" calls_has "npm run build"
check "daemon-reload" calls_has "systemctl --user daemon-reload"
check "enable --now" calls_has "systemctl --user enable --now motherapp.service"
check "http checked on 7323" calls_has "curl http://127.0.0.1:7323/"
check "http OK" out_has '^OK +http +http://127\.0\.0\.1:7323/ responds'
check "no colour codes without a TTY" out_lacks $'\e\\['
check "unit ExecStart" file_has "$(UNIT)" "ExecStart=\"$NODE_PATH_DIR/node\" \"$R/core/src/main.ts\""
check "unit WorkingDirectory" file_has "$(UNIT)" "WorkingDirectory=$R"
check "unit has no placeholders" bash -c '! grep -q "@[A-Z_]*@" "$1"' _ "$(UNIT)"
check "unit has no port override" bash -c '! grep -q MOTHERAPP_PORT= "$1"' _ "$(UNIT)"
check "unit drops template-only comments" bash -c '! grep -q "^#@" "$1"' _ "$(UNIT)"
check "unit says it is generated" file_has "$(UNIT)" "generated by install.sh"
check "unit keeps [Install]" file_has "$(UNIT)" "WantedBy=default.target"
cp "$(UNIT)" "$C/unit.first"
: >"$FAKE/calls"
run_installer --yes
check "re-run: exit 0" exit_is 0
check "re-run: unit unchanged" out_has '^OK +unit +.* unchanged'
check "re-run: restart instead of enable" calls_has "systemctl --user restart motherapp.service"
check "re-run: same unit" cmp -s "$(UNIT)" "$C/unit.first"
run_installer --check
check "--check after install: exit 0" exit_is 0
check "--check: unit up to date" out_has '^OK +unit +.*up to date'
check "--check: service active" out_has '^OK +service +active \(enabled\)'
check "--check: wrapper up to date" out_has '^OK +audioctl +.*/\.local/bin/audioctl up to date'
check "--check: motherapp wrapper up to date" out_has '^OK +motherapp +.*/\.local/bin/motherapp up to date'

new_case node22
NODE_PATH_DIR="$C/node22/bin"
make_node "$NODE_PATH_DIR" v22.23.2
run_installer --check
check "--check: exit 1" exit_is 1
check "node MISSING with found version" out_has '^MISSING +node +need Node >= 24; found v22\.23\.2 at '"$NODE_PATH_DIR/node"
check "origin reported" out_has 'not from a dpkg package'
check "NodeSource fix offered" out_has 'deb\.nodesource\.com/node_24\.x nodistro main'
check "fnm/nvm alternative" out_has 'fnm install 24'
check "RESULT: FAIL" out_has '^RESULT: FAIL'
run_installer <<<"n"
check "answer no: exit 1" exit_is 1
check "answer no: no sudo" calls_lacks '^sudo'
check "answer no: build skipped" out_has '^SKIP +build +Node >= 24 missing'
check "answer no: no npm" calls_lacks '^npm'
run_installer --yes
check "--yes: exit 0" exit_is 0
check "--yes: NodeSource key" calls_has "gpg -o $ROOT/etc/apt/keyrings/nodesource.gpg"
check "--yes: NodeSource list" file_has "$ROOT/etc/apt/sources.list.d/nodesource.list" \
  "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main"
check "--yes: apt-get update" calls_has "sudo apt-get update"
check "--yes: apt-get install nodejs" calls_has "sudo apt-get install -y nodejs"
check "--yes: node 24 found after install" out_has "^OK +node +v24\\.1\\.0 at $ROOT/usr/bin/node"
check "--yes: old node reported as shadowing" out_has '^WARN +node-on-path +`node` on PATH is v22\.23\.2'
check "--yes: unit uses the new node" file_has "$(UNIT)" "ExecStart=\"$ROOT/usr/bin/node\""
check "--yes: npm from the new node" calls_has "npm ci"
check "--yes: install simulated first" calls_has "apt-get -s install nodejs"
check "no distro nodejs: no removal warning" out_lacks 'REMOVES'
check "no distro nodejs: says it removes nothing" out_has 'step 2 of 2: sudo apt-get install nodejs \(installs nodejs 24\.1\.0-1nodesource1; removes nothing\)'
check "no nvm/fnm: none offered" out_lacks 'Run: (nvm|fnm) install'
check "no version-manager note for a NodeSource node" out_lacks '^    note: Node is'

# Ubuntu's nodejs 18 is installed: installing NodeSource's nodejs would remove these.
distro_node() {
  echo 18.19.1+dfsg-6ubuntu5 >"$FAKE/dpkg/nodejs"
  {
    for p in npm eslint webpack node-gyp terser libnode-dev libnode109 nodejs-doc node-acorn node-ajv; do
      echo "Remv $p [1.0-1]"
    done
    echo "Inst nodejs [18.19.1+dfsg-6ubuntu5] (24.22.0-1nodesource1 NodeSource:nodistro [amd64])"
    echo "Conf nodejs (24.22.0-1nodesource1 NodeSource:nodistro [amd64])"
  } >"$FAKE/apt_sim"
}
# A fake nvm.sh: `nvm install 24` puts a fake Node v24.5.0 under ~/.nvm/versions/node.
fake_nvm() {
  mkdir -p "$HOME_/.nvm"
  cat >"$HOME_/.nvm/nvm.sh" <<'EOF'
nvm() {
  echo "nvm $*" >>"$FAKE/calls"
  [[ $1 == install ]] || return 0
  local d; d="$(dirname "${BASH_SOURCE[0]}")/versions/node/v$2.5.0/bin"
  mkdir -p "$d"
  sed "s/v24\.1\.0/v$2.5.0/" "$FAKE/node_template" >"$d/node"
  cp "$FAKE/npm_template" "$d/npm"
  chmod +x "$d/node" "$d/npm"
}
EOF
}
line_of() { grep -nE -- "$1" "$OUT" | head -n1 | cut -d: -f1; }

new_case nvm-offered
NODE_PATH_DIR="$C/node22/bin"
make_node "$NODE_PATH_DIR" v22.23.2
distro_node
fake_nvm
run_installer --yes
check "exit 0" exit_is 0
check "nvm offered" out_has 'Run: nvm install 24 \(no sudo\)'
check "prompt says the paths are version-specific" out_has 'version-specific path under .*/\.nvm'
check "nvm install ran" calls_has "nvm install 24"
check "no sudo, no NodeSource" calls_lacks '^sudo|nodesource|apt-get'
check "NodeSource not offered" out_lacks 'NodeSource, step'
check "node from nvm chosen" out_has "^OK +node +v24\\.5\\.0 at $HOME_/\\.nvm/versions/node/v24\\.5\\.0/bin/node"
check "unit uses the nvm node" file_has "$(UNIT)" "ExecStart=\"$HOME_/.nvm/versions/node/v24.5.0/bin/node\""
check "summary: re-run note" out_has '^    note: Node is .*/\.nvm/.*re-run \./install\.sh after upgrading or removing'

new_case nvm-declined
NODE_PATH_DIR="$C/node22/bin"
make_node "$NODE_PATH_DIR" v22.23.2
distro_node
fake_nvm
run_installer <<<$'n\ny'
check "nvm offered before NodeSource" test "$(line_of 'Run: nvm install')" -lt "$(line_of 'NodeSource, step 1 of 2')"
check "nvm not run" calls_lacks '^nvm'
check "repo step is separate and installs nothing" out_has 'step 1 of 2: add its apt repo .*This installs and removes nothing'
check "repo added" calls_has "sudo apt-get update"
check "removals listed in the prompt text" \
  out_has "replaces Ubuntu's nodejs 18\\.19\\.1\\+dfsg-6ubuntu5 and REMOVES 10 package\\(s\\): npm, eslint, webpack, node-gyp, terser, libnode-dev, libnode109, nodejs-doc, \\.\\.\\."
check "full list shown, first name" out_has '^      npm eslint webpack '
check "full list shown, last name" out_has '^      .*node-ajv$'
check "install step asks again" out_has 'step 2 of 2: sudo apt-get install nodejs, which REMOVES the 10 package\(s\) listed above'
check "no answer: nothing installed" calls_lacks 'apt-get install'
check "no answer: exit 1" exit_is 1
run_installer <<<$'n\ny'
check "re-run: repo already configured" out_has 'NodeSource apt repo for Node 24 is already configured'
check "yes: installs without -y, so apt asks too" calls_has "sudo apt-get install nodejs"
check "yes: no -y with removals" calls_lacks 'apt-get install -y nodejs'
check "yes: exit 0" exit_is 0

new_case removals-yes
NODE_PATH_DIR="$C/node22/bin"
make_node "$NODE_PATH_DIR" v22.23.2
distro_node
run_installer --yes
check "--yes: removals listed" out_has 'REMOVES 10 package'
check "--yes: stops before removing" out_has "not installing: --yes doesn't cover an install that removes packages"
check "--yes: points at --allow-removals" out_has 'Re-run with --yes --allow-removals'
check "--yes: nodejs not installed" calls_lacks 'apt-get install'
check "--yes: exit 1" exit_is 1
run_installer --yes --allow-removals
check "--allow-removals: installs" calls_has "sudo apt-get install -y nodejs"
check "--allow-removals: prompt says why it was accepted" out_has '\[y/N\] y \(--yes --allow-removals\)'
check "--allow-removals: exit 0" exit_is 0

new_case nvm-node
NODE_PATH_DIR="$C/node22/bin"
make_node "$NODE_PATH_DIR" v22.23.2
make_node "$HOME_/.nvm/versions/node/v24.3.0/bin" v24.3.0
make_node "$HOME_/.nvm/versions/node/v23.0.0/bin" v23.0.0
run_installer --yes
check "exit 0" exit_is 0
check "picks Node 24 from ~/.nvm" out_has "^OK +node +v24\\.3\\.0 at $HOME_/.nvm/versions/node/v24.3.0/bin/node"
check "no NodeSource" calls_lacks 'nodejs'

new_case libddcutil-missing
rm "$FAKE/dpkg/libddcutil4" "$ROOT/usr/lib/x86_64-linux-gnu/libddcutil.so.4"
echo 2.1.4-1 >"$FAKE/apt/libddcutil5"   # a newer soname in the archive must not win over ddcutil's own
run_installer --check
check "--check: exit 1" exit_is 1
check "MISSING libddcutil4" out_has '^MISSING +libddcutil +shared library not installed \(package: libddcutil4\)'
check "fix names the apt candidate" out_has 'sudo apt-get install libddcutil4 +\(apt candidate 1\.4\.1-1build2\)'
run_installer --yes
check "--yes: exit 0" exit_is 0
check "--yes: apt-get install libddcutil4" calls_has "sudo apt-get install -y libddcutil4"
check "--yes: OK after install" out_has '^OK +libddcutil +libddcutil4 1\.4\.1-1build2'

new_case libddcutil-unknown
rm "$FAKE/dpkg/libddcutil4" "$ROOT/usr/lib/x86_64-linux-gnu/libddcutil.so.4" "$FAKE/apt/libddcutil4"
run_installer --check
check "no apt candidate: MISSING with explanation" out_has '^MISSING +libddcutil +.*apt knows none of: libddcutil5 libddcutil4 libddcutil0'

new_case not-in-i2c-group
echo "tester adm" >"$FAKE/user_groups"
echo "tester adm" >"$FAKE/proc_groups"
run_installer --check
check "--check: exit 1" exit_is 1
check "MISSING i2c-group" out_has '^MISSING +i2c-group +tester is not in group i2c'
check "usermod offered" out_has 'sudo usermod -aG i2c tester'
run_installer --yes
check "--yes: usermod ran" calls_has "sudo usermod -aG i2c tester"
check "--yes: re-login WARN" out_has '^WARN +i2c-group +tester was added to i2c, but this login session predates it'
check "--yes: exit 0 (re-login is a warning)" exit_is 0

new_case i2c-module
rm -r "$ROOT/sys/module/i2c_dev" "$ROOT/etc/modules-load.d/i2c-dev.conf" "$ROOT"/dev/i2c-*
run_installer --check
check "--check: module MISSING" out_has '^MISSING +i2c-dev +kernel module not loaded'
check "--check: devices MISSING" out_has '^MISSING +i2c-devices'
run_installer --yes
check "--yes: modprobe" calls_has "sudo modprobe i2c-dev"
check "--yes: modules-load.d file" file_has "$ROOT/etc/modules-load.d/i2c-dev.conf" "i2c-dev"
check "--yes: devices OK" out_has '^OK +i2c-devices +2: i2c-1 i2c-3'
check "--yes: exit 0" exit_is 0

# MOTHERAPP_UNATTENDED=1 is how Settings -> "Update now" runs it: no terminal for a password.
new_case unattended-sudo-password
rm -r "$ROOT/sys/module/i2c_dev" "$ROOT/etc/modules-load.d/i2c-dev.conf" "$ROOT"/dev/i2c-*
touch "$FAKE/sudo_password"
EXTRA_ENV=(MOTHERAPP_UNATTENDED=1)
run_installer --yes
check "sudo needs a password: exit 1" exit_is 1
check "sudo needs a password: only sudo -n tried" calls_lacks '^sudo (modprobe|install|tee)'
check "sudo needs a password: modprobe not run" calls_lacks '^modprobe'
check "sudo needs a password: FAIL row says use a terminal" out_has '^FAIL +sudo +sudo needs your password, .*run `motherapp install` in a terminal'
check "sudo needs a password: says what it skipped" out_has "can't be typed here \\(unattended\\): not running sudo modprobe i2c-dev"
check "sudo needs a password: said once" test "$(grep -c "can't be typed here" "$OUT")" = 1
check "sudo needs a password: RESULT: FAIL" out_has '^RESULT: FAIL'

new_case unattended-sudo-nopasswd
rm -r "$ROOT/sys/module/i2c_dev" "$ROOT/etc/modules-load.d/i2c-dev.conf" "$ROOT"/dev/i2c-*
EXTRA_ENV=(MOTHERAPP_UNATTENDED=1)
run_installer --yes
check "passwordless sudo: runs it with -n" calls_has "sudo -n modprobe i2c-dev"
check "passwordless sudo: exit 0" exit_is 0
check "passwordless sudo: no sudo FAIL row" out_lacks '^FAIL +sudo '

new_case unattended-nothing-missing
touch "$FAKE/sudo_password"
EXTRA_ENV=(MOTHERAPP_UNATTENDED=1)
run_installer --yes
check "nothing missing: no sudo at all" calls_lacks '^sudo'
check "nothing missing: exit 0" exit_is 0

new_case i2c-not-persistent
rm "$ROOT/etc/modules-load.d/i2c-dev.conf"
run_installer <<<"n"
check "loaded but not at boot: WARN" out_has '^WARN +i2c-dev +module loaded now, but nothing loads it at boot'
check "loaded but not at boot: offered" out_has 'write /etc/modules-load\.d/i2c-dev\.conf so it loads at boot \[y/N\]'
check "declined: no sudo" calls_lacks '^sudo'
check "loaded but not at boot: still exit 0" exit_is 0

new_case audio-missing
rm "$STUB"/pw-* "$STUB/wpctl" "$ROOT"/usr/share/sounds/freedesktop/stereo/*.oga
rm "$FAKE/active/pipewire-pulse"
run_installer --check
check "pw-dump MISSING -> pipewire-bin" out_has '^MISSING +pw-dump +not on PATH \(Ubuntu package: pipewire-bin\)'
check "wpctl MISSING -> wireplumber" out_has '^MISSING +wpctl +not on PATH \(Ubuntu package: wireplumber\)'
check "sound theme MISSING" out_has '^MISSING +sound-theme +missing .*audio-channel-front-left\.oga'
check "pipewire-pulse inactive is a WARN" out_has '^WARN +pipewire-pulse +user service is inactive'
run_installer --yes
check "--yes: one apt-get call for all packages" calls_has "sudo apt-get install -y pipewire-bin wireplumber sound-theme-freedesktop"
check "--yes: exit 0" exit_is 0

new_case check-changes-nothing
NODE_PATH_DIR="$C/node22/bin"
make_node "$NODE_PATH_DIR" v22.23.2
rm "$FAKE/dpkg/libddcutil4" "$ROOT/usr/lib/x86_64-linux-gnu/libddcutil.so.4" "$ROOT/etc/modules-load.d/i2c-dev.conf"
rm -r "$ROOT/sys/module/i2c_dev"
echo "tester adm" >"$FAKE/user_groups"
snapshot() { (cd "$C" && find home root "repo dir" -printf '%p %s %T@\n' | sort; cat fake/user_groups); }
snapshot >"$C/before"
run_installer --check
snapshot >"$C/after"
check "exit 1" exit_is 1
check "file tree unchanged" cmp -s "$C/before" "$C/after"
check "no sudo/apt/npm/enable/reload" calls_lacks '^(sudo|apt-get|npm|usermod|modprobe|gpg)|systemctl --user (enable|restart|daemon-reload|disable)'
check "no prompts" out_lacks '\[y/N\]'

new_case uninstall
run_installer --yes
mkdir -p "$HOME_/.config/motherapp" "$HOME_/.local/state/motherapp"
echo '{"port":7323}' >"$HOME_/.config/motherapp/config.json"
touch "$HOME_/.local/state/motherapp/log.jsonl"
: >"$FAKE/calls"
run_installer --uninstall
check "exit 0" exit_is 0
check "disable --now" calls_has "systemctl --user disable --now motherapp.service"
check "unit removed" test ! -e "$(UNIT)"
check "daemon-reload" calls_has "systemctl --user daemon-reload"
check "config kept" test -f "$HOME_/.config/motherapp/config.json"
check "state kept" test -f "$HOME_/.local/state/motherapp/log.jsonl"
check "no sudo" calls_lacks '^sudo'
run_installer --uninstall
check "uninstall twice: exit 0" exit_is 0
check "uninstall twice: unit not present" out_has '^OK +unit +.*not present'
check "uninstall twice: no wrappers left" out_has '^OK +commands +no motherapp wrappers'
run_installer --uninstall --purge <<<"n"
check "purge answered no: config kept" test -d "$HOME_/.config/motherapp"
run_installer --uninstall --purge --yes
check "purge: exit 0" exit_is 0
check "purge: config deleted" test ! -e "$HOME_/.config/motherapp"
check "purge: state deleted" test ! -e "$HOME_/.local/state/motherapp"

new_case port-env
EXTRA_ENV=(MOTHERAPP_PORT=7400)
run_installer --yes
check "exit 0" exit_is 0
check "unit sets MOTHERAPP_PORT right after [Service]" \
  bash -c 'grep -A1 -x "\[Service\]" "$1" | grep -qx "Environment=MOTHERAPP_PORT=7400"' _ "$(UNIT)"
check "http checked on 7400" calls_has "curl http://127.0.0.1:7400/"

new_case port-config
mkdir -p "$HOME_/.config/motherapp"
echo '{ "port": 7999, "tools": {} }' >"$HOME_/.config/motherapp/config.json"
run_installer --yes
check "http checked on the config.json port" calls_has "curl http://127.0.0.1:7999/"
check "no env override in unit" bash -c '! grep -q MOTHERAPP_PORT= "$1"' _ "$(UNIT)"

new_case decline-service
run_installer <<<"n"
check "unit written" test -f "$(UNIT)"
check "not enabled" calls_lacks 'enable --now'
check "WARN service" out_has '^WARN +service +unit installed but not enabled'
check "exit 0" exit_is 0

new_case http-broken
touch "$FAKE/http_broken"
run_installer --yes
check "FAIL http" out_has "^FAIL +http +http://127\\.0\\.0\\.1:7323/ didn't respond"
check "journal shown" out_has 'fake journal line'
check "exit 1" exit_is 1

new_case no-user-bus
touch "$FAKE/no_user_bus"
run_installer --check
check "systemd-user MISSING" out_has '^MISSING +systemd-user'
check "exit 1" exit_is 1

new_case usage
run_installer --bogus
check "unknown option: exit 2" exit_is 2
run_installer --purge
check "--purge alone: exit 2" exit_is 2
run_installer --help
check "--help: exit 0" exit_is 0
check "--help: mentions --check" out_has '[-][-]check'
check "--help: documents --allow-removals" out_has '^  [-][-]allow-removals'

new_case root-refused
stub id '[[ $1 == -u ]] && echo 0; exit 0'
run_installer --check
check "running as root: exit 2" exit_is 2

new_case bin-wrappers
run_installer --yes
check "exit 0" exit_is 0
check "wrapper written" out_has "^OK +audioctl +wrote $HOME_/\\.local/bin/audioctl \\(node: "
check "wrapper is executable" test -x "$(WRAP)"
check "wrapper carries the marker on line 2" bash -c '[[ "$(sed -n 2p "$1")" == "$2" ]]' _ "$(WRAP)" "$MARKER"
check "wrapper execs the chosen Node by absolute path" file_has "$(WRAP)" \
  "exec $(printf %q "$NODE_PATH_DIR/node") --disable-warning=ExperimentalWarning $(printf %q "$R/tools/audio/audioctl.ts") \"\$@\""
check "no wrapper for the demo tool (no bin)" bash -c '! ls -A "$1" | grep -qi demo' _ "$HOME_/.local/bin"
# Run it the way a keyboard shortcut would: no PATH at all, an argument with a space.
WOUT="$("$ENV_BIN" -i "$(WRAP)" list "a b" 2>&1)"
check "wrapper runs with an empty environment" test "$WOUT" = \
  "fake-node --disable-warning=ExperimentalWarning $R/tools/audio/audioctl.ts list a b"
check "motherapp wrapper written" out_has "^OK +motherapp +wrote $HOME_/\\.local/bin/motherapp \\(node: "
check "motherapp wrapper is executable" test -x "$(WRAP motherapp)"
check "motherapp wrapper carries the marker on line 2" bash -c '[[ "$(sed -n 2p "$1")" == "$2" ]]' _ "$(WRAP motherapp)" "$MARKER"
check "motherapp wrapper passes the chosen Node" file_has "$(WRAP motherapp)" "export MOTHERAPP_NODE=$(printf %q "$NODE_PATH_DIR/node")"
check "motherapp wrapper execs scripts/motherapp.sh by absolute path" \
  file_has "$(WRAP motherapp)" " $(printf %q "$R/scripts/motherapp.sh") \"\$@\""
check "motherapp wrapper runs bash by absolute path" bash -c 'grep -qE "^exec /[^ ]*/bash " "$1"' _ "$(WRAP motherapp)"
WOUT="$(cd / && "$ENV_BIN" -i "$(WRAP motherapp)" --version 2>&1)"
check "motherapp wrapper runs from / with an empty environment" test "$WOUT" = "motherapp v${V}-unknown"
check "\$HOME/.local/bin not on PATH: WARN" out_has '^WARN +bin-path +.*/\.local/bin is not on PATH'
check "PATH WARN explains the re-login" out_has "fix: log out and back in: Ubuntu's ~/\\.profile adds ~/\\.local/bin"
check "PATH WARN suggests the absolute path for shortcuts" out_has "absolute path, e\\.g\\. $HOME_/\\.local/bin/audioctl"
cp "$(WRAP)" "$C/wrap.first"
run_installer --yes
check "re-run: wrapper unchanged" out_has '^OK +audioctl +.*/\.local/bin/audioctl unchanged'
check "re-run: same wrapper" cmp -s "$(WRAP)" "$C/wrap.first"
EXTRA_PATH="$HOME_/.local/bin"
run_installer --check
check "on PATH: bin-path OK" out_has '^OK +bin-path +.*/\.local/bin is on PATH'
check "on PATH: no bin-path WARN" out_lacks '^WARN +bin-path'
EXTRA_PATH=""
# A wrapper that a moved Node would leave behind: --check reports it and leaves it alone.
sed -i 's|^exec .*|exec /old/node "$@"|' "$(WRAP)"
cp "$(WRAP)" "$C/wrap.old"
cp "$(WRAP)" "$(WRAP oldctl)"   # a wrapper for a command no manifest declares any more
tree() { (cd "$C" && find home root "repo dir" -printf '%p %s %T@\n' | sort); }
tree >"$C/before"
: >"$FAKE/calls"
run_installer --check
tree >"$C/after"
check "--check: changed wrapper is a WARN" out_has '^WARN +audioctl +.*differs from what the installer would write'
check "--check: stale wrapper is a WARN" out_has '^WARN +oldctl +.*no tool declares it'
check "--check: file tree unchanged" cmp -s "$C/before" "$C/after"
check "--check: exit 0" exit_is 0
run_installer --yes
check "update: rewritten" out_has '^OK +audioctl +updated '
check "update: back to the current wrapper" cmp -s "$(WRAP)" "$C/wrap.first"
check "update: stale wrapper removed" test ! -e "$(WRAP oldctl)"
rm "$(WRAP)"
run_installer --check
check "--check: missing wrapper is MISSING" out_has '^MISSING +audioctl +.*/\.local/bin/audioctl not installed'
check "--check: missing wrapper fails the check" exit_is 1

new_case bin-foreign
mkdir -p "$HOME_/.local/bin"
printf '#!/bin/sh\necho my own audioctl\n' >"$(WRAP)"
cp "$(WRAP)" "$C/foreign"
run_installer --yes
check "foreign file: WARN" out_has "^WARN +audioctl +$HOME_/\\.local/bin/audioctl exists and wasn't written by install\\.sh; left alone"
check "foreign file: untouched" cmp -s "$(WRAP)" "$C/foreign"
check "foreign file: still exit 0" exit_is 0
run_installer --check
check "--check: foreign file is a WARN" out_has "^WARN +audioctl +.*wasn't written by install\\.sh"
rm "$(WRAP)"
ln -s "$R/tools/audio/audioctl.ts" "$(WRAP)"   # a symlink the user made by hand
run_installer --yes
check "foreign symlink: WARN" out_has "^WARN +audioctl +.*wasn't written by install\\.sh; left alone"
check "foreign symlink: still a symlink" test -L "$(WRAP)"
run_installer --uninstall
check "uninstall: foreign symlink kept" test -L "$(WRAP)"

new_case bin-uninstall
run_installer --yes
printf '#!/bin/sh\n# managed by me\n' >"$(WRAP mine)"
printf '#!/bin/sh\necho %s\n' "$MARKER" >"$(WRAP mine2)"   # marker text, but not on line 2
: >"$FAKE/calls"
run_installer --uninstall
check "exit 0" exit_is 0
check "marked wrapper removed" test ! -e "$(WRAP)"
check "motherapp wrapper removed" test ! -e "$(WRAP motherapp)"
check "motherapp removal reported" out_has '^OK +motherapp +removed .*/\.local/bin/motherapp'
check "removal reported" out_has '^OK +audioctl +removed .*/\.local/bin/audioctl'
check "unmarked files kept" test -f "$(WRAP mine)" -a -f "$(WRAP mine2)"
check "the bin directory itself is kept" test -d "$HOME_/.local/bin"

new_case bin-no-node
NODE_PATH_DIR="$C/node22/bin"
make_node "$NODE_PATH_DIR" v22.23.2
run_installer --check
check "--check without Node 24: commands SKIP" out_has '^SKIP +commands +can.t check the wrappers'
check "--check without Node 24: SKIP counted as skipped, not as a warning" \
  out_has '^RESULT: FAIL \([0-9]+ required item\(s\) missing or failed, 0 warning\(s\), 1 skipped\)$'
run_installer <<<"n"
check "install without Node 24: commands SKIP" out_has '^SKIP +commands +Node >= 24 missing; wrappers not written'
check "install without Node 24: optional SKIP counted as skipped" out_has '^RESULT: FAIL \(.*, 1 skipped\)$'
check "install without Node 24: nothing written" test ! -e "$HOME_/.local/bin"

new_case bin-binaries
mkdir -p "$HOME_/.local/bin"
printf '\177ELF\002\001\001\000\000\000\000\000\n\000\000\001\000' >"$(WRAP uv)"   # a binary, NULs and all
printf '\177ELF\000\000\n%s\n\000\000' "$MARKER" >"$(WRAP ffmpeg)"   # marker on line 2, but no #!
chmod +x "$(WRAP uv)" "$(WRAP ffmpeg)"
cp "$(WRAP ffmpeg)" "$C/ffmpeg"
run_installer --yes
check "install: no null-byte warning" out_lacks 'null byte'
check "install: exit 0" exit_is 0
check "install: binary with the marker on line 2 kept" cmp -s "$(WRAP ffmpeg)" "$C/ffmpeg"
run_installer --check
check "--check: no null-byte warning" out_lacks 'null byte'
check "--check: binaries aren't reported" out_lacks '^WARN +(uv|ffmpeg) '
run_installer --uninstall
check "uninstall: no null-byte warning" out_lacks 'null byte'
check "uninstall: binaries kept" test -f "$(WRAP uv)" -a -f "$(WRAP ffmpeg)"
check "uninstall: wrapper removed" test ! -e "$(WRAP)"

new_case bin-bad-manifest
printf '{"id":"bad","title":"Bad","serve":["x"],"bin":{"../x":"x.ts","badctl":"../escape.ts","nofile":"missing.ts"}}\n' \
  >"$R/tools/demo/manifest.json"
run_installer --yes
check "bad command name: WARN" out_has '^WARN +commands +tools/demo/manifest\.json: bad command name "\.\./x"'
check "script outside the tool dir: WARN" out_has '^WARN +commands +tools/demo/manifest\.json: badctl: the script must be a relative path'
check "missing script: WARN" out_has '^WARN +commands +tools/demo/manifest\.json: nofile: missing\.ts not found'
check "good entries still written" test -f "$(WRAP)"
check "bad entries not written" test ! -e "$(WRAP badctl)" -a ! -e "$(WRAP nofile)"
check "exit 0 (bad bin entries are warnings)" exit_is 0

# ------------------------------------------------------------------ GNOME keyboard shortcuts

# Fake gsettings/dconf backed by files: $FAKE/gs/list holds the custom-keybindings array as
# gsettings prints it, $FAKE/gs/entries/<path with / as _>/<key> each value (also as printed).
sc_stubs() {
  mkdir -p "$FAKE/gs/entries"
  cat >"$STUB/gsettings" <<'EOF'
#!/usr/bin/env bash
echo "gsettings $* (LC_ALL=${LC_ALL:-})" >>"$FAKE/calls"
[[ -f $FAKE/gs_broken ]] && { echo "No such schema “$2”" >&2; exit 1; }
d="$FAKE/gs"
if [[ $2 == org.gnome.settings-daemon.plugins.media-keys && $3 == custom-keybindings ]]; then
  case $1 in
    get) if [[ -f $d/list ]]; then cat "$d/list"; else echo "@as []"; fi ;;
    set) [[ -f $FAKE/gs_noop ]] || printf '%s\n' "$4" >"$d/list" ;;   # gs_noop: "succeeds", writes nowhere
    *) exit 1 ;;
  esac
  exit 0
fi
[[ $2 == org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:/*/ ]] || { echo "No such schema" >&2; exit 1; }
e="$d/entries/$(printf '%s' "${2#*:}" | tr / _)"
case $1 in
  get) if [[ -f $e/$3 ]]; then cat "$e/$3"; else echo "''"; fi ;;
  reset) rm -f "$e/$3" ;;
  *) exit 1 ;;
esac
EOF
  cat >"$STUB/dconf" <<'EOF'
#!/usr/bin/env bash
echo "dconf $*" >>"$FAKE/calls"
[[ $1 == reset && $2 == -f ]] && rm -rf "$FAKE/gs/entries/$(printf '%s' "$3" | tr / _)"
exit 0
EOF
  chmod +x "$STUB/gsettings" "$STUB/dconf"
}
SC_DIR=/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings
sc_entry() { # segment name command binding  (values stored as gsettings prints them)
  local e
  e="$FAKE/gs/entries/$(printf '%s' "$SC_DIR/$1/" | tr / _)"
  mkdir -p "$e"
  printf "'%s'\n" "$2" >"$e/name"
  printf "'%s'\n" "$3" >"$e/command"
  printf "'%s'\n" "$4" >"$e/binding"
}
sc_list() { # segments... -> writes the array
  local s out=""
  for s in "$@"; do out+="${out:+, }'$SC_DIR/$s/'"; done
  if [[ -z $out ]]; then echo "@as []" >"$FAKE/gs/list"; else echo "[$out]" >"$FAKE/gs/list"; fi
}
MACHINE_SEGS=(custom0 dc-map-toggle dc-map-opacity dc-map-zoomout dc-map-zoomin dc-map-fit dc-map-follow dc-map-clicks)
sc_machine() { # entries for the user's 8 shortcuts (issue #7); sc_list sets the array
  local s
  for s in "${MACHINE_SEGS[@]}"; do sc_entry "$s" "$s" "/home/erkan/.local/bin/dc-map $s" "<Control>F9"; done
}
sc_entries() { (cd "$FAKE/gs/entries" && find . -type f | sort | while read -r f; do printf '%s=%s\n' "$f" "$(cat "$f")"; done); }

new_case shortcuts-none
sc_stubs
sc_machine
sc_list "${MACHINE_SEGS[@]}"
run_installer --check
check "--check: no motherapp shortcuts, the others counted" out_has '^OK +shortcuts +no motherapp keyboard shortcuts \(8 other custom shortcut\(s\) left alone\)'
check "--check: gsettings run with a UTF-8 locale" calls_has "gsettings get org.gnome.settings-daemon.plugins.media-keys custom-keybindings (LC_ALL=C.UTF-8)"
check "--check: nothing written" calls_lacks '^gsettings (set|reset)|^dconf'
run_installer --uninstall
check "uninstall without motherapp shortcuts: OK, no prompt" out_has '^OK +shortcuts +no motherapp keyboard shortcuts'
check "uninstall without motherapp shortcuts: nothing written" calls_lacks '^gsettings (set|reset)|^dconf'

new_case shortcuts
sc_stubs
sc_machine
run_installer --yes   # writes the audioctl/brightctl/... wrappers
sc_entry motherapp-mute-firefox "Mute Firefox" "$HOME_/.local/bin/audioctl app-mute firefox toggle" "<Control><Alt>m"
sc_entry motherapp-gone "Gone" "sh -c '$HOME_/.local/bin/missingctl x && true'" "<Super>F1"
# ours mixed in between the user's: the order of the others must survive
sc_list custom0 dc-map-toggle motherapp-mute-firefox dc-map-opacity dc-map-zoomout dc-map-zoomin dc-map-fit motherapp-gone dc-map-follow dc-map-clicks
cp "$FAKE/gs/list" "$C/list.before"
: >"$FAKE/calls"
run_installer --check
check "--check: counts ours, names the missing wrapper" \
  out_has "^WARN +shortcuts +2 motherapp keyboard shortcut\\(s\\), 1 run a missing wrapper: 'Gone' -> $HOME_/\\.local/bin/missingctl"
check "--check: fix suggests reinstalling or removing" out_has 'fix: \./install\.sh writes the wrappers again'
check "--check: still exit 0" exit_is 0
check "--check: nothing written" calls_lacks '^gsettings (set|reset)|^dconf'
sc_entries >"$C/entries.before"
run_installer --uninstall   # stdin closed: the answer is no
check "uninstall: asks, default no" out_has "Remove the 2 GNOME keyboard shortcut\\(s\\) motherapp made \\('Mute Firefox', 'Gone'\\)\\? .*\\[y/N\\]"
check "uninstall: says they'd point at removed wrappers" out_has "^WARN +shortcuts +kept 2 motherapp keyboard shortcut\\(s\\) .*they point at removed wrappers"
check "uninstall declined: list untouched" cmp -s "$FAKE/gs/list" "$C/list.before"
sc_entries >"$C/entries.declined"
check "uninstall declined: entries untouched" cmp -s "$C/entries.declined" "$C/entries.before"
check "uninstall declined: nothing written" calls_lacks '^gsettings (set|reset)|^dconf'
check "uninstall declined: wrappers still removed" test ! -e "$(WRAP)"
check "uninstall declined: exit 0" exit_is 0
run_installer --uninstall <<<"y"
check "uninstall yes: the user's 8 kept, in order" \
  file_has "$FAKE/gs/list" "['$SC_DIR/custom0/', '$SC_DIR/dc-map-toggle/', '$SC_DIR/dc-map-opacity/', '$SC_DIR/dc-map-zoomout/', '$SC_DIR/dc-map-zoomin/', '$SC_DIR/dc-map-fit/', '$SC_DIR/dc-map-follow/', '$SC_DIR/dc-map-clicks/']"
check "uninstall yes: dconf reset of ours" calls_has "dconf reset -f $SC_DIR/motherapp-mute-firefox/"
check "uninstall yes: ours' keys gone" test ! -e "$FAKE/gs/entries/$(printf '%s' "$SC_DIR/motherapp-gone/" | tr / _)"
sc_entries >"$C/entries.after"
grep -v motherapp "$C/entries.before" >"$C/entries.theirs"
check "uninstall yes: the user's keys untouched" cmp -s "$C/entries.after" "$C/entries.theirs"
check "uninstall yes: reported" out_has "^OK +shortcuts +removed 2 motherapp keyboard shortcut\\(s\\): 'Mute Firefox', 'Gone'"

new_case shortcuts-yes
sc_stubs
sc_machine
sc_entry motherapp-only "Only" "/x" "<Super>F2"
sc_list motherapp-only
run_installer --uninstall --yes
check "--yes removes them" out_has '^OK +shortcuts +removed 1 motherapp'
check "--yes: last one removed writes @as []" file_has "$FAKE/gs/list" "@as []"
rm -f "$STUB/dconf"
sc_entry motherapp-again "Again" "/x" "<Super>F3"
sc_list custom0 motherapp-again
run_installer --uninstall --yes
check "without dconf: reset key by key" calls_has "gsettings reset org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:$SC_DIR/motherapp-again/ binding"
check "without dconf: others kept" file_has "$FAKE/gs/list" "['$SC_DIR/custom0/']"
sc_entry motherapp-stuck "Stuck" "/x" "<Super>F4"
sc_list custom0 motherapp-stuck
touch "$FAKE/gs_noop"
: >"$FAKE/calls"
run_installer --uninstall --yes
check "a write that doesn't stick: FAIL" out_has "^FAIL +shortcuts +the custom-keybindings list didn't change"
check "a write that doesn't stick: keys not reset" calls_lacks 'gsettings reset|^dconf'
check "a write that doesn't stick: exit 1" exit_is 1

new_case shortcuts-unavailable
sc_stubs
touch "$FAKE/gs_broken"
run_installer --check
check "no schema: an info line, no record" out_has 'GNOME keyboard shortcuts: gsettings or GNOME.s media-keys schema isn.t available here'
check "no schema: no shortcuts row" out_lacks '^[A-Z]+ +shortcuts '
rm -f "$FAKE/gs_broken"
echo "['/odd\"path/']" >"$FAKE/gs/list"
run_installer --uninstall --yes
check "unparsable list: WARN, nothing written" out_has "^WARN +shortcuts +can't read the custom-keybindings list safely"
check "unparsable list: list untouched" file_has "$FAKE/gs/list" "['/odd\"path/']"
printf '%s\n' "['/back\\\\slash/', '$SC_DIR/motherapp-x/']" >"$FAKE/gs/list"
run_installer --check
check "a backslash in a path: WARN, not misread" out_has "^WARN +shortcuts +can't read the custom-keybindings list safely"

# ------------------------------------------------------------------ version (v<N>-<hash>[-dirty])

json_field() { # file field -> the value as JSON
  "$REAL_NODE" -e 'const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(JSON.stringify(j[process.argv[2]]))' "$1" "$2"
}
is_iso_utc() { [[ $1 =~ ^\"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z\"$ ]]; }

check "package.json: npm run build writes build-info.json" file_has "$REPO/package.json" '"build": "bash scripts/build-info.sh --write && '
check "VERSION is a plain number" bash -c '[[ "$(<"$1")" =~ ^[0-9]+$ ]]' _ "$REPO/VERSION"

new_case version-no-git
run_installer --yes
check "not a git checkout: OK v${V}-unknown" out_has "^OK +version +v${V}-unknown \\(not a git checkout"
check "not a git checkout: hash unknown in build-info.json" test "$(json_field "$R/build-info.json" hash)" = '"unknown"'

new_case version
echo "notes" >"$R/README.md"
git init -q -b main "$R" && git_commit_all "$R" "first"
H="$(git -C "$R" rev-parse --short=7 HEAD)"
check "build-info.sh prints the version string" test "$(bash "$R/scripts/build-info.sh")" = "v${V}-$H"
run_installer --yes
check "clean: OK version v${V}-<hash>" out_has "^OK +version +v${V}-$H\$"
check "clean: the version row comes right after the build" \
  bash -c 'grep -A1 -E "^OK +build " "$1" | grep -qE "^OK +version "' _ "$OUT"
check "build-info.json: version" test "$(json_field "$R/build-info.json" version)" = "\"$V\""
check "build-info.json: hash" test "$(json_field "$R/build-info.json" hash)" = "\"$H\""
check "build-info.json: dirty false" test "$(json_field "$R/build-info.json" dirty)" = false
check "build-info.json: builtAt is ISO 8601 UTC" is_iso_utc "$(json_field "$R/build-info.json" builtAt)"
check "build-info.json: nothing else" test "$("$REAL_NODE" -e 'console.log(Object.keys(JSON.parse(require("fs").readFileSync(process.argv[1]))).join())' "$R/build-info.json")" = "version,hash,dirty,builtAt"
check "the build leaves the tree clean (build output is gitignored)" test -z "$(git -C "$R" status --porcelain)"
run_installer --check
check "--check: built = checkout" out_has "^OK +version +built v${V}-$H, checkout at v${V}-$H\$"
echo "local edit" >>"$R/README.md"
check "build-info.sh: a local edit gives -dirty" test "$(bash "$R/scripts/build-info.sh")" = "v${V}-$H-dirty"
run_installer --yes
check "dirty: OK version v${V}-<hash>-dirty" out_has "^OK +version +v${V}-$H-dirty\$"
check "dirty: build-info.json dirty true" test "$(json_field "$R/build-info.json" dirty)" = true
git_commit_all "$R" "second"
H2="$(git -C "$R" rev-parse --short=7 HEAD)"
run_installer --check
check "--check: checkout moved on: WARN" out_has "^WARN +version +built v${V}-$H-dirty, checkout is at v${V}-$H2\$"
check "--check: points at motherapp install" out_has 'fix: motherapp install'
echo 7 >"$R/VERSION"
check "build-info.sh: the number comes from VERSION" test "$(bash "$R/scripts/build-info.sh")" = "v7-$H2-dirty"
echo "x.y" >"$R/VERSION"
check "build-info.sh: a bad VERSION gives v?" test "$(bash "$R/scripts/build-info.sh")" = "v?-$H2-dirty"

# ------------------------------------------------------------------ the motherapp command

# A fake "origin" (bare repo), a "seed" clone to push from, and the checkout "$R" cloned from
# origin. The checkout's install.sh is a stub that writes build-info.json like the real one and
# prints the rows `motherapp install` reads.
upd_case() {
  new_case "$1"
  ORIGIN="$C/origin.git" SEED="$C/seed"
  git init -q --bare -b main "$ORIGIN"
  git clone -q "$ORIGIN" "$SEED" 2>/dev/null
  mkdir -p "$SEED/scripts"
  cp "$REPO/VERSION" "$REPO/.gitignore" "$SEED/"
  cp "$REPO/scripts/build-info.sh" "$REPO/scripts/motherapp.sh" "$SEED/scripts/"
  cat >"$SEED/install.sh" <<'EOF'
#!/usr/bin/env bash
echo "install.sh $*" >>"$FAKE/calls"
v="$(bash "$(dirname "$0")/scripts/build-info.sh" --write)"
echo "OK       version              $v"
if [[ -f $FAKE/http_broken ]]; then echo "FAIL     http                 http://127.0.0.1:7323/ didn't respond within 15s"; exit 1; fi
echo "OK       http                 http://127.0.0.1:7323/ responds"
echo "RESULT: OK (0 warning(s))"
EOF
  git -C "$SEED" checkout -q -b main 2>/dev/null
  git_commit_all "$SEED" "first commit" && git -C "$SEED" push -q origin main 2>/dev/null
  rm -rf "$R"
  git clone -q "$ORIGIN" "$R" 2>/dev/null
  (cd "$R" && FAKE="$FAKE" bash install.sh >/dev/null)   # the build that is "running"
  : >"$FAKE/calls"
  touch "$FAKE/active/motherapp.service" "$FAKE/enabled/motherapp.service"
  H1="$(git -C "$R" rev-parse --short=7 HEAD)"
}
seed_commit() { # message
  echo "$1" >>"$SEED/changes.txt"
  git_commit_all "$SEED" "$1" && git -C "$SEED" push -q origin main 2>/dev/null
}
head_of() { git -C "$1" rev-parse HEAD; }

upd_case upd-current
run_motherapp install
check "up to date: says so" out_has "^already up to date \\(v${V}-$H1, origin/main has nothing new\\)"
check "up to date: fetched" out_has '\+ git fetch origin'
check "up to date: install.sh not run" calls_lacks '^install\.sh'
check "up to date: exit 0" exit_is 0
run_motherapp update
check "update is an alias" out_has '^already up to date'
run_motherapp install --yes
check "install takes no options: exit 2" exit_is 2
rm "$R/build-info.json"
run_motherapp install
check "up to date but no build: says what it does" out_has "^already up to date with origin/main, but no build found \\(build-info\\.json is missing\\): running \\./install\\.sh --yes"
check "up to date but no build: install.sh --yes ran" calls_has "install.sh --yes"
check "up to date but no build: exit 0" exit_is 0
: >"$FAKE/calls"
rm "$FAKE/active/motherapp.service"
run_motherapp install
check "up to date but service stopped: re-installs" out_has "but the service isn't running: running \\./install\\.sh"
check "up to date but service stopped: install.sh ran" calls_has "install.sh --yes"

upd_case upd-pull
seed_commit "add feature A"
seed_commit "fix bug B"
H3="$(git -C "$SEED" rev-parse --short=7 HEAD)"
run_motherapp status
check "status before the pull: the built line" out_has "^built +v${V}-$H1\$"
check "status: service line" out_has '^service +active \(enabled\)'
check "status: not behind before the pull (HEAD hasn't moved)" out_lacks 'run `motherapp install`'
run_motherapp install
check "pull: exit 0" exit_is 0
check "pull: fast-forwarded" test "$(head_of "$R")" = "$(head_of "$SEED")"
check "pull: ran git pull --ff-only" out_has '\+ git pull --ff-only origin main'
check "pull: ran ./install.sh --yes, never --allow-removals" calls_has "install.sh --yes"
check "pull: no --allow-removals" calls_lacks "allow-removals"
check "pull: old -> new" out_has "^    v${V}-$H1 → v${V}-$H3\$"
check "pull: commit list, newest first" \
  bash -c 'grep -A2 "^    commits:" "$1" | sed -n "2,3p" | sed -E "s/^      [0-9a-f]{7,} //" | tr "\n" "," | grep -qx "fix bug B,add feature A,"' _ "$OUT"
check "pull: the first commit isn't listed" out_lacks '^      [0-9a-f]+ first commit'
check "pull: HTTP check result" out_has '^    OK http http://127\.0\.0\.1:7323/ responds$'
run_motherapp install
check "pull, again: already up to date" out_has "^already up to date \\(v${V}-$H3,"
seed_commit "broken release"
touch "$FAKE/http_broken"
run_motherapp install
check "failing install: exit code passed on" exit_is 1
check "failing install: HTTP failure shown" out_has "^    FAIL http http://127\\.0\\.0\\.1:7323/ didn't respond"
check "failing install: says install.sh failed" out_has '\./install\.sh exited with 1'

upd_case upd-dirty
echo "scratch" >"$R/notes.txt"
echo "tweak" >>"$R/VERSION"
seed_commit "upstream change"
before="$(head_of "$R")"
run_motherapp install
check "dirty: exit 1" exit_is 1
check "dirty: refuses" out_has 'refusing: the checkout has local changes'
check "dirty: lists the changes" out_has '^    \?\? notes\.txt$'
check "dirty: says it never stashes" out_has 'never stashes, resets or merges'
check "dirty: no pull" test "$(head_of "$R")" = "$before"
check "dirty: no stash made" test -z "$(git -C "$R" stash list)"
check "dirty: changes kept" bash -c 'test -f "$1/notes.txt" && grep -q tweak "$1/VERSION"' _ "$R"
check "dirty: install.sh not run" calls_lacks '^install\.sh'

upd_case upd-branch
git -C "$R" switch -q -c feature
run_motherapp install
check "not main: exit 1" exit_is 1
check "not main: refuses and names the branch" out_has "refusing: the checkout is on branch 'feature', not main"
check "not main: install.sh not run" calls_lacks '^install\.sh'
git -C "$R" switch -q --detach main
run_motherapp install
check "detached HEAD: refuses" out_has 'refusing: HEAD is detached'

upd_case upd-diverged
echo local >"$R/local.txt"
git_commit_all "$R" "local commit"
seed_commit "remote commit"
before="$(head_of "$R")"
run_motherapp install
check "diverged: exit 1" exit_is 1
check "diverged: refuses with the counts" out_has 'refusing: main and origin/main have diverged \(1 local and 1 remote commit\(s\)\)'
check "diverged: HEAD unchanged" test "$(head_of "$R")" = "$before"
check "diverged: no merge commit" test "$(git -C "$R" rev-list --count HEAD)" = 2
check "diverged: install.sh not run" calls_lacks '^install\.sh'

upd_case upd-ahead
echo local >"$R/local.txt"
git_commit_all "$R" "local commit"
(cd "$R" && FAKE="$FAKE" bash install.sh >/dev/null)
: >"$FAKE/calls"
run_motherapp install
check "only ahead: not refused, up to date" out_has '^already up to date'
check "only ahead: mentions the unpushed commit" out_has 'main has 1 local commit\(s\) that aren.t on origin yet'

upd_case upd-status
seed_commit "new thing"
git -C "$R" pull -q --ff-only origin main 2>/dev/null   # pulled by hand, not installed
H2="$(git -C "$R" rev-parse --short=7 HEAD)"
run_motherapp status
check "status, core down: built vs checkout" out_has "^built v${V}-$H1, checkout is at v${V}-$H2, run \`motherapp install\`\$"
cat >"$FAKE/api_status" <<EOF
{"version":{"running":{"version":"${V}","hash":"$H1","dirty":false,"builtAt":"2026-10-20T10:00:00Z","string":"v${V}-$H1"},"checkout":{},"status":"behind"},
 "tools":[{"id":"audio","title":"Audio","enabled":true,"status":"running"},
          {"id":"brightness","title":"Brightness","enabled":true,"status":"failed","statusText":"5 crashes in 2 min"},
          {"id":"demo","title":"Demo","enabled":false,"status":"stopped"}]}
EOF
run_motherapp status
check "status, core up: running version" out_has "^running +v${V}-$H1\$"
check "status, core up: the behind message" out_has "^running v${V}-$H1, checkout is at v${V}-$H2, run \`motherapp install\`\$"
check "status: the checkout line" out_has "^checkout +v${V}-$H2 "
check "status: a running tool" out_has '^  audio +running$'
check "status: a crashed tool, with why" out_has '^  brightness +failed \(5 crashes in 2 min\)$'
check "status: a disabled tool" out_has '^  demo +disabled$'
check "status: asked the core for a fresh checkout" calls_has "api/status?refresh=1"
check "status: exit 0 while active" exit_is 0
git -C "$R" reset -q --hard "$H1"   # back where the running build is
run_motherapp status
check "status, current: no behind message" out_lacks 'run `motherapp install`'
rm "$FAKE/active/motherapp.service" "$FAKE/api_status"
run_motherapp status
check "status, stopped: says so" out_has '^service +inactive'
check "status, stopped: not running" out_has '^running +not running$'
check "status, stopped: exit 1" exit_is 1

upd_case upd-misc
run_motherapp version
check "version: the built version" test "$(cat "$OUT")" = "motherapp v${V}-$H1"
run_motherapp --version
check "--version" test "$(cat "$OUT")" = "motherapp v${V}-$H1"
rm "$R/build-info.json"
run_motherapp version
check "version without a build: v?-unknown" out_has '^motherapp v\?-unknown \(no build-info\.json'
check "version without a build: exit 0" exit_is 0
run_motherapp help
check "help: exit 0" exit_is 0
check "help: lists install/update" out_has '^  install, update '
check "help: no doctor" out_lacks doctor
run_motherapp
check "no command: help" out_has '^Usage: motherapp <command>'
run_motherapp bogus
check "unknown command: exit 2" exit_is 2
run_motherapp check
check "check runs install.sh --check" calls_has "install.sh --check"
run_motherapp uninstall --purge
check "uninstall passes options on" calls_has "install.sh --uninstall --purge"
run_motherapp logs
check "logs: journalctl -f -o cat" calls_has "journalctl --user -u motherapp -f -o cat"
mkdir -p "$HOME_/.config/motherapp"
echo '{ "port": 7999 }' >"$HOME_/.config/motherapp/config.json"
stub xdg-open 'echo "xdg-open $*" >>"$FAKE/calls"'
run_motherapp open
check "open: the config.json port" calls_has "xdg-open http://127.0.0.1:7999/"

printf '\n%d passed, %d failed\n' "$PASSED" "$FAILED"
(( FAILED == 0 ))
