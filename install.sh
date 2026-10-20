#!/usr/bin/env bash
# motherapp installer: checks every dependency, installs the missing ones (asking before
# anything uses sudo/apt) or says how to install them, then builds the app and sets up the
# systemd user service. It also writes a small wrapper in ~/.local/bin for each command a tool
# declares in its manifest ("bin", e.g. audioctl), so tool CLIs work from any terminal and from
# GNOME keyboard shortcuts, plus ~/.local/bin/motherapp (scripts/motherapp.sh: `motherapp
# install` pulls main and re-runs this script, `motherapp status`, ...). It records the version
# it built (v<N>-<hash>[-dirty], scripts/build-info.sh) in build-info.json for the core.
# Target: Ubuntu 24.04, GNOME 46, Wayland. Safe to re-run.
#
#   ./install.sh               interactive: asks y/N before each sudo/apt step and before
#                              enabling the service
#   ./install.sh --check       report only, change nothing
#   ./install.sh --yes         accept every prompt, except an apt install that would remove
#                              packages (add --allow-removals to accept that too)
#   ./install.sh --uninstall   stop + disable the service, remove the unit file and the
#                              ~/.local/bin wrappers this installer wrote, and offer to
#                              remove the GNOME keyboard shortcuts motherapp made (default no)
#                              (add --purge to also delete ~/.config/motherapp and
#                              ~/.local/state/motherapp)
#
# Every status line starts with one of OK / MISSING / WARN / FAIL / SKIP, and the last line
# is "RESULT: ...", so the output is easy to grep. Exit code: 0 when everything required is
# OK, 1 when something required is still missing or failed, 2 on a usage error.
#
# Test hooks (used by scripts/test-install.sh, not meant for normal use):
#   MOTHERAPP_INSTALL_ROOT  prefix for system paths (/etc, /sys, /dev, /usr), default empty
#   MOTHERAPP_INSTALL_WAIT  seconds to wait for the HTTP check, default 15

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="${MOTHERAPP_INSTALL_ROOT:-}"
HTTP_WAIT="${MOTHERAPP_INSTALL_WAIT:-15}"
MIN_NODE=24
UNIT_NAME="motherapp.service"
TEMPLATE="$REPO_DIR/packaging/$UNIT_NAME"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"
UNIT_DIR="$CONFIG_HOME/systemd/user"
UNIT_FILE="$UNIT_DIR/$UNIT_NAME"
APP_CONFIG_DIR="$CONFIG_HOME/motherapp"
APP_STATE_DIR="$STATE_HOME/motherapp"
SOUND_DIR="$ROOT/usr/share/sounds/freedesktop/stereo"
TEST_SOUNDS=("$SOUND_DIR/audio-channel-front-left.oga" "$SOUND_DIR/audio-channel-front-right.oga")
NODESOURCE_KEY_URL="https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key"
NODESOURCE_LIST_LINE="deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${MIN_NODE}.x nodistro main"

# Ubuntu 24.04 (noble) package for each PipeWire command. Checked against the noble archive
# (dpkg -c of pipewire-bin 1.0.5-1ubuntu3.3 and wireplumber 0.4.17-1ubuntu4.1); confirmed at
# runtime with apt-cache before anything is installed.
declare -A PW_PKG=(
  [pw-dump]=pipewire-bin [pw-play]=pipewire-bin [pw-record]=pipewire-bin
  [pw-metadata]=pipewire-bin [wpctl]=wireplumber
)
PW_TOOLS=(pw-dump pw-play pw-record pw-metadata wpctl)
# Candidate names for the libddcutil shared library package, newest soname first. Which one
# exists is decided at runtime with apt-cache (noble ships libddcutil4 for ddcutil 1.4.x).
LIBDDCUTIL_CANDIDATES=(libddcutil5 libddcutil4 libddcutil0)
BUILD_INFO_SH="$REPO_DIR/scripts/build-info.sh"
BUILD_INFO="$REPO_DIR/build-info.json"
MOTHERAPP_SH="$REPO_DIR/scripts/motherapp.sh"
# mbi_* version helpers (sourcing defines functions only)
# shellcheck source=scripts/build-info.sh
[[ -r $BUILD_INFO_SH ]] && . "$BUILD_INFO_SH"

# ---------------------------------------------------------------- options

MODE=install
YES=0
PURGE=0
ALLOW_REMOVALS=0

usage() {
  cat <<'EOF'
Usage: ./install.sh [--check | --uninstall [--purge]] [--yes [--allow-removals]]

  (no option)   Check dependencies, offer to install missing ones (asks before every
                sudo/apt step), run npm ci + npm run build, write the systemd user unit,
                ask before enabling it, then check http://127.0.0.1:7323/. Writes a
                wrapper in ~/.local/bin for each tool command (e.g. audioctl) and for
                the motherapp command (motherapp install/update pulls main and re-runs
                this; motherapp help lists the rest).
                Node 24: offers nvm/fnm first when you have one (no sudo), then the
                NodeSource apt repo, showing first what that install would remove.
  --check       Only report status. Changes nothing, asks nothing.
  --yes, -y     Answer yes to every prompt, except an apt install that would remove
                packages (e.g. NodeSource nodejs replacing Ubuntu's nodejs removes npm
                and the node-* packages): --yes stops there.
  --allow-removals
                With --yes: also accept an install that removes packages.
  --uninstall   Stop and disable the service, remove ~/.config/systemd/user/motherapp.service
                and the ~/.local/bin wrappers written by this installer. Asks whether to
                remove the GNOME keyboard shortcuts motherapp made (default no; --yes
                removes them). Shortcuts made elsewhere are never touched.
                Keeps ~/.config/motherapp and ~/.local/state/motherapp.
  --purge       With --uninstall: also delete those two directories.
  --help, -h    This text.

Environment: MOTHERAPP_PORT (listen port; written into the unit when set at install time).
Exit code: 0 = everything required is OK, 1 = something required is missing or failed.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --check) MODE=check ;;
    --uninstall) MODE=uninstall ;;
    --purge) PURGE=1 ;;
    --yes | -y) YES=1 ;;
    --allow-removals) ALLOW_REMOVALS=1 ;;
    --help | -h) usage; exit 0 ;;
    *) echo "install.sh: unknown option: $arg" >&2; usage >&2; exit 2 ;;
  esac
done
if (( PURGE )) && [[ $MODE != uninstall ]]; then
  echo "install.sh: --purge only works together with --uninstall" >&2
  exit 2
fi

# ---------------------------------------------------------------- output

if [[ -t 1 ]]; then
  C_RESET=$'\e[0m' C_BOLD=$'\e[1m' C_GREEN=$'\e[32m' C_RED=$'\e[31m' C_YELLOW=$'\e[33m' C_DIM=$'\e[2m'
else
  C_RESET='' C_BOLD='' C_GREEN='' C_RED='' C_YELLOW='' C_DIM=''
fi

R_STATUS=() R_NAME=() R_DETAIL=() R_FIX=() R_REQ=()

section() { printf '\n%s==> %s%s\n' "$C_BOLD" "$1" "$C_RESET"; }
info() { printf '    %s\n' "$*"; }
cmdline() { printf '    %s+ %s%s\n' "$C_DIM" "$*" "$C_RESET"; }

status_colour() {
  case "$1" in
    OK) printf '%s' "$C_GREEN" ;;
    MISSING | FAIL) printf '%s' "$C_RED" ;;
    *) printf '%s' "$C_YELLOW" ;;
  esac
}

print_row() { # status name detail fix
  printf '%s%-8s%s %-20s %s\n' "$(status_colour "$1")" "$1" "$C_RESET" "$2" "$3"
  if [[ -n $4 ]]; then
    while IFS= read -r line; do printf '         %-20s %sfix: %s%s\n' "" "$C_DIM" "$line" "$C_RESET"; done <<<"$4"
  fi
}

# record STATUS NAME DETAIL [FIX] [REQUIRED=1]
record() {
  R_STATUS+=("$1") R_NAME+=("$2") R_DETAIL+=("$3") R_FIX+=("${4:-}") R_REQ+=("${5:-1}")
  print_row "$1" "$2" "$3" "${4:-}"
}

