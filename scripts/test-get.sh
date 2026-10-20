#!/usr/bin/env bash
# Tests for scripts/get.sh (the README's one-liner). A local bare repo stands in for GitHub
# (MOTHERAPP_REPO_URL); its install.sh and scripts/motherapp.sh are stubs that log how they were
# started. get.sh runs the way the one-liner runs it: bash -c "<its text>". Nothing outside a
# temp dir is touched. Usage: bash scripts/test-get.sh </dev/null
# Stub bodies are single-quoted on purpose: they expand when the stub runs.
# shellcheck disable=SC2016
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
GET_SH="$(<"$REPO/scripts/get.sh")"
TMP="$(cd "$(mktemp -d)" && pwd -P)"
if [[ -n ${MOTHERAPP_TEST_KEEP:-} ]]; then echo "# keeping $TMP"; else trap 'rm -rf "$TMP"' EXIT; fi
ENV_BIN="$(command -v env)"
PASSED=0 FAILED=0 CASE="" C="" OUT="" CODE=0

export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME=tester GIT_AUTHOR_EMAIL=tester@example.com GIT_COMMITTER_NAME=tester GIT_COMMITTER_EMAIL=tester@example.com

# Real utilities, without git (the cases add it back); nothing else from the host is on PATH.
SYSBIN="$TMP/sysbin" GITBIN="$TMP/gitbin"
mkdir -p "$SYSBIN" "$GITBIN"
for t in bash sh env cat cp mv rm mkdir ls ln chmod touch dirname basename head tail tr cut sed grep printf; do
  p="$(command -v "$t")" && [[ $p == /* ]] && ln -s "$p" "$SYSBIN/$t"
done
ln -s "$(command -v git)" "$GITBIN/git"
# git itself runs helpers (git-remote-*, sh) from its exec path, which is outside PATH anyway.

# The "GitHub" repo: VERSION plus stub install.sh and scripts/motherapp.sh.
ORIGIN="$TMP/origin.git"
git init -q --bare -b main "$ORIGIN"
SEED="$TMP/seed"
git clone -q "$ORIGIN" "$SEED" 2>/dev/null
mkdir -p "$SEED/scripts"
echo 2 >"$SEED/VERSION"
cat >"$SEED/install.sh" <<'EOF'
#!/usr/bin/env bash
echo "install.sh $* (cwd=$PWD)" >>"$FAKE/calls"
echo "fake installer ran"
EOF
cat >"$SEED/scripts/motherapp.sh" <<'EOF'
#!/usr/bin/env bash
echo "motherapp.sh $* (dir=$(cd "$(dirname "$0")/.." && pwd -P))" >>"$FAKE/calls"
echo "fake motherapp ran"
EOF
git -C "$SEED" checkout -q -b main 2>/dev/null
git -C "$SEED" add -A && git -C "$SEED" commit -q -m "first" && git -C "$SEED" push -q origin main 2>/dev/null

new_case() {
  CASE="$1" C="$TMP/$1"
  HOME_="$C/home" FAKE="$C/fake" STUB="$C/stub"
  mkdir -p "$HOME_" "$FAKE" "$STUB"
  : >"$FAKE/calls"
  printf '#!/bin/sh\n[ "$1" = -u ] && echo 1000\n' >"$STUB/id"
  printf '#!/bin/sh\nexit 0\n' >"$STUB/curl"
  chmod +x "$STUB/id" "$STUB/curl"
  EXTRA_ENV=() WITH_GIT=1
}

run_get() { # stdin is passed through
  local path="$STUB:$SYSBIN"
  (( WITH_GIT )) && path="$path:$GITBIN"
  OUT="$C/out.$RANDOM"
  (cd "$C" && "$ENV_BIN" -i HOME="$HOME_" PATH="$path" FAKE="$FAKE" MOTHERAPP_REPO_URL="$ORIGIN" \
    GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null "${EXTRA_ENV[@]}" bash -c "$GET_SH") >"$OUT" 2>&1
  CODE=$?
}

fail() {
  FAILED=$((FAILED + 1))
  printf 'not ok - %s: %s\n' "$CASE" "$1"
  [[ -f $OUT ]] && sed 's/^/    | /' "$OUT"
  printf '    calls:\n'; sed 's/^/    > /' "$FAKE/calls"
}
pass() { PASSED=$((PASSED + 1)); printf 'ok - %s: %s\n' "$CASE" "$1"; }
check() { local d=$1; shift; if "$@"; then pass "$d"; else fail "$d"; fi; }
out_has() { grep -qE -- "$1" "$OUT"; }
calls_has() { grep -qF -- "$1" "$FAKE/calls"; }
calls_empty() { [[ ! -s $FAKE/calls ]]; }
exit_is() { [[ $CODE == "$1" ]]; }

DEF() { printf '%s' "$HOME_/.local/share/motherapp"; }

# ------------------------------------------------------------------ cases

new_case fresh
run_get </dev/null
check "exit 0 (the installer's code)" exit_is 0
check "cloned into ~/.local/share/motherapp" test -f "$(DEF)/VERSION"
check "on main" test "$(git -C "$(DEF)" symbolic-ref --short HEAD)" = main
check "ran ./install.sh in the clone, no options" calls_has "install.sh  (cwd=$(DEF))"
check "installer output shown" out_has '^fake installer ran$'
check "says where it clones" out_has "^motherapp-get: cloning .* into $(DEF)\$"
check "update not run" bash -c '! grep -q motherapp.sh "$1"' _ "$FAKE/calls"

new_case fresh-custom-dir
EXTRA_ENV=(MOTHERAPP_DIR="$C/src/my motherapp")
run_get </dev/null
check "MOTHERAPP_DIR: cloned there (space in the path)" test -f "$C/src/my motherapp/install.sh"
check "MOTHERAPP_DIR: installer ran there" calls_has "install.sh  (cwd=$C/src/my motherapp)"
check "MOTHERAPP_DIR: default dir untouched" test ! -e "$(DEF)"

new_case empty-dir
mkdir -p "$(DEF)"
run_get </dev/null
check "an empty dir: cloned into it" test -f "$(DEF)/install.sh"
check "an empty dir: installer ran" calls_has "install.sh  (cwd=$(DEF))"

new_case existing
git clone -q "$ORIGIN" "$(DEF)" 2>/dev/null
echo '{}' >"$(DEF)/build-info.json"
run_get </dev/null
check "existing clone: exit 0" exit_is 0
check "existing clone: runs motherapp install there" calls_has "motherapp.sh install (dir=$(DEF))"
check "existing clone: install.sh not run directly" bash -c '! grep -q "^install.sh" "$1"' _ "$FAKE/calls"
check "existing clone: says it updates" out_has 'already a motherapp clone: updating it \(motherapp install\)'

new_case existing-unbuilt
git clone -q "$ORIGIN" "$(DEF)" 2>/dev/null
run_get </dev/null
check "clone never built: runs ./install.sh" calls_has "install.sh  (cwd=$(DEF))"
check "clone never built: not motherapp install" bash -c '! grep -q motherapp.sh "$1"' _ "$FAKE/calls"

new_case other-dir
mkdir -p "$(DEF)"
echo "mine" >"$(DEF)/notes.txt"
run_get </dev/null
check "not a motherapp dir: exit 1" exit_is 1
check "not a motherapp dir: refuses" out_has "refusing: $(DEF) exists and isn't a motherapp clone"
check "not a motherapp dir: says how to pick another" out_has 'MOTHERAPP_DIR='
check "not a motherapp dir: nothing run" calls_empty
check "not a motherapp dir: left alone" test "$(ls -A "$(DEF)")" = notes.txt

new_case other-git-repo
git init -q "$(DEF)"
echo "x" >"$(DEF)/README"
run_get </dev/null
check "another git repo: refuses" out_has "isn't a motherapp clone"
check "another git repo: nothing run" calls_empty

new_case a-file
mkdir -p "$HOME_/.local/share"
echo x >"$(DEF)"
run_get </dev/null
check "a file in the way: refuses" out_has "exists and isn't a directory"
check "a file in the way: exit 1" exit_is 1

new_case root
printf '#!/bin/sh\n[ "$1" = -u ] && echo 0\n' >"$STUB/id"
run_get </dev/null
check "root: exit 2" exit_is 2
check "root: refuses" out_has "don't run this as root or with sudo"
check "root: nothing cloned" test ! -e "$(DEF)"

new_case no-git
WITH_GIT=0
run_get </dev/null
check "no git: exit 1" exit_is 1
check "no git: names it" out_has "needs git, which isn't installed"
check "no git: gives the fix" out_has 'sudo apt-get install git$'
check "no git: nothing cloned" test ! -e "$(DEF)"

new_case no-curl
rm "$STUB/curl"
run_get </dev/null
check "no curl: names it" out_has "needs curl"
check "no curl: exit 1" exit_is 1

new_case bad-url
EXTRA_ENV=(MOTHERAPP_REPO_URL="$C/nowhere.git")
run_get </dev/null
check "clone fails: exit 1" exit_is 1
check "clone fails: says so" out_has 'git clone failed'
check "clone fails: installer not run" calls_empty

new_case moved
mkdir -p "$HOME_/.config/systemd/user" "$C/old"
printf '[Service]\nWorkingDirectory=%s\n' "$C/old" >"$HOME_/.config/systemd/user/motherapp.service"
run_get </dev/null
check "installed elsewhere, no answer: exit 1" exit_is 1
check "installed elsewhere: says where" out_has "already installed from $C/old"
check "installed elsewhere, no answer: nothing cloned" test ! -e "$(DEF)"
run_get <<<"y"
check "installed elsewhere, yes: cloned and installed" calls_has "install.sh  (cwd=$(DEF))"

printf '\n%d passed, %d failed\n' "$PASSED" "$FAILED"
(( FAILED == 0 ))
