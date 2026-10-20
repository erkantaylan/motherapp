#!/usr/bin/env bash
# The `motherapp` command. ./install.sh writes ~/.local/bin/motherapp, a wrapper that runs this
# script by absolute path with MOTHERAPP_NODE set to the Node it chose, so it works from any
# directory and from GNOME keyboard shortcuts. Run `motherapp help` for the commands.
#
# Bash on purpose: it is mostly git, systemctl and ./install.sh, and `motherapp install` has to
# work when Node is the thing that's broken (install.sh fixes that). Node (MOTHERAPP_NODE, else
# `node` on PATH) is only used to read the core's /api/status JSON for `motherapp status`.
#
# `motherapp install` never stashes, resets or merges: it refuses on local changes, on another
# branch than main and on diverged history, and only ever fast-forwards.

set -uo pipefail
# bash sets a default PATH when it starts without one (env -i, some launchers); keep it usable.
PATH="${PATH:-/usr/local/bin:/usr/bin:/bin}"
# ~ falls back to the passwd entry when HOME is unset.
[[ -n ${HOME:-} ]] || HOME="$(cd ~ 2>/dev/null && pwd)"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
UNIT_NAME="motherapp.service"
BRANCH=main
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
# shellcheck source=scripts/build-info.sh
. "$REPO_DIR/scripts/build-info.sh"

if [[ -t 1 ]]; then
  C_RESET=$'\e[0m' C_BOLD=$'\e[1m' C_RED=$'\e[31m' C_YELLOW=$'\e[33m' C_DIM=$'\e[2m'
else
  C_RESET='' C_BOLD='' C_RED='' C_YELLOW='' C_DIM=''
fi

say() { printf '%s\n' "$*"; }
section() { printf '%s==> %s%s\n' "$C_BOLD" "$1" "$C_RESET"; }
cmdline() { printf '    %s+ %s%s\n' "$C_DIM" "$*" "$C_RESET"; }
die() { printf '%smotherapp: %s%s\n' "$C_RED" "$1" "$C_RESET" >&2; exit "${2:-1}"; }
have() { command -v "$1" >/dev/null 2>&1; }

usage() {
  cat <<'EOF'
Usage: motherapp <command>

  install, update   git fetch + git pull --ff-only on main, then
                    ./install.sh --yes (no questions; it stops instead of removing
                    apt packages), then
                    show old -> new version, the new commits and the HTTP check. Refuses
                    when the checkout has local changes, isn't on main, or has diverged
                    from origin (it never stashes, resets or merges). Already up to date:
                    says so, and re-runs ./install.sh only if the build is missing or stale.
  status            service state, running vs checkout version, each tool's state
  version           the version that was built (also: --version, -V)
  check             ./install.sh --check (report only, changes nothing)
  logs              follow the service log (journalctl --user -u motherapp -f -o cat)
  open              open the UI in the browser
  uninstall         ./install.sh --uninstall (extra options are passed on, e.g. --purge)
  help              this text

Versions look like v1-abc1234: the number in VERSION, the short git hash, and -dirty
when the checkout had uncommitted changes at build time.
EOF
}

# ---------------------------------------------------------------- helpers

node_bin() {
  if [[ -n ${MOTHERAPP_NODE:-} && -x $MOTHERAPP_NODE ]]; then printf '%s' "$MOTHERAPP_NODE"
  else command -v node 2>/dev/null
  fi
}

# Port of the running service: MOTHERAPP_PORT, else the unit's Environment= line (install.sh
# writes one when MOTHERAPP_PORT was set at install time), else config.json, else 7323.
port() {
  local p="" f
  if [[ -n ${MOTHERAPP_PORT:-} ]]; then p=$MOTHERAPP_PORT
  else
    f="$CONFIG_HOME/systemd/user/$UNIT_NAME"
    [[ -f $f ]] && p="$(grep -oE '^Environment=MOTHERAPP_PORT=[0-9]+' "$f" | head -n1 | grep -oE '[0-9]+$')"
    f="$CONFIG_HOME/motherapp/config.json"
    [[ -z $p && -f $f ]] && p="$(grep -oE '"port"[[:space:]]*:[[:space:]]*[0-9]+' "$f" | head -n1 | grep -oE '[0-9]+$')"
  fi
  [[ $p =~ ^[0-9]+$ ]] && (( p > 0 && p < 65536 )) || p=7323
  printf '%s' "$p"
}

