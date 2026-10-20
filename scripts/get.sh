#!/usr/bin/env bash
# motherapp bootstrap: clones the repo and runs its installer. The README's one-liner runs it as
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/erkantaylan/motherapp/main/scripts/get.sh)"
#
# which keeps stdin a terminal, so install.sh can ask its y/N questions (`curl … | bash` would
# feed it the script instead, and every question would count as "no").
#
#   MOTHERAPP_DIR       where the checkout goes (default ~/.local/share/motherapp)
#   MOTHERAPP_REPO_URL  what to clone (default the GitHub repo; the tests use a local one)
#
# - A fresh (missing or empty) MOTHERAPP_DIR: git clone, then ./install.sh (its normal prompts).
# - MOTHERAPP_DIR is already a motherapp clone: `motherapp install` there (pull main, rebuild,
#   restart; it refuses on local changes, another branch or diverged history), or ./install.sh
#   when that clone was never built.
# - Anything else in MOTHERAPP_DIR: refuses, changes nothing.
# Never runs as root: motherapp is a systemd *user* service, and install.sh asks for sudo itself.

set -uo pipefail
PATH="${PATH:-/usr/local/bin:/usr/bin:/bin}"
[[ -n ${HOME:-} ]] || HOME="$(cd ~ 2>/dev/null && pwd)"

REPO_URL="${MOTHERAPP_REPO_URL:-https://github.com/erkantaylan/motherapp.git}"
DIR="${MOTHERAPP_DIR:-$HOME/.local/share/motherapp}"

say() { printf 'motherapp-get: %s\n' "$*"; }
die() { printf 'motherapp-get: %s\n' "$1" >&2; exit "${2:-1}"; }
have() { command -v "$1" >/dev/null 2>&1; }

# ask QUESTION -> 0 for yes; no answer (no terminal, closed stdin) counts as no.
ask() {
  local answer=""
  printf '? %s [y/N] ' "$1"
  if ! IFS= read -r answer; then printf '\n'; return 1; fi
  [[ $answer =~ ^[Yy]([Ee][Ss])?$ ]]
}

is_motherapp_clone() { # dir
  local top
  top="$(git -C "$1" rev-parse --show-toplevel 2>/dev/null)" || return 1
  [[ "$(cd "$top" && pwd -P)" == "$(cd "$1" && pwd -P)" ]] &&
    [[ -f $1/install.sh && -f $1/scripts/motherapp.sh && -f $1/VERSION ]]
}

# The checkout the installed service runs from (its unit's WorkingDirectory), if any.
installed_dir() {
  local unit="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/motherapp.service"
  [[ -f $unit ]] && sed -n 's/^WorkingDirectory=//p' "$unit" | head -n1
}

# Says so, and asks, when motherapp is already installed from another checkout.
confirm_move() { # dir
  local cur
  cur="$(installed_dir)"
  [[ -n $cur && "$(cd "$cur" 2>/dev/null && pwd -P)" != "$1" ]] || return 0
  say "motherapp is already installed from $cur."
  say "Installing from $1 points the service, ~/.local/bin/motherapp and the tool commands there instead."
  say "(To update the existing install, run \`motherapp install\`, or MOTHERAPP_DIR=$cur.)"
  ask "Install from $1 instead" || die "nothing changed"
}

main() {
  if [[ $(id -u 2>/dev/null) == 0 ]]; then
    die "don't run this as root or with sudo: motherapp is a systemd user service for your own account, and install.sh asks for sudo itself when it needs it." 2
  fi
  local missing=()
  have git || missing+=(git)
  have curl || missing+=(curl)
  if (( ${#missing[@]} )); then
    die "needs ${missing[*]}, which isn't installed. Install it, then run this again:
    sudo apt-get install ${missing[*]}"
  fi

  if [[ -e $DIR && ! -d $DIR ]]; then
    die "refusing: $DIR exists and isn't a directory. Move it away, or set MOTHERAPP_DIR to another path."
  fi
  if [[ -d $DIR ]] && is_motherapp_clone "$DIR"; then
    DIR="$(cd "$DIR" && pwd -P)"
    confirm_move "$DIR"
    if [[ -f $DIR/build-info.json ]]; then
      say "$DIR is already a motherapp clone: updating it (motherapp install)"
      exec bash "$DIR/scripts/motherapp.sh" install
    fi
    say "$DIR is already a motherapp clone, never built: running ./install.sh there"
    cd "$DIR" || die "can't cd to $DIR"
    exec bash ./install.sh
  fi
  if [[ -d $DIR && -n "$(ls -A "$DIR" 2>/dev/null)" ]]; then
    die "refusing: $DIR exists and isn't a motherapp clone. Move it away, or set MOTHERAPP_DIR to another path, e.g.
    MOTHERAPP_DIR=~/src/motherapp bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/erkantaylan/motherapp/main/scripts/get.sh)\""
  fi

  local parent
  parent="$(dirname "$DIR")"
  mkdir -p "$parent" || die "can't create $parent"
  DIR="$(cd "$parent" && pwd -P)/$(basename "$DIR")"
  confirm_move "$DIR"
  say "cloning $REPO_URL into $DIR"
  git clone --branch main "$REPO_URL" "$DIR" || die "git clone failed (network?); nothing installed"
  say "running ./install.sh in $DIR (it asks before every sudo/apt step)"
  cd "$DIR" || die "can't cd to $DIR"
  exec bash ./install.sh
}

main "$@"; exit $?