reset_records() { R_STATUS=() R_NAME=() R_DETAIL=() R_FIX=() R_REQ=(); }

# ask QUESTION -> 0 for yes. --yes answers yes; no answer (closed stdin) counts as no.
ask() {
  if (( YES )); then
    printf '%s?%s %s [y/N] y (--yes)\n' "$C_BOLD" "$C_RESET" "$1"
    return 0
  fi
  printf '%s?%s %s [y/N] ' "$C_BOLD" "$C_RESET" "$1"
  local answer=""
  if ! IFS= read -r answer; then
    printf '\n'
    info "no answer (stdin closed), treating it as no"
    return 1
  fi
  [[ $answer =~ ^[Yy]([Ee][Ss])?$ ]]
}

run() { cmdline "$*"; "$@"; }
run_sudo() { cmdline "sudo $*"; sudo "$@"; }

have() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------- package helpers

# apt candidate version of a package, empty if apt doesn't know it.
apt_candidate() {
  have apt-cache || return 0
  apt-cache policy "$1" 2>/dev/null | awk '/^[[:space:]]*Candidate:/ { if ($2 != "(none)") print $2; exit }'
}

# Installed version of a package, empty if not installed.
dpkg_installed() {
  have dpkg-query || return 0
  local out
  out="$(dpkg-query -W -f='${db:Status-Status} ${Version}\n' "$1" 2>/dev/null)" || return 0
  [[ $out == installed\ * ]] && printf '%s\n' "${out#installed }"
  return 0
}

# Name of the libddcutil shared-library package in this apt archive. Prefers an installed
# one, then the one built from the same source version as the installed ddcutil.
LIBDDCUTIL_PKG=""
find_libddcutil_pkg() {
  local pkg ddc_ver cand first=""
  for pkg in "${LIBDDCUTIL_CANDIDATES[@]}"; do
    if [[ -n $(dpkg_installed "$pkg") ]]; then LIBDDCUTIL_PKG=$pkg; return; fi
  done
  ddc_ver="$(dpkg_installed ddcutil)"
  for pkg in "${LIBDDCUTIL_CANDIDATES[@]}"; do
    cand="$(apt_candidate "$pkg")"
    [[ -z $cand ]] && continue
    [[ -z $first ]] && first=$pkg
    if [[ -n $ddc_ver && $cand == "$ddc_ver" ]]; then LIBDDCUTIL_PKG=$pkg; return; fi
  done
  LIBDDCUTIL_PKG=$first
}

# ---------------------------------------------------------------- Node

NODE_BIN=""        # chosen Node >= 24 (absolute, symlinks resolved)
NODE_VERSION=""
PATH_NODE=""       # what `node` on PATH is
PATH_NODE_VERSION=""

node_major() { local v="${1#v}"; printf '%s' "${v%%.*}"; }

node_version_of() { "$1" --version 2>/dev/null | head -n1; }