url() { printf 'http://127.0.0.1:%s/' "$(port)"; }

service_state() { systemctl --user is-active "$UNIT_NAME" 2>/dev/null || true; }

# What was built (build-info.json): BUILT_STRING is "v1-abc1234[-dirty]"; fails when missing.
BUILT_NUMBER="" BUILT_HASH="" BUILT_DIRTY="" BUILT_STRING=""
read_built() {
  local f="$REPO_DIR/build-info.json"
  BUILT_NUMBER="" BUILT_HASH="" BUILT_DIRTY="" BUILT_STRING=""
  BUILT_HASH="$(mbi_field "$f" hash)" || return 1
  BUILT_NUMBER="$(mbi_field "$f" version)" || BUILT_NUMBER="?"
  BUILT_DIRTY="$(mbi_field "$f" dirty)" || BUILT_DIRTY=false
  BUILT_STRING="$(mbi_format "$BUILT_NUMBER" "$BUILT_HASH" "$BUILT_DIRTY")"
}

# The core's /api/status, turned into tab-separated lines by Node:
#   running <string> <hash> <version>
#   tool    <id> <status> <enabled> <statusText>
STATUS_JS='
let s = "";
process.stdin.on("data", (c) => (s += c)).on("end", () => {
  const j = JSON.parse(s), clean = (x) => String(x ?? "").replace(/\s+/g, " ");
  const r = j.version && j.version.running;
  if (r) console.log(["running", r.string, r.hash, r.version].map(clean).join("\t"));
  for (const t of j.tools || []) console.log(["tool", t.id, t.status, t.enabled ? "enabled" : "disabled", t.statusText].map(clean).join("\t"));
});'

CORE_LINES="" RUNNING_STRING="" RUNNING_HASH="" RUNNING_NUMBER=""
read_core() {
  CORE_LINES="" RUNNING_STRING="" RUNNING_HASH="" RUNNING_NUMBER=""
  have curl || return 1
  local json node
  json="$(curl -fsS --max-time 3 "$(url)api/status?refresh=1" 2>/dev/null)" || return 1
  node="$(node_bin)" || return 1
  [[ -n $node ]] || return 1
  CORE_LINES="$(printf '%s' "$json" | "$node" -e "$STATUS_JS" 2>/dev/null)" || return 1
  local kind a b c
  while IFS=$'\t' read -r kind a b c _; do
    [[ $kind == running ]] && RUNNING_STRING=$a RUNNING_HASH=$b RUNNING_NUMBER=$c
  done <<<"$CORE_LINES"
  return 0
}

# True when a build (hash + number) matches the checkout's HEAD.
matches_head() { # hash number
  local head
  head="$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null)" || return 1
  [[ -n $1 && $1 != unknown && $head == "$1"* && $2 == "$(mbi_number "$REPO_DIR")" ]]
}

# ---------------------------------------------------------------- commands

cmd_version() {
  if read_built; then say "motherapp $BUILT_STRING"
  else say "motherapp v?-unknown (no build-info.json: run motherapp install)"
  fi
}

