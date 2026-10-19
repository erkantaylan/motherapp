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

PASSED=0 FAILED=0 CASE="" C="" OUT="" CODE=0

# Real utilities the installer (and the stubs) may use; nothing else from the host is on PATH.
SYSBIN="$TMP/sysbin"
mkdir -p "$SYSBIN"
for t in bash sh env cat cp mv rm mkdir rmdir ls ln chmod touch readlink dirname basename head \
  tail tr cut sort uniq wc grep sed awk sleep install mktemp diff cmp uname find tee date printf; do
  p="$(command -v "$t")" && [[ $p == /* ]] && ln -s "$p" "$SYSBIN/$t"
done

# ------------------------------------------------------------------ fake machine

stub() { # name body  (body gets "$@"; FAKE, FAKE_STUB and MOTHERAPP_INSTALL_ROOT are exported)
  printf '#!/usr/bin/env bash\n%s\n' "$2" >"$STUB/$1"
  chmod +x "$STUB/$1"
}

make_node() { # dir version
  mkdir -p "$1"
  printf '#!/usr/bin/env bash\n[[ ${1:-} == --version ]] && echo %s\nexit 0\n' "$2" >"$1/node"
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
  mkdir -p "$R/packaging" "$HOME_" "$ROOT" "$FAKE"/{apt,dpkg,active,enabled} "$STUB"
  cp "$REPO/install.sh" "$R/"
  cp "$REPO/packaging/motherapp.service" "$R/packaging/"
  : >"$FAKE/calls"
  NODE_PATH_DIR="$C/node24/bin"
  make_node "$NODE_PATH_DIR" v24.1.0
  EXTRA_ENV=()

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

  stub sudo 'echo "sudo $*" >>"$FAKE/calls"; exec "$@"'
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
  stub apt-get 'echo "apt-get $*" >>"$FAKE/calls"
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
    nodejs) mkdir -p "$R/usr/bin"; printf "#!/bin/sh\n[ \"\$1\" = --version ] && echo v24.1.0\n" >"$R/usr/bin/node"; cp "$FAKE/npm_template" "$R/usr/bin/npm"; chmod +x "$R/usr/bin/node" "$R/usr/bin/npm" ;;
  esac
done'
  cp "$NODE_PATH_DIR/npm" "$FAKE/npm_template"
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
  stub curl 'url="${*: -1}"; echo "curl $url" >>"$FAKE/calls"
case $url in
  *nodesource*) echo FAKE-KEY ;;
  http://127.0.0.1:*) [[ -f $FAKE/http_up ]] || exit 7 ;;
esac'
  stub journalctl 'echo "fake journal line"'
}

# run_installer [args...]  (stdin is passed through; default </dev/null)
run_installer() {
  local path="$STUB:$SYSBIN"
  [[ -n $NODE_PATH_DIR ]] && path="$NODE_PATH_DIR:$path"
  OUT="$C/out.$(date +%s%N)"
  (cd "$C" && "$ENV_BIN" -i HOME="$HOME_" PATH="$path" FAKE="$FAKE" FAKE_STUB="$STUB" \
    MOTHERAPP_INSTALL_ROOT="$ROOT" MOTHERAPP_INSTALL_WAIT=1 "${EXTRA_ENV[@]}" \
    bash "$R/install.sh" "$@") >"$OUT" 2>&1
  CODE=$?
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

new_case root-refused
stub id '[[ $1 == -u ]] && echo 0; exit 0'
run_installer --check
check "running as root: exit 2" exit_is 2

printf '\n%d passed, %d failed\n' "$PASSED" "$FAILED"
(( FAILED == 0 ))