node_candidates() {
  local p
  type -ap node 2>/dev/null
  for p in "$ROOT/usr/bin/node" "$ROOT/usr/local/bin/node" \
    "$HOME"/.nvm/versions/node/*/bin/node \
    "${FNM_DIR:-$HOME/.local/share/fnm}"/node-versions/*/installation/bin/node \
    "$HOME"/.fnm/node-versions/*/installation/bin/node; do
    [[ -x $p ]] && printf '%s\n' "$p"
  done
}

find_node() {
  NODE_BIN="" NODE_VERSION="" PATH_NODE="" PATH_NODE_VERSION=""
  if have node; then
    PATH_NODE="$(command -v node)"
    PATH_NODE_VERSION="$(node_version_of "$PATH_NODE")"
  fi
  local c real ver major best_major=0
  declare -A seen=()
  while IFS= read -r c; do
    [[ -z $c ]] && continue
    real="$(readlink -f -- "$c" 2>/dev/null || printf '%s' "$c")"
    [[ -n ${seen[$real]:-} ]] && continue
    seen[$real]=1
    ver="$(node_version_of "$real")"
    [[ $ver =~ ^v[0-9]+\. ]] || continue
    major="$(node_major "$ver")"
    if (( major >= MIN_NODE && major > best_major )); then
      best_major=$major NODE_BIN=$real NODE_VERSION=$ver
    fi
  done < <(node_candidates)
}

node_origin() { # where a node binary came from, for the report
  local real pkg
  real="$(readlink -f -- "$1" 2>/dev/null || printf '%s' "$1")"
  if have dpkg-query && pkg="$(dpkg-query -S "$real" 2>/dev/null | head -n1)" && [[ -n $pkg ]]; then
    printf 'dpkg package %s' "${pkg%%:*}"
  elif [[ $real == *"/.nvm/"* ]]; then printf 'nvm'
  elif [[ $real == *"/fnm/"* || $real == *"/.fnm/"* ]]; then printf 'fnm'
  elif [[ $real == */snap/* ]]; then printf 'snap'
  else printf 'not from a dpkg package (manual install?)'
  fi
}

NODE_FIX_TEXT="Option A (no sudo, removes nothing; offered when nvm is installed): nvm install ${MIN_NODE}
  (no nvm yet: see https://github.com/nvm-sh/nvm#installing-and-updating)
Option B (no sudo, removes nothing; offered when fnm is installed): fnm install ${MIN_NODE}
  (no fnm yet: curl -fsSL https://fnm.vercel.app/install | bash)
  With A or B the unit and the ~/.local/bin wrappers use that version's path: re-run ./install.sh after upgrading or removing it.
Option C (sudo, offered): NodeSource apt repo for Node ${MIN_NODE}:
  sudo install -d -m 0755 /etc/apt/keyrings
  curl -fsSL $NODESOURCE_KEY_URL | sudo gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo '$NODESOURCE_LIST_LINE' | sudo tee /etc/apt/sources.list.d/nodesource.list
  sudo apt-get update && apt-get -s install nodejs | grep ^Remv   (what it would remove: with Ubuntu's nodejs installed, npm and every node-* package)
  sudo apt-get install nodejs
Then re-run ./install.sh (it also finds Node under ~/.nvm and ~/.local/share/fnm)."

# ---------------------------------------------------------------- checks

NEED_NODE=0
NEED_PKGS=()
NEED_I2C_LOAD=0
NEED_I2C_PERSIST=0
NEED_USERMOD=0
USER_NAME=""

add_pkg() {
  local p
  for p in "${NEED_PKGS[@]}"; do [[ $p == "$1" ]] && return; done
  NEED_PKGS+=("$1")
}

apt_fix() { # package -> fix text, confirming apt knows the package
  local cand
  cand="$(apt_candidate "$1")"
  if [[ -n $cand ]]; then
    printf 'sudo apt-get install %s   (apt candidate %s)' "$1" "$cand"
  elif have apt-cache; then
    printf 'sudo apt-get install %s   (apt-cache has no candidate: run sudo apt-get update; it is in noble universe/main)' "$1"
  else
    printf 'install the package that provides it (Ubuntu: %s)' "$1"
  fi
}

check_node() {
  find_node
  if [[ -n $NODE_BIN ]]; then
    record OK node "$NODE_VERSION at $NODE_BIN"
    if [[ -n $NODE_BIN && -n $PATH_NODE && "$(readlink -f -- "$PATH_NODE")" != "$NODE_BIN" ]]; then
      record WARN node-on-path "\`node\` on PATH is ${PATH_NODE_VERSION:-unknown} at $PATH_NODE ($(node_origin "$PATH_NODE")), shadowing $NODE_BIN" \
        "harmless for the service (the unit uses $NODE_BIN by absolute path); for your shell, remove the old one or put $(dirname "$NODE_BIN") first on PATH" 0
    elif [[ -z $PATH_NODE ]]; then
      record WARN node-on-path "no \`node\` on PATH; the service uses $NODE_BIN directly" \
        "add $(dirname "$NODE_BIN") to PATH for npm scripts in your shell" 0
    fi
    if [[ ! -x "$(dirname "$NODE_BIN")/npm" ]]; then
      record MISSING npm "no npm next to $NODE_BIN" "npm ships with Node; reinstall Node ${MIN_NODE} (NodeSource nodejs, fnm or nvm include it)"
      NEED_NODE=1
    fi
  else
    local found="none found"
    [[ -n $PATH_NODE ]] && found="found ${PATH_NODE_VERSION:-unknown version} at $PATH_NODE ($(node_origin "$PATH_NODE"))"
    record MISSING node "need Node >= ${MIN_NODE}; $found" "$NODE_FIX_TEXT"
    NEED_NODE=1
  fi
}

check_pipewire_tools() {
  local t pkg
  for t in "${PW_TOOLS[@]}"; do
    pkg="${PW_PKG[$t]}"
    if have "$t"; then
      record OK "$t" "$(command -v "$t")"
    else
      record MISSING "$t" "not on PATH (Ubuntu package: $pkg)" "$(apt_fix "$pkg")"
      add_pkg "$pkg"
    fi
  done
}

check_sounds() {
  local f missing=()
  for f in "${TEST_SOUNDS[@]}"; do [[ -f $f ]] || missing+=("$f"); done
  if (( ${#missing[@]} == 0 )); then
    record OK sound-theme "L/R test sounds in $SOUND_DIR"
  else
    record MISSING sound-theme "missing ${missing[*]}" "$(apt_fix sound-theme-freedesktop)"
    add_pkg sound-theme-freedesktop
  fi
}

check_audio_services() {
  local s st
  if ! have systemctl; then
    record WARN audio-services "systemctl not found, can't check pipewire/wireplumber" "" 0
    return
  fi
  for s in pipewire wireplumber pipewire-pulse; do
    st="$(systemctl --user is-active "$s" 2>/dev/null)"
    if [[ $st == active ]]; then
      record OK "$s" "user service active"
    else
      record WARN "$s" "user service is ${st:-unknown}" "systemctl --user enable --now $s   (normally started by the desktop session)" 0
    fi
  done
}

check_ddcutil() {
  if have ddcutil; then
    record OK ddcutil "$(ddcutil --version 2>/dev/null | head -n1)"
  else
    record MISSING ddcutil "not on PATH" "$(apt_fix ddcutil)"
    add_pkg ddcutil
  fi
}

check_libddcutil() {
  find_libddcutil_pkg
  local libs=() f
  for f in "$ROOT"/usr/lib/*/libddcutil.so.* "$ROOT"/usr/lib/libddcutil.so.*; do
    [[ -e $f ]] && libs+=("$f")
  done
  local installed=""
  [[ -n $LIBDDCUTIL_PKG ]] && installed="$(dpkg_installed "$LIBDDCUTIL_PKG")"
  if [[ -n $installed ]]; then
    record OK libddcutil "$LIBDDCUTIL_PKG $installed${libs:+ (${libs[0]})}"
  elif (( ${#libs[@]} > 0 )); then
    record OK libddcutil "${libs[0]} (not from a dpkg package)"
  elif [[ -n $LIBDDCUTIL_PKG ]]; then
    record MISSING libddcutil "shared library not installed (package: $LIBDDCUTIL_PKG)" "$(apt_fix "$LIBDDCUTIL_PKG")"
    add_pkg "$LIBDDCUTIL_PKG"
  else
    record MISSING libddcutil "shared library not installed, and apt knows none of: ${LIBDDCUTIL_CANDIDATES[*]}" \
      "sudo apt-get update, then re-run; on Ubuntu 24.04 the package is libddcutil4 (universe)"
  fi
}

i2c_persistent() {
  local f
  for f in "$ROOT"/etc/modules-load.d/*.conf "$ROOT"/usr/lib/modules-load.d/*.conf "$ROOT"/etc/modules; do
    [[ -f $f ]] && grep -qE '^[[:space:]]*i2c[-_]dev([[:space:]]|$)' "$f" && return 0
  done
  return 1
}

i2c_builtin() {
  local f
  f="$ROOT/lib/modules/$(uname -r 2>/dev/null)/modules.builtin"
  [[ -f $f ]] && grep -q '/i2c-dev\.ko' "$f"
}

check_i2c() {
  if i2c_builtin; then
    record OK i2c-dev "built into the kernel"
  elif [[ -d $ROOT/sys/module/i2c_dev ]]; then
    if i2c_persistent; then
      record OK i2c-dev "module loaded, loaded at boot"
    else
      record WARN i2c-dev "module loaded now, but nothing loads it at boot" \
        "echo i2c-dev | sudo tee /etc/modules-load.d/i2c-dev.conf" 0
      NEED_I2C_PERSIST=1
    fi
  else
    record MISSING i2c-dev "kernel module not loaded" \
      "sudo modprobe i2c-dev && echo i2c-dev | sudo tee /etc/modules-load.d/i2c-dev.conf"
    NEED_I2C_LOAD=1
    i2c_persistent || NEED_I2C_PERSIST=1
  fi

  local devs=("$ROOT"/dev/i2c-*)
  if [[ -e ${devs[0]} ]]; then
    local names="" d noaccess=()
    for d in "${devs[@]}"; do
      names+="${d##*/} "
      [[ -r $d && -w $d ]] || noaccess+=("${d##*/}")
    done
    record OK i2c-devices "${#devs[@]}: ${names% }"
    if (( ${#noaccess[@]} > 0 )); then
      record WARN i2c-access "this session can't read/write ${noaccess[*]} (fine for buses that aren't monitors)" \
        "be in the i2c group (log out and in after usermod); ddcutil's udev rule also grants the desktop user access to GPU buses" 0
    fi
  else
    record MISSING i2c-devices "no $ROOT/dev/i2c-*" "load i2c-dev (see above); the monitors are on /dev/i2c-1 and /dev/i2c-3"
  fi

  USER_NAME="$(id -un 2>/dev/null)"
  if ! getent group i2c >/dev/null 2>&1; then
    record MISSING i2c-group "group i2c doesn't exist" \
      "it is created by i2c-tools, which ddcutil depends on: $(apt_fix i2c-tools)"
    add_pkg i2c-tools
    return
  fi
  local db_groups session_groups
  db_groups=" $(id -nG "$USER_NAME" 2>/dev/null) "
  session_groups=" $(id -nG 2>/dev/null) "
  if [[ $db_groups == *" i2c "* ]]; then
    if [[ $session_groups == *" i2c "* ]]; then
      record OK i2c-group "$USER_NAME is in group i2c"
    else
      record WARN i2c-group "$USER_NAME was added to i2c, but this login session predates it" \
        "log out and back in (or reboot) so the group applies" 0
    fi
  else
    record MISSING i2c-group "$USER_NAME is not in group i2c" \
      "sudo usermod -aG i2c $USER_NAME   (then log out and back in)"
    NEED_USERMOD=1
  fi
}

check_systemd_user() {
  if have systemctl && systemctl --user show-environment >/dev/null 2>&1; then
    record OK systemd-user "user manager reachable"
  else
    record MISSING systemd-user "systemctl --user doesn't work here" \
      "run the installer from your desktop session (a terminal in GNOME), not via sudo/su or a bare ssh shell"
  fi
}

check_misc_tools() {
  if have curl; then
    record OK curl "$(command -v curl)"
  else
    record WARN curl "not installed; needed for the NodeSource key and the final HTTP check" "$(apt_fix curl)" 0
  fi
}

run_checks() {
  NEED_NODE=0 NEED_PKGS=() NEED_I2C_LOAD=0 NEED_I2C_PERSIST=0 NEED_USERMOD=0
  section "Runtime"
  check_node
  check_misc_tools
  section "Audio (PipeWire)"
  check_pipewire_tools
  check_sounds
  check_audio_services
  section "Brightness (DDC/CI)"
  check_ddcutil
  check_libddcutil
  check_i2c
  section "Service manager"
  check_systemd_user
}

# ---------------------------------------------------------------- fixes (sudo, asked)

APPLIED_FIX=0

# --- Node 24 from a version manager (no sudo, removes nothing)

NVM_SH="${NVM_DIR:-$HOME/.nvm}/nvm.sh"

fnm_bin() { # path of fnm, if installed
  local d="${FNM_DIR:-$HOME/.local/share/fnm}"
  if have fnm; then command -v fnm
  elif [[ -x $d/fnm ]]; then printf '%s\n' "$d/fnm"
  else return 1
  fi
}

# True when the chosen Node lives in a version manager's per-version directory.
node_is_versioned() { [[ $NODE_BIN == *"/.nvm/"* || $NODE_BIN == *"/fnm/"* || $NODE_BIN == *"/.fnm/"* ]]; }

versioned_note() { # manager dir
  printf 'the systemd unit and the ~/.local/bin wrappers will then run Node by its version-specific path under %s (.../v%s.x.y/.../bin/node), so re-run ./install.sh after you upgrade or remove that Node version' \
    "$1" "$MIN_NODE"
}

# Offers `nvm install 24`, then `fnm install 24`, for whichever is installed. Returns 0 once
# one of them installed Node, 1 when none is installed, all were declined or they failed.
offer_version_managers() {
  local fnm
  if [[ -s $NVM_SH ]]; then
    info "nvm is installed ($NVM_SH). It installs Node ${MIN_NODE} without sudo and removes nothing."
    info "Note: $(versioned_note "${NVM_SH%/nvm.sh}")."
    if ask "Run: nvm install ${MIN_NODE} (no sudo)"; then
      cmdline "bash -c '. $NVM_SH --no-use; nvm install ${MIN_NODE}'"
      # nvm is a shell function: load it in a clean bash, without our set -u/pipefail.
      if bash -c '. "$1" --no-use; nvm install "$2"' _ "$NVM_SH" "$MIN_NODE" </dev/null; then return 0; fi
      info "nvm install failed (see above)"
    else
      info "skipped nvm"
    fi
  fi
  if fnm="$(fnm_bin)"; then
    info "fnm is installed ($fnm). It installs Node ${MIN_NODE} without sudo and removes nothing."
    info "Note: $(versioned_note "${FNM_DIR:-$HOME/.local/share/fnm}")."
    if ask "Run: fnm install ${MIN_NODE} (no sudo)"; then
      if run "$fnm" install "$MIN_NODE" </dev/null; then return 0; fi
      info "fnm install failed (see above)"
    else
      info "skipped fnm"
    fi
  fi
  return 1
}

# --- Node 24 from NodeSource (sudo; may replace Ubuntu's nodejs)

nodesource_configured() {
  local f="$ROOT/etc/apt/sources.list.d/nodesource.list"
  [[ -f $f ]] && grep -qxF -- "$NODESOURCE_LIST_LINE" "$f"
}

add_nodesource_repo() {
  if ! have curl; then
    info "curl is missing; install it first: sudo apt-get install curl"
    return 1
  fi
  run_sudo install -d -m 0755 "$ROOT/etc/apt/keyrings" &&
    { cmdline "curl -fsSL $NODESOURCE_KEY_URL | sudo gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg"
      curl -fsSL "$NODESOURCE_KEY_URL" | sudo gpg --dearmor --yes -o "$ROOT/etc/apt/keyrings/nodesource.gpg"; } &&
    { cmdline "echo '$NODESOURCE_LIST_LINE' | sudo tee /etc/apt/sources.list.d/nodesource.list"
      printf '%s\n' "$NODESOURCE_LIST_LINE" | sudo tee "$ROOT/etc/apt/sources.list.d/nodesource.list" >/dev/null; } &&
    run_sudo apt-get update
}

# Simulates `apt-get install PKG` (no sudo, changes nothing). Sets SIM_REMOVALS (packages apt
# would remove) and SIM_NEW (the PKG version it would install).
SIM_REMOVALS=() SIM_NEW=""
simulate_install() {
  local out
  SIM_REMOVALS=() SIM_NEW=""
  cmdline "apt-get -s install $1   (simulation: changes nothing)"
  if ! out="$(LC_ALL=C apt-get -s install "$1" 2>&1)"; then
    printf '%s\n' "$out" | sed 's/^/      /'
    return 1
  fi
  mapfile -t SIM_REMOVALS < <(awk '$1 == "Remv" { print $2 }' <<<"$out")
  SIM_NEW="$(awk -v p="$1" '$1 == "Inst" && $2 == p { for (i = 3; i <= NF; i++) if ($i ~ /^\(/) { sub(/^\(/, "", $i); print $i; exit } }' <<<"$out")"
}
simulate_nodejs() { simulate_install nodejs; }

info_wrapped() { # words... -> indented lines of at most ~90 characters
  local line="" w
  for w in "$@"; do
    if [[ -n $line ]] && (( ${#line} + ${#w} + 1 > 84 )); then info "  $line"; line=""; fi
    line+="${line:+ }$w"
  done
  [[ -n $line ]] && info "  $line"
}

node_manual_hint() {
  info "Without sudo, use nvm or fnm (they remove nothing):"
  info "  nvm: https://github.com/nvm-sh/nvm  then: nvm install ${MIN_NODE}"
  info "  fnm: curl -fsSL https://fnm.vercel.app/install | bash  then: fnm install ${MIN_NODE}"
  info "then re-run ./install.sh"
}

offer_nodesource() {
  if ! have apt-get || ! have sudo; then
    info "apt-get/sudo not available."
    node_manual_hint
    return 1
  fi
  if nodesource_configured; then
    info "the NodeSource apt repo for Node ${MIN_NODE} is already configured"
  elif ask "NodeSource, step 1 of 2: add its apt repo for Node ${MIN_NODE} (sudo: writes /etc/apt/keyrings/nodesource.gpg and /etc/apt/sources.list.d/nodesource.list, runs apt-get update). This installs and removes nothing; step 2 first shows what installing nodejs would change"; then
    if ! add_nodesource_repo; then info "adding the NodeSource repo failed (see above)"; return 1; fi
  else
    info "skipped."
    node_manual_hint
    return 1
  fi

  if ! simulate_nodejs; then
    info "apt-get -s install nodejs failed (see above); not installing. Check it yourself, then: sudo apt-get install nodejs"
    return 1
  fi
  local old new n=${#SIM_REMOVALS[@]} undo
  old="$(dpkg_installed nodejs)"
  new="nodejs ${SIM_NEW:-from NodeSource}"
  undo="the NodeSource repo stays configured (to undo: sudo rm /etc/apt/sources.list.d/nodesource.list /etc/apt/keyrings/nodesource.gpg && sudo apt-get update)"
  if (( n == 0 )); then
    if ask "NodeSource, step 2 of 2: sudo apt-get install nodejs (installs $new${old:+, replacing nodejs $old}; removes nothing)"; then
      run_sudo apt-get install -y nodejs
      return
    fi
    info "skipped; $undo"
    return 1
  fi

  local whose="the installed nodejs${old:+ $old}" preview=("${SIM_REMOVALS[@]:0:8}") list
  [[ -n $old && $old != *nodesource* ]] && whose="Ubuntu's nodejs $old"
  list="$(printf '%s, ' "${preview[@]}")"
  list="${list%, }"
  (( n > ${#preview[@]} )) && list+=", ..."
  info "${C_RED}Installing $new replaces $whose and REMOVES $n package(s): $list${C_RESET}"
  info "(full list below; they depend on Ubuntu's nodejs build, e.g. npm, eslint, node-gyp, libnode-dev)"
  info_wrapped "${SIM_REMOVALS[@]}"
  info "To keep them, say no and install Node ${MIN_NODE} with nvm or fnm instead (no sudo)."
  if (( YES && ! ALLOW_REMOVALS )); then
    info "not installing: --yes doesn't cover an install that removes packages."
    info "Re-run with --yes --allow-removals to accept it, or without --yes to answer yourself."
    info "$undo"
    return 1
  fi
  local q="NodeSource, step 2 of 2: sudo apt-get install nodejs, which REMOVES the $n package(s) listed above"
  if (( YES )); then
    printf '%s?%s %s [y/N] y (--yes --allow-removals)\n' "$C_BOLD" "$C_RESET" "$q"
    run_sudo apt-get install -y nodejs
    return
  fi
  if ask "$q (apt shows the list again and asks once more)"; then
    run_sudo apt-get install nodejs
    return
  fi
  info "skipped; nothing was removed. $undo"
  return 1
}

offer_node() {
  section "Install Node ${MIN_NODE}"
  if offer_version_managers; then APPLIED_FIX=1; return; fi
  if offer_nodesource; then APPLIED_FIX=1; fi
}

offer_fixes() {
  local can_apt=1
  have apt-get && have sudo || can_apt=0

  if (( ${#NEED_PKGS[@]} > 0 )); then
    section "Install missing packages"
    if (( can_apt )); then
      if ask "Run: sudo apt-get install -y ${NEED_PKGS[*]}"; then
        if run_sudo apt-get install -y "${NEED_PKGS[@]}"; then APPLIED_FIX=1; else info "apt-get failed (see above)"; fi
      else
        info "skipped; install them yourself: sudo apt-get install ${NEED_PKGS[*]}"
      fi
    else
      info "apt-get/sudo not available; install: ${NEED_PKGS[*]}"
    fi
  fi

  (( NEED_NODE )) && offer_node

  if (( NEED_I2C_LOAD || NEED_I2C_PERSIST )); then
    section "i2c-dev kernel module"
    local what="write /etc/modules-load.d/i2c-dev.conf so it loads at boot"
    (( NEED_I2C_LOAD )) && what="sudo modprobe i2c-dev now and $what"
    if (( can_apt )) && ask "$what"; then
      local ok=1
      if (( NEED_I2C_LOAD )); then run_sudo modprobe i2c-dev || ok=0; fi
      if (( NEED_I2C_PERSIST )); then
        cmdline "echo i2c-dev | sudo tee /etc/modules-load.d/i2c-dev.conf"
        { sudo install -d -m 0755 "$ROOT/etc/modules-load.d" &&
          printf 'i2c-dev\n' | sudo tee "$ROOT/etc/modules-load.d/i2c-dev.conf" >/dev/null; } || ok=0
      fi
      (( ok )) && APPLIED_FIX=1
    else
      info "skipped"
    fi
  fi

  if (( NEED_USERMOD )); then
    section "i2c group"
    if (( can_apt )) && ask "Run: sudo usermod -aG i2c $USER_NAME (takes effect after you log out and back in)"; then
      if run_sudo usermod -aG i2c "$USER_NAME"; then APPLIED_FIX=1; fi
    else
      info "skipped"
    fi
  fi
}

# ---------------------------------------------------------------- app setup

PORT=7323
PORT_FROM_ENV=0

resolve_port() {
  if [[ -n ${MOTHERAPP_PORT:-} ]]; then
    if [[ $MOTHERAPP_PORT =~ ^[0-9]+$ ]] && (( MOTHERAPP_PORT > 0 && MOTHERAPP_PORT < 65536 )); then
      PORT=$MOTHERAPP_PORT PORT_FROM_ENV=1
      return
    fi
    echo "install.sh: MOTHERAPP_PORT must be a port number, got: $MOTHERAPP_PORT" >&2
    exit 2
  fi
  local cfg="$APP_CONFIG_DIR/config.json" p
  if [[ -f $cfg ]]; then
    p="$(grep -oE '"port"[[:space:]]*:[[:space:]]*[0-9]+' "$cfg" | head -n1 | grep -oE '[0-9]+$')"
    [[ -n $p ]] && (( p > 0 && p < 65536 )) && PORT=$p
  fi
}

# Prints the unit for the chosen Node and this checkout.
render_unit() {
  local bad='[%"\\$]'
  if [[ $NODE_BIN =~ $bad || $REPO_DIR =~ $bad || $NODE_BIN == *$'\n'* || $REPO_DIR == *$'\n'* ]]; then
    echo "install.sh: paths with %, \", \\, \$ or newlines can't go into a systemd unit: $NODE_BIN / $REPO_DIR" >&2
    return 1
  fi
  local t="" line
  [[ -r $TEMPLATE ]] || return 1
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line == '#@'* ]] || t+="$line"$'\n'
  done <"$TEMPLATE"
  t="${t%$'\n'}"
  t="${t//@NODE@/"$NODE_BIN"}"
  t="${t//@REPO_DIR@/"$REPO_DIR"}"
  if (( PORT_FROM_ENV )); then
    local svc=$'\n[Service]\n'
    t="${t/"$svc"/"${svc}Environment=MOTHERAPP_PORT=$PORT"$'\n'}"
  fi
  printf '%s\n' "$t"
}

npm_run() { # args... run npm from the chosen Node, with that Node first on PATH
  local dir
  dir="$(dirname "$NODE_BIN")"
  cmdline "npm $*"
  (cd "$REPO_DIR" && PATH="$dir:$PATH" "$dir/npm" "$@" </dev/null)
}

http_ok() { curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/" 2>/dev/null; }

wait_http() {
  local i tries=$(( HTTP_WAIT * 2 ))
  (( tries < 1 )) && tries=1
  for (( i = 0; i < tries; i++ )); do
    http_ok && return 0
    (( i + 1 < tries )) && sleep 0.5
  done
  return 1
}

app_setup() {
  section "App setup"
  local blocked=""
  [[ -z $NODE_BIN ]] && blocked="Node >= ${MIN_NODE} missing"
  [[ -z $blocked && ! -x "$(dirname "$NODE_BIN")/npm" ]] && blocked="npm missing"
  if [[ -n $blocked ]]; then
    record SKIP build "$blocked; npm ci, build and service setup not run" "install Node ${MIN_NODE} (see node above), then re-run ./install.sh"
    return
  fi

  if npm_run ci; then
    record OK npm-ci "dependencies installed"
  else
    record FAIL npm-ci "npm ci failed (output above)" "check network access to the npm registry, then re-run"
    return
  fi
  if npm_run run build; then
    record OK build "web/dist built"
  else
    record FAIL build "npm run build failed (output above)"
    return
  fi
  write_version

  local unit
  if ! unit="$(render_unit)"; then
    record FAIL unit "couldn't render $TEMPLATE" "move the checkout to a plain path and re-run"
    return
  fi
  mkdir -p "$UNIT_DIR"
  if [[ -f $UNIT_FILE ]] && [[ "$(<"$UNIT_FILE")" == "$unit" ]]; then
    record OK unit "$UNIT_FILE unchanged"
  else
    printf '%s\n' "$unit" >"$UNIT_FILE.tmp" && mv -f "$UNIT_FILE.tmp" "$UNIT_FILE"
    record OK unit "wrote $UNIT_FILE (node: $NODE_BIN)"
  fi

  if ! have systemctl || ! systemctl --user show-environment >/dev/null 2>&1; then
    record FAIL service "systemctl --user not reachable; unit written but not loaded" \
      "from a desktop terminal: systemctl --user daemon-reload && systemctl --user enable --now motherapp"
    return
  fi
  run systemctl --user daemon-reload

  if systemctl --user is-enabled --quiet "$UNIT_NAME" 2>/dev/null; then
    info "service already enabled, restarting it to pick up the new build"
    if run systemctl --user restart "$UNIT_NAME"; then
      record OK service "enabled, restarted"
    else
      record FAIL service "restart failed" "journalctl --user -u motherapp -n 50 --no-pager"
      return
    fi
  elif ask "Enable motherapp to start with your session and start it now (systemctl --user enable --now motherapp)"; then
    if run systemctl --user enable --now "$UNIT_NAME"; then
      record OK service "enabled and started"
    else
      record FAIL service "enable --now failed" "journalctl --user -u motherapp -n 50 --no-pager"
      return
    fi
  else
    record WARN service "unit installed but not enabled (you said no)" "systemctl --user enable --now motherapp" 0
    return
  fi

  local url="http://127.0.0.1:$PORT/"
  if ! have curl; then
    record WARN http "curl not installed, can't check $url" "open $url in a browser" 0
  elif wait_http; then
    record OK http "$url responds"
  else
    record FAIL http "$url didn't respond within ${HTTP_WAIT}s" "journalctl --user -u motherapp -n 50 --no-pager"
    if have journalctl; then
      info "last log lines:"
      journalctl --user -u motherapp -n 20 --no-pager 2>/dev/null | sed 's/^/      /'
    fi
  fi
}

# Records the version just built in build-info.json (npm run build writes it too; this makes
# sure it describes exactly this install) and prints "OK version v1-<hash>".
write_version() {
  local v
  if ! declare -F mbi_write >/dev/null; then
    record WARN version "$BUILD_INFO_SH missing; build-info.json not written" "" 0
  elif v="$(mbi_write "$REPO_DIR")"; then
    if [[ $v == *-unknown* ]]; then
      record OK version "$v (not a git checkout, so there is no hash)"
    else
      record OK version "$v"
    fi
  else
    record WARN version "couldn't write $BUILD_INFO; the UI will show v?-unknown" "check that $REPO_DIR is writable, then re-run" 0
  fi
}

# --check: what was built vs where the checkout is now.
version_status() {
  local built now
  declare -F mbi_built >/dev/null || return 0
  now="$(mbi_string "$REPO_DIR")"
  if ! built="$(mbi_built "$BUILD_INFO")"; then
    [[ -f $REPO_DIR/web/dist/index.html ]] || return 0   # not built at all: the build row says so
    record WARN version "no build-info.json; the checkout is at $now" "./install.sh (or: motherapp install)" 0
  elif [[ ${built%-dirty} == "${now%-dirty}" ]]; then
    record OK version "built $built${now:+, checkout at $now}"
  else
    record WARN version "built $built, checkout is at $now" "motherapp install (or ./install.sh)" 0
  fi
}

# Read-only version of app_setup for --check.
app_status() {
  section "App"
  if [[ -f $REPO_DIR/node_modules/.package-lock.json ]]; then
    record OK deps "node_modules present"
  else
    record MISSING deps "node_modules not installed" "./install.sh (runs npm ci)"
  fi
  if [[ -f $REPO_DIR/web/dist/index.html ]]; then
    record OK build "web/dist/index.html present"
  else
    record MISSING build "web/dist not built" "./install.sh (runs npm run build)"
  fi
  version_status
  local unit
  if [[ ! -f $UNIT_FILE ]]; then
    record MISSING unit "$UNIT_FILE not installed" "./install.sh"
  elif [[ -z $NODE_BIN ]]; then
    record WARN unit "$UNIT_FILE present; can't compare without Node >= ${MIN_NODE}" "" 0
  elif unit="$(render_unit 2>/dev/null)" && [[ "$(<"$UNIT_FILE")" == "$unit" ]]; then
    record OK unit "$UNIT_FILE up to date"
  else
    record WARN unit "$UNIT_FILE differs from what the installer would write now" "./install.sh" 0
  fi
  local url="http://127.0.0.1:$PORT/"
  if have systemctl && systemctl --user is-active --quiet "$UNIT_NAME" 2>/dev/null; then
    local en
    en="$(systemctl --user is-enabled "$UNIT_NAME" 2>/dev/null)"
    record OK service "active (${en:-unknown})"
    if ! have curl; then
      record WARN http "curl not installed, can't check $url" "" 0
    elif http_ok; then
      record OK http "$url responds"
    else
      record FAIL http "$url doesn't respond" "journalctl --user -u motherapp -n 50 --no-pager"
    fi
  else
    record MISSING service "motherapp user service not running" "./install.sh, or: systemctl --user enable --now motherapp"
  fi
}

# ---------------------------------------------------------------- tool commands (~/.local/bin)

BIN_DIR="$HOME/.local/bin"
BIN_MARKER="# managed by motherapp install.sh"
BIN_CMDS=() BIN_SCRIPTS=() BIN_BAD=0

# Prints the "bin" entries of every tools/*/manifest.json, one per line:
# "ok<TAB>tool dir<TAB>command<TAB>absolute script" or "bad<TAB>tool dir<TAB>message".
BINS_JS='
const fs = require("fs"), path = require("path");
const root = process.argv[1], seen = new Map(), clean = (s) => String(s).replace(/\s+/g, " ");
const out = (...f) => console.log(f.join("\t"));
for (const d of fs.readdirSync(root).sort()) {
  const file = path.join(root, d, "manifest.json");
  if (!fs.existsSync(file)) continue;
  let m;
  try { m = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { out("bad", d, clean(e.message)); continue; }
  const bin = m && m.bin;
  if (bin === undefined) continue;
  if (typeof bin !== "object" || bin === null || Array.isArray(bin)) { out("bad", d, "\"bin\" must be an object"); continue; }
  for (const [cmd, rel] of Object.entries(bin)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(cmd)) { out("bad", d, "bad command name " + clean(JSON.stringify(cmd))); continue; }
    if (typeof rel !== "string" || rel === "" || path.isAbsolute(rel) || rel.split(/[\\/]/).includes("..") || /[\t\n\r]/.test(rel)) {
      out("bad", d, cmd + ": the script must be a relative path inside the tool directory"); continue;
    }
    if (cmd === "motherapp") { out("bad", d, "motherapp: reserved for the motherapp command"); continue; }
    if (seen.has(cmd)) { out("bad", d, cmd + ": already provided by tools/" + seen.get(cmd)); continue; }
    const abs = path.join(root, d, rel);
    if (/[\t\n\r]/.test(abs) || !fs.statSync(abs, { throwIfNoEntry: false })?.isFile()) { out("bad", d, cmd + ": " + clean(rel) + " not found"); continue; }
    seen.set(cmd, d);
    out("ok", d, cmd, abs);
  }
}'

# Fills BIN_CMDS/BIN_SCRIPTS from the manifests, read with the chosen Node (records a WARN
# for each bad entry). Returns 1 when the manifests couldn't be read at all.
load_bins() {
  BIN_CMDS=() BIN_SCRIPTS=() BIN_BAD=0
  local out kind dir a b
  if ! out="$("$NODE_BIN" -e "$BINS_JS" "$REPO_DIR/tools" 2>&1)"; then
    record WARN commands "couldn't read tools/*/manifest.json with $NODE_BIN: ${out//$'\n'/ }" "" 0
    return 1
  fi
  while IFS=$'\t' read -r kind dir a b; do
    case $kind in
      ok) BIN_CMDS+=("$a") BIN_SCRIPTS+=("$b") ;;
      bad) BIN_BAD=1; record WARN commands "tools/$dir/manifest.json: $a" "fix its \"bin\" field (docs/extension-contract.md)" 0 ;;
    esac
  done <<<"$out"
}

# The wrapper for one script: the chosen Node by absolute path, so neither an older `node`
# first on PATH nor the minimal PATH of a keyboard shortcut matters.
render_wrapper() {
  printf '#!/usr/bin/env bash\n%s\n# Runs %s with the Node chosen by ./install.sh. Re-run ./install.sh to\n# update it; ./install.sh --uninstall removes it.\nexec %q --disable-warning=ExperimentalWarning %q "$@"\n' \
    "$BIN_MARKER" "${1#"$REPO_DIR"/}" "$NODE_BIN" "$1"
}

# True for a regular file (not a symlink) that starts with #! and whose second line is the
# marker. ~/.local/bin also holds binaries (uv, ffmpeg, ...): NULs are dropped inside the pipe,
# because bash warns "ignored null byte in input" when a $(...) result contains one.
is_managed() {
  [[ -f $1 && ! -L $1 ]] &&
    [[ "$(head -c 512 -- "$1" 2>/dev/null | tr -d '\0' | sed -n '1{/^#!/!q;};2p')" == "$BIN_MARKER" ]]
}

is_bin_cmd() {
  local c
  [[ $1 == "$APP_CMD" ]] && return 0
  for c in "${BIN_CMDS[@]}"; do [[ $c == "$1" ]] && return 0; done
  return 1
}

# ~/.local/bin/motherapp: scripts/motherapp.sh run by absolute path with this bash, and the
# chosen Node passed in MOTHERAPP_NODE (the script uses it to read the core's status JSON).
APP_CMD=motherapp
render_app_wrapper() {
  printf '#!/usr/bin/env bash\n%s\n# The motherapp command: runs %s with the Node chosen by ./install.sh.\n# Re-run ./install.sh to update it; ./install.sh --uninstall removes it.\nexport MOTHERAPP_NODE=%q\nexec %q %q "$@"\n' \
    "$BIN_MARKER" "${MOTHERAPP_SH#"$REPO_DIR"/}" "$NODE_BIN" "$BASH" "$MOTHERAPP_SH"
}

# Writes one wrapper (unless a file that isn't ours is in the way) and records the result.
write_wrapper() { # command content fix-hint
  local cmd=$1 want=$2 f="$BIN_DIR/$1" verb=wrote
  if [[ -e $f || -L $f ]] && ! is_managed "$f"; then
    record WARN "$cmd" "$f exists and wasn't written by install.sh; left alone" \
      "remove or rename it and re-run ./install.sh, or call $3 directly" 0
  elif [[ -f $f && "$(<"$f")" == "$want" ]]; then
    record OK "$cmd" "$f unchanged"
  else
    [[ -f $f ]] && verb=updated
    if printf '%s\n' "$want" >"$f.tmp" && chmod 755 "$f.tmp" && mv -f "$f.tmp" "$f"; then
      record OK "$cmd" "$verb $f (node: $NODE_BIN)"
    else
      rm -f "$f.tmp"
      record FAIL "$cmd" "couldn't write $f"
    fi
  fi
}

# --check for one wrapper.
wrapper_status() { # command content
  local f="$BIN_DIR/$1"
  if [[ ! -e $f && ! -L $f ]]; then
    record MISSING "$1" "$f not installed" "./install.sh"
  elif ! is_managed "$f"; then
    record WARN "$1" "$f exists and wasn't written by install.sh; the installer leaves it alone" \
      "remove or rename it, then re-run ./install.sh" 0
  elif [[ "$(<"$f")" == "$2" ]]; then
    record OK "$1" "$f up to date"
  else
    record WARN "$1" "$f differs from what the installer would write now (Node or checkout moved?)" "./install.sh" 0
  fi
}

check_bin_path() {
  local ex=${BIN_CMDS[0]:-$APP_CMD}
  if [[ ":$PATH:" == *":$BIN_DIR:"* || ":$PATH:" == *":$BIN_DIR/:"* ]]; then
    record OK bin-path "$BIN_DIR is on PATH"
  else
    record WARN bin-path "$BIN_DIR is not on PATH here, so \`$APP_CMD\` and \`$ex\` aren't found by name" \
      "log out and back in: Ubuntu's ~/.profile adds ~/.local/bin to PATH at login once the directory exists (a first install creates it)
or add to ~/.bashrc: export PATH=\"\$HOME/.local/bin:\$PATH\"
GNOME keyboard shortcuts use the login session's PATH; if in doubt, give them the absolute path, e.g. $BIN_DIR/$ex" 0
  fi
}

bin_setup() {
  section "Tool commands ($BIN_DIR)"
  if [[ -z $NODE_BIN ]]; then
    record SKIP commands "Node >= ${MIN_NODE} missing; wrappers not written" "install Node ${MIN_NODE} (see node above), then re-run ./install.sh" 0
    return
  fi
  mkdir -p "$BIN_DIR"
  write_wrapper "$APP_CMD" "$(render_app_wrapper)" "bash $MOTHERAPP_SH"
  load_bins || return
  local i f
  for i in "${!BIN_CMDS[@]}"; do
    write_wrapper "${BIN_CMDS[$i]}" "$(render_wrapper "${BIN_SCRIPTS[$i]}")" "$NODE_BIN ${BIN_SCRIPTS[$i]}"
  done
  # Wrappers for commands no tool declares any more (skipped while a manifest has a bad "bin").
  if (( ! BIN_BAD )); then
    for f in "$BIN_DIR"/*; do
      if ! is_managed "$f" || is_bin_cmd "${f##*/}"; then continue; fi
      run rm -f -- "$f"
      record OK "${f##*/}" "removed $f (no tool declares it any more)"
    done
  fi
  check_bin_path
}

# Read-only version of bin_setup for --check.
bin_status() {
  section "Tool commands ($BIN_DIR)"
  if [[ -z $NODE_BIN ]]; then
    record SKIP commands "can't check the wrappers without Node >= ${MIN_NODE}" "" 0
    return
  fi
  wrapper_status "$APP_CMD" "$(render_app_wrapper)"
  load_bins || return
  local i f
  for i in "${!BIN_CMDS[@]}"; do
    wrapper_status "${BIN_CMDS[$i]}" "$(render_wrapper "${BIN_SCRIPTS[$i]}")"
  done
  for f in "$BIN_DIR"/*; do
    if ! is_managed "$f" || is_bin_cmd "${f##*/}"; then continue; fi
    record WARN "${f##*/}" "$f: no tool declares it any more" "./install.sh removes it" 0
  done
  check_bin_path
}

uninstall_bins() {
  local f n=0
  for f in "$BIN_DIR"/*; do
    is_managed "$f" || continue
    run rm -f -- "$f"
    record OK "${f##*/}" "removed $f"
    n=$((n + 1))
  done
  (( n )) || record OK commands "no motherapp wrappers in $BIN_DIR"
}

# ---------------------------------------------------------------- GNOME keyboard shortcuts

# The shortcuts tool (tools/shortcuts) only ever creates custom keybindings at
# /org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/motherapp-<slug>/.
# Their commands run the ~/.local/bin wrappers by absolute path, so they break when the
# wrappers go. Every other custom keybinding belongs to the user and is never touched.
SC_SCHEMA="org.gnome.settings-daemon.plugins.media-keys"
SC_OWNED_RE='^/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/motherapp-[a-z0-9]+(-[a-z0-9]+)*/$'
SC_ALL=() SC_OURS=()

sc_gsettings() { LC_ALL=C.UTF-8 gsettings "$@" 2>/dev/null; }

# Reads the custom-keybindings array into SC_ALL (all paths, in order) and SC_OURS (motherapp
# ones). Returns 1 when gsettings can't be used here (not installed, no GNOME schema), 2 when
# the array holds something this script won't parse (quotes or backslashes in a path).
sc_read() {
  SC_ALL=() SC_OURS=()
  have gsettings || return 1
  local out p rebuilt=""
  out="$(sc_gsettings get "$SC_SCHEMA" custom-keybindings)" || return 1
  [[ $out == "@as []" || $out == "[]" ]] && return 0
  [[ $out == *'"'* || $out == *\\* ]] && return 2
  while IFS= read -r p; do
    [[ -n $p ]] || continue
    p="${p#\'}" p="${p%\'}"
    SC_ALL+=("$p")
    rebuilt+="${rebuilt:+, }'$p'"
    [[ $p =~ $SC_OWNED_RE ]] && SC_OURS+=("$p")
  done < <(grep -o "'[^']*'" <<<"$out")
  [[ "[$rebuilt]" == "$out" ]] || return 2
}

sc_get() { # path key -> the value as gsettings prints it ('…' or "…")
  sc_gsettings get "$SC_SCHEMA.custom-keybinding:$1" "$2"
}

# The ~/.local/bin wrappers a command refers to that don't exist (one per line).
sc_missing_wrappers() {
  local w
  while IFS= read -r w; do
    [[ $w == "$BIN_DIR/"* && ! -e $w ]] && printf '%s\n' "$w"
  done < <(grep -oE "/[^ '\"]+" <<<"$1")
}

sc_names() { # the names of SC_OURS as gsettings prints them, comma-separated, for messages
  local p n out=""
  for p in "${SC_OURS[@]}"; do
    n="$(sc_get "$p" name)"
    out+="${out:+, }${n:-?}"
  done
  printf '%s' "$out"
}

# Status for --check (and after an install): how many motherapp shortcuts exist and whether
# the wrappers they run exist.
shortcuts_status() {
  local rc=0
  sc_read || rc=$?
  if (( rc == 1 )); then
    info "GNOME keyboard shortcuts: gsettings or GNOME's media-keys schema isn't available here; not checked"
    return
  fi
  section "GNOME keyboard shortcuts"
  if (( rc == 2 )); then
    record WARN shortcuts "can't read the custom-keybindings list safely; not checked" "see: gsettings get $SC_SCHEMA custom-keybindings" 0
    return
  fi
  local n=${#SC_OURS[@]} p cmd miss broken=()
  if (( n == 0 )); then
    record OK shortcuts "no motherapp keyboard shortcuts (${#SC_ALL[@]} other custom shortcut(s) left alone)"
    return
  fi
  for p in "${SC_OURS[@]}"; do
    cmd="$(sc_get "$p" command)"
    miss="$(sc_missing_wrappers "$cmd")"
    [[ -n $miss ]] && broken+=("$(sc_get "$p" name) -> ${miss//$'\n'/ }")
  done
  if (( ${#broken[@]} == 0 )); then
    record OK shortcuts "$n motherapp keyboard shortcut(s), their wrappers exist (${#SC_ALL[@]} custom shortcut(s) in all)"
  else
    record WARN shortcuts "$n motherapp keyboard shortcut(s), ${#broken[@]} run a missing wrapper: $(printf '%s; ' "${broken[@]}" | sed 's/; $//')" \
      "./install.sh writes the wrappers again; or remove those shortcuts on the Shortcuts page (shortcutsctl remove <name>)" 0
  fi
}

# --uninstall: offer to remove the motherapp shortcuts (default no, --yes says yes). Kept, they
# would run wrappers that the uninstall removes.
uninstall_shortcuts() {
  local rc=0
  sc_read || rc=$?
  if (( rc == 1 )); then
    info "GNOME keyboard shortcuts: gsettings not available here; if you made shortcuts with motherapp, remove them in GNOME Settings"
    return
  fi
  if (( rc == 2 )); then
    record WARN shortcuts "can't read the custom-keybindings list safely; motherapp shortcuts (if any) left alone" "remove them in GNOME Settings > Keyboard > Custom Shortcuts" 0
    return
  fi
  local n=${#SC_OURS[@]}
  if (( n == 0 )); then
    record OK shortcuts "no motherapp keyboard shortcuts"
    return
  fi
  local names
  names="$(sc_names)"
  if ! ask "Remove the $n GNOME keyboard shortcut(s) motherapp made ($names)? If kept, they run $BIN_DIR wrappers that this uninstall removes. Other shortcuts are not touched"; then
    record WARN shortcuts "kept $n motherapp keyboard shortcut(s) ($names); they point at removed wrappers" \
      "remove them in GNOME Settings > Keyboard > Custom Shortcuts, or reinstall and use the Shortcuts page" 0
    return
  fi
  # re-read right before writing, keep every other entry in its place
  sc_read || { record FAIL shortcuts "couldn't re-read the custom-keybindings list"; return; }
  local p keep="" ours=("${SC_OURS[@]}")
  for p in "${SC_ALL[@]}"; do
    [[ $p =~ $SC_OWNED_RE ]] || keep+="${keep:+, }'$p'"
  done
  if [[ -z $keep ]]; then keep="@as []"; else keep="[$keep]"; fi
  cmdline "gsettings set $SC_SCHEMA custom-keybindings \"$keep\""
  if ! LC_ALL=C.UTF-8 gsettings set "$SC_SCHEMA" custom-keybindings "$keep"; then
    record FAIL shortcuts "gsettings couldn't write the custom-keybindings list"
    return
  fi
  # without the session bus gsettings may "succeed" and write nowhere: read it back
  if ! sc_read || (( ${#SC_OURS[@]} )); then
    record FAIL shortcuts "the custom-keybindings list didn't change (no session D-Bus here? run --uninstall from a terminal in your GNOME session)"
    return
  fi
  for p in "${ours[@]}"; do
    if have dconf; then
      run dconf reset -f "$p"
    else
      local k
      for k in name command binding; do LC_ALL=C.UTF-8 gsettings reset "$SC_SCHEMA.custom-keybinding:$p" "$k"; done
    fi
  done
  record OK shortcuts "removed ${#ours[@]} motherapp keyboard shortcut(s): $names"
}

# ---------------------------------------------------------------- summary

summary() {
  section "Summary"
  local i failed=0 warned=0 skipped=0
  for i in "${!R_STATUS[@]}"; do
    print_row "${R_STATUS[$i]}" "${R_NAME[$i]}" "${R_DETAIL[$i]}" "${R_FIX[$i]}"
    # A required item that is missing, failed or skipped fails the run; optional ones count as
    # warnings, except an optional SKIP, which is counted on its own.
    if [[ ${R_STATUS[$i]} == OK ]]; then continue; fi
    if [[ ${R_STATUS[$i]} != WARN && ${R_REQ[$i]} == 1 ]]; then failed=$((failed + 1))
    elif [[ ${R_STATUS[$i]} == SKIP ]]; then skipped=$((skipped + 1))
    else warned=$((warned + 1))
    fi
  done
  printf '\n'
  if [[ $MODE != uninstall && -n $NODE_BIN ]] && node_is_versioned; then
    info "note: Node is $NODE_BIN, from a version manager: re-run ./install.sh after upgrading or removing that Node version (the unit and the wrappers use this path)"
    printf '\n'
  fi
  local counts
  counts="$warned warning(s)"
  (( skipped )) && counts+=", $skipped skipped"
  if (( failed > 0 )); then
    printf '%sRESULT: FAIL%s (%d required item(s) missing or failed, %s)\n' "$C_RED" "$C_RESET" "$failed" "$counts"
    return 1
  fi
  local tail=""
  [[ $MODE == install || $MODE == check ]] && tail=" - open http://127.0.0.1:$PORT/"
  printf '%sRESULT: OK%s (%s)%s\n' "$C_GREEN" "$C_RESET" "$counts" "$tail"
  return 0
}

# ---------------------------------------------------------------- uninstall

uninstall() {
  section "Uninstall"
  if have systemctl && systemctl --user show-environment >/dev/null 2>&1; then
    if systemctl --user is-enabled --quiet "$UNIT_NAME" 2>/dev/null || systemctl --user is-active --quiet "$UNIT_NAME" 2>/dev/null; then
      if run systemctl --user disable --now "$UNIT_NAME"; then
        record OK service "stopped and disabled"
      else
        record FAIL service "disable --now failed"
      fi
    else
      record OK service "not enabled or running"
    fi
  else
    record WARN service "systemctl --user not reachable; only removing files" "" 0
  fi
  if [[ -f $UNIT_FILE ]]; then
    run rm -f "$UNIT_FILE"
    record OK unit "removed $UNIT_FILE"
  else
    record OK unit "$UNIT_FILE not present"
  fi
  if have systemctl && systemctl --user show-environment >/dev/null 2>&1; then
    run systemctl --user daemon-reload
    systemctl --user reset-failed "$UNIT_NAME" >/dev/null 2>&1 || true
  fi
  uninstall_shortcuts
  uninstall_bins
  local d
  for d in "$APP_CONFIG_DIR" "$APP_STATE_DIR"; do
    if [[ ! -e $d ]]; then
      record OK data "$d not present"
    elif (( PURGE )); then
      if ask "Delete $d (motherapp settings/state/logs)"; then
        run rm -rf -- "$d"
        record OK data "deleted $d"
      else
        record WARN data "kept $d (you said no)" "" 0
      fi
    else
      record OK data "kept $d (use --uninstall --purge to delete)"
    fi
  done
  info "dependencies (Node, apt packages, i2c settings) are left installed"
}

# ---------------------------------------------------------------- main

printf '%smotherapp installer%s  mode: %s%s  repo: %s\n' "$C_BOLD" "$C_RESET" "$MODE" \
  "$( ((YES)) && printf ' (--yes)')" "$REPO_DIR"

if [[ $(id -u 2>/dev/null) == 0 ]]; then
  echo "install.sh: don't run this as root or with sudo; it installs a *user* service and asks for sudo itself when needed." >&2
  exit 2
fi

case "$MODE" in
  uninstall)
    uninstall
    summary
    exit $?
    ;;
  check)
    run_checks
    resolve_port
    app_status
    bin_status
    shortcuts_status
    summary
    exit $?
    ;;
  install)
    run_checks
    offer_fixes
    if (( APPLIED_FIX )); then
      section "Re-checking after the changes above"
      reset_records
      run_checks
    fi
    resolve_port
    app_setup
    bin_setup
    shortcuts_status
    summary
    exit $?
    ;;
esac