cmd_status() {
  local st en checkout rc=0
  st="$(service_state)"
  en="$(systemctl --user is-enabled "$UNIT_NAME" 2>/dev/null || true)"
  printf '%-10s %s\n' service "${st:-unknown}${en:+ ($en)}"
  [[ $st == active ]] || rc=1

  checkout="$(mbi_string "$REPO_DIR")"
  read_built || true
  local have_core=0
  [[ $st == active ]] && read_core && have_core=1
  if (( have_core )); then
    printf '%-10s %s\n' running "${RUNNING_STRING:-unknown}"
  elif [[ $st == active ]]; then
    printf '%-10s %s\n' running "unknown (no answer from $(url)api/status)"
  else
    printf '%-10s %s\n' running "not running"
  fi
  printf '%-10s %s\n' built "${BUILT_STRING:-not built (no build-info.json)}"
  printf '%-10s %s  %s\n' checkout "$checkout" "($REPO_DIR)"

  if (( have_core )) && [[ -n $RUNNING_HASH ]] && ! matches_head "$RUNNING_HASH" "$RUNNING_NUMBER"; then
    say "${C_YELLOW}running $RUNNING_STRING, checkout is at ${checkout%-dirty}, run \`motherapp install\`${C_RESET}"
  elif (( ! have_core )) && [[ -n $BUILT_HASH ]] && ! matches_head "$BUILT_HASH" "$BUILT_NUMBER"; then
    say "${C_YELLOW}built $BUILT_STRING, checkout is at ${checkout%-dirty}, run \`motherapp install\`${C_RESET}"
  elif [[ -z $BUILT_HASH ]] && (( ! have_core )); then
    say "${C_YELLOW}not built yet, run \`motherapp install\`${C_RESET}"
  fi

  if (( have_core )); then
    local kind id status enabled text n=0
    say "tools"
    while IFS=$'\t' read -r kind id status enabled text; do
      [[ $kind == tool ]] || continue
      n=$((n + 1))
      if [[ $enabled == disabled ]]; then status="disabled"; fi
      printf '  %-14s %s%s\n' "$id" "$status" "${text:+ ($text)}"
    done <<<"$CORE_LINES"
    (( n )) || say "  (none)"
  elif [[ $st == active ]]; then
    say "tools      unknown (the core didn't answer; motherapp logs shows why)"
  fi
  return "$rc"
}

# Refuses (exit 1) unless the checkout is a clean main that can fast-forward. Sets REMOTE,
# AHEAD and BEHIND.
REMOTE="" AHEAD=0 BEHIND=0
preflight() {
  git -C "$REPO_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 ||
    die "$REPO_DIR is not a git checkout; can't update it"
  local branch changes
  branch="$(git -C "$REPO_DIR" symbolic-ref --quiet --short HEAD 2>/dev/null)" ||
    die "refusing: HEAD is detached, not on $BRANCH. Run: git -C $REPO_DIR switch $BRANCH"
  [[ $branch == "$BRANCH" ]] ||
    die "refusing: the checkout is on branch '$branch', not $BRANCH. Run: git -C $REPO_DIR switch $BRANCH (motherapp only updates $BRANCH)"
  changes="$(git -C "$REPO_DIR" status --porcelain 2>/dev/null)"
  if [[ -n $changes ]]; then
    printf '%smotherapp: refusing: the checkout has local changes:%s\n' "$C_RED" "$C_RESET" >&2
    printf '%s\n' "$changes" | head -n 10 | sed 's/^/    /' >&2
    die "commit or discard them yourself, then re-run (motherapp never stashes, resets or merges)"
  fi
  REMOTE="$(git -C "$REPO_DIR" config "branch.$BRANCH.remote" 2>/dev/null)" || REMOTE=origin
  [[ -n $REMOTE ]] || REMOTE=origin
  cmdline "git fetch $REMOTE"
  git -C "$REPO_DIR" fetch "$REMOTE" || die "git fetch $REMOTE failed (network?); nothing changed"
  git -C "$REPO_DIR" rev-parse --verify --quiet "refs/remotes/$REMOTE/$BRANCH" >/dev/null ||
    die "refusing: there is no $REMOTE/$BRANCH to update from"
  local counts
  counts="$(git -C "$REPO_DIR" rev-list --left-right --count "HEAD...refs/remotes/$REMOTE/$BRANCH")" ||
    die "couldn't compare $BRANCH with $REMOTE/$BRANCH"
  read -r AHEAD BEHIND <<<"$counts"
  if (( AHEAD > 0 && BEHIND > 0 )); then
    die "refusing: $BRANCH and $REMOTE/$BRANCH have diverged ($AHEAD local and $BEHIND remote commit(s)). Sort it out yourself (git log --oneline --graph $BRANCH $REMOTE/$BRANCH); motherapp only fast-forwards"
  fi
}

# Why an up-to-date checkout still needs ./install.sh, or nothing when it doesn't.
stale_reason() {
  if ! read_built; then printf 'no build found (build-info.json is missing)'; return; fi
  local head
  head="$(mbi_string "$REPO_DIR")"
  if [[ $BUILT_DIRTY == true ]] || ! matches_head "$BUILT_HASH" "$BUILT_NUMBER"; then
    printf 'the build is %s but the checkout is at %s' "$BUILT_STRING" "$head"; return
  fi
  if [[ "$(service_state)" != active ]]; then printf "the service isn't running"; return; fi
  if read_core && [[ -n $RUNNING_STRING && $RUNNING_STRING != "$BUILT_STRING" ]]; then
    printf 'the service still runs %s, not the build %s' "$RUNNING_STRING" "$BUILT_STRING"
  fi
}

