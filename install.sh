#!/usr/bin/env bash
# motherapp installer: checks every dependency, installs the missing ones (asking before
# anything uses sudo/apt) or says how to install them, then builds the app and sets up the
# systemd user service. Target: Ubuntu 24.04, GNOME 46, Wayland. Safe to re-run.
#
#   ./install.sh               interactive: asks y/N before each sudo/apt step and before
#                              enabling the service
#   ./install.sh --check       report only, change nothing (also: npm run doctor)
#   ./install.sh --yes         accept every prompt
#   ./install.sh --uninstall   stop + disable the service and remove the unit file
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

# ---------------------------------------------------------------- options

MODE=install
YES=0
PURGE=0

usage() {
  cat <<'EOF'
Usage: ./install.sh [--check | --uninstall [--purge]] [--yes]

  (no option)   Check dependencies, offer to install missing ones (asks before every
                sudo/apt step), run npm ci + npm run build, write the systemd user unit,
                ask before enabling it, then check http://127.0.0.1:7323/.
  --check       Only report status. Changes nothing, asks nothing.
  --yes, -y     Answer yes to every prompt.
  --uninstall   Stop and disable the service, remove ~/.config/systemd/user/motherapp.service.
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

NODE_FIX_TEXT="Option A (sudo, offered by this installer): NodeSource apt repo for Node ${MIN_NODE}:
  sudo install -d -m 0755 /etc/apt/keyrings
  curl -fsSL $NODESOURCE_KEY_URL | sudo gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo '$NODESOURCE_LIST_LINE' | sudo tee /etc/apt/sources.list.d/nodesource.list
  sudo apt-get update && sudo apt-get install -y nodejs
Option B (no sudo): fnm   curl -fsSL https://fnm.vercel.app/install | bash; then: fnm install ${MIN_NODE}
Option C (no sudo): nvm   see https://github.com/nvm-sh/nvm#installing-and-updating; then: nvm install ${MIN_NODE}
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

fix_nodesource() {
  if ! have curl; then
    info "curl is missing; install it first: sudo apt-get install curl"
    return 1
  fi
  run_sudo install -d -m 0755 "$ROOT/etc/apt/keyrings" &&
    { cmdline "curl -fsSL $NODESOURCE_KEY_URL | sudo gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg"
      curl -fsSL "$NODESOURCE_KEY_URL" | sudo gpg --dearmor --yes -o "$ROOT/etc/apt/keyrings/nodesource.gpg"; } &&
    { cmdline "echo '$NODESOURCE_LIST_LINE' | sudo tee /etc/apt/sources.list.d/nodesource.list"
      printf '%s\n' "$NODESOURCE_LIST_LINE" | sudo tee "$ROOT/etc/apt/sources.list.d/nodesource.list" >/dev/null; } &&
    run_sudo apt-get update &&
    run_sudo apt-get install -y nodejs
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

  if (( NEED_NODE )); then
    section "Install Node ${MIN_NODE}"
    if (( can_apt )); then
      if ask "Add the NodeSource apt repo for Node ${MIN_NODE} (writes /etc/apt/keyrings/nodesource.gpg and /etc/apt/sources.list.d/nodesource.list) and run sudo apt-get install nodejs"; then
        if fix_nodesource; then APPLIED_FIX=1; else info "NodeSource install failed (see above)"; fi
      else
        info "skipped. Without sudo, use fnm or nvm:"
        info "  curl -fsSL https://fnm.vercel.app/install | bash && fnm install ${MIN_NODE}"
        info "  or nvm: https://github.com/nvm-sh/nvm  then: nvm install ${MIN_NODE}"
        info "then re-run ./install.sh"
      fi
    else
      info "apt-get/sudo not available. Install Node ${MIN_NODE} with fnm or nvm, then re-run."
    fi
  fi

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

# ---------------------------------------------------------------- summary

summary() {
  section "Summary"
  local i failed=0 warned=0
  for i in "${!R_STATUS[@]}"; do
    print_row "${R_STATUS[$i]}" "${R_NAME[$i]}" "${R_DETAIL[$i]}" "${R_FIX[$i]}"
    case "${R_STATUS[$i]}" in
      MISSING | FAIL | SKIP) [[ ${R_REQ[$i]} == 1 ]] && failed=$((failed + 1)) || warned=$((warned + 1)) ;;
      WARN) warned=$((warned + 1)) ;;
    esac
  done
  printf '\n'
  if (( failed > 0 )); then
    printf '%sRESULT: FAIL%s (%d required item(s) missing or failed, %d warning(s))\n' "$C_RED" "$C_RESET" "$failed" "$warned"
    return 1
  fi
  local tail=""
  [[ $MODE == install || $MODE == check ]] && tail=" - open http://127.0.0.1:$PORT/"
  printf '%sRESULT: OK%s (%d warning(s))%s\n' "$C_GREEN" "$C_RESET" "$warned" "$tail"
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
    summary
    exit $?
    ;;
esac