cmd_install() {
  section "motherapp install ($REPO_DIR)"
  preflight
  local old_head new_head before reason
  old_head="$(git -C "$REPO_DIR" rev-parse HEAD)"
  if read_core && [[ -n $RUNNING_STRING ]]; then before=$RUNNING_STRING
  elif read_built; then before=$BUILT_STRING
  else before="not built"
  fi
  if (( BEHIND > 0 )); then
    cmdline "git pull --ff-only $REMOTE $BRANCH"
    git -C "$REPO_DIR" pull --ff-only "$REMOTE" "$BRANCH" || die "git pull --ff-only failed; nothing installed"
  fi
  new_head="$(git -C "$REPO_DIR" rev-parse HEAD)"

  if [[ $new_head == "$old_head" ]]; then
    reason="$(stale_reason)"
    read_built || true
    if [[ -z $reason ]]; then
      say "already up to date ($BUILT_STRING, $REMOTE/$BRANCH has nothing new)"
      (( AHEAD > 0 )) && say "note: $BRANCH has $AHEAD local commit(s) that aren't on $REMOTE yet"
      return 0
    fi
    say "already up to date with $REMOTE/$BRANCH, but $reason: running ./install.sh --yes"
  fi

  local log code
  log="$(mktemp "${TMPDIR:-/tmp}/motherapp-install.XXXXXX")" || die "mktemp failed"
  cmdline "./install.sh --yes"
  bash "$REPO_DIR/install.sh" --yes 2>&1 | tee "$log"
  code=${PIPESTATUS[0]}

  local after base http
  if read_built; then after=$BUILT_STRING; else after="v?-unknown (no build-info.json)"; fi
  base=$old_head
  # Commits since the build that was running, when that build is an ancestor of the new HEAD.
  if [[ $before =~ ^v[0-9?]+-([0-9a-f]{7,})(-dirty)?$ ]] &&
    git -C "$REPO_DIR" merge-base --is-ancestor "${BASH_REMATCH[1]}" "$new_head" 2>/dev/null; then
    base="$(git -C "$REPO_DIR" rev-parse "${BASH_REMATCH[1]}^{commit}")"
  fi
  http="$(grep -E '^(OK|FAIL|WARN|SKIP|MISSING) +http ' "$log" | tail -n1 | sed -E 's/ +/ /g')"
  rm -f "$log"

  printf '\n'
  section "motherapp updated"
  say "    $before → $after"
  if [[ $base == "$new_head" ]]; then
    say "    no new commits"
  else
    say "    commits:"
    git -C "$REPO_DIR" log --oneline --no-decorate "$base..$new_head" | sed 's/^/      /'
  fi
  say "    ${http:-http: not checked (see the installer output above)}"
  (( code == 0 )) || say "    ${C_RED}./install.sh exited with $code (see above)${C_RESET}"
  return "$code"
}

cmd_open() {
  local u
  u="$(url)"
  if have xdg-open; then xdg-open "$u"; else say "$u"; fi
}

main() {
  local cmd="${1:-help}"
  [[ $# -gt 0 ]] && shift
  case "$cmd" in
    install | update) (( $# == 0 )) || die "usage: motherapp $cmd (no options)" 2; cmd_install ;;
    status) cmd_status ;;
    version | --version | -V) cmd_version ;;
    check) exec bash "$REPO_DIR/install.sh" --check "$@" ;;
    logs) exec journalctl --user -u motherapp -f -o cat ;;
    open) cmd_open ;;
    uninstall) exec bash "$REPO_DIR/install.sh" --uninstall "$@" ;;
    help | --help | -h) usage ;;
    *) printf 'motherapp: unknown command: %s\n\n' "$cmd" >&2; usage >&2; return 2 ;;
  esac
}

# Everything runs from main, which bash has fully read before it starts: `motherapp install`
# pulls a new version of this very file, and bash would otherwise read on into the new one.
main "$@"; exit $?
