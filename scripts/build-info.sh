#!/usr/bin/env bash
# The motherapp version string, v<N>-<hash>[-dirty]:
#   <N>      the hand-bumped number in VERSION (bump it by hand; nothing else is shown)
#   <hash>   the short git hash of HEAD ("unknown" outside a git checkout)
#   -dirty   when `git status --porcelain` isn't empty
#
#   bash scripts/build-info.sh           print the version string of the checkout
#   bash scripts/build-info.sh --write   also write build-info.json (gitignored) at the repo
#                                        root: {"version","hash","dirty","builtAt"}; the core
#                                        reads it to say what it was built from
#
# Run by `npm run build` and ./install.sh. scripts/motherapp.sh sources it for the mbi_*
# functions (sourcing runs nothing).

mbi_repo() { (cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P); }

# The number in VERSION, or "?" when it is missing or not a plain number.
mbi_number() { # repo
  local n=""
  [[ -r $1/VERSION ]] && IFS= read -r n <"$1/VERSION"
  n="${n//[[:space:]]/}"
  if [[ $n =~ ^[0-9]+$ ]]; then printf '%s' "$n"; else printf '?'; fi
}

# Short hash of HEAD (7 or more characters), or "unknown".
mbi_hash() { # repo
  local h
  if h="$(git -C "$1" rev-parse --short=7 HEAD 2>/dev/null)" && [[ $h =~ ^[0-9a-f]{7,}$ ]]; then
    printf '%s' "$h"
  else
    printf 'unknown'
  fi
}

# "true" when the work tree has changes (tracked or untracked), "false" otherwise or outside git.
mbi_dirty() { # repo
  local s
  if s="$(git -C "$1" status --porcelain 2>/dev/null)" && [[ -n $s ]]; then printf 'true'; else printf 'false'; fi
}

mbi_format() { # number hash dirty
  printf 'v%s-%s' "$1" "$2"
  [[ $3 == true ]] && printf -- '-dirty'
  return 0
}

mbi_string() { # repo
  mbi_format "$(mbi_number "$1")" "$(mbi_hash "$1")" "$(mbi_dirty "$1")"
}

# One field of a build-info.json written by mbi_write (a fixed format, so no JSON parser is
# needed). Prints nothing and fails when the file or the field is missing.
mbi_field() { # file name
  local v
  [[ -f $1 ]] || return 1
  v="$(sed -n "s/^[[:space:]]*\"$2\":[[:space:]]*\"\{0,1\}\([^\",]*\)\"\{0,1\},\{0,1\}[[:space:]]*\$/\1/p" "$1" | head -n1)"
  [[ -n $v ]] && printf '%s' "$v"
}

# The version string recorded in a build-info.json, or fails when there is none.
mbi_built() { # file
  local h
  h="$(mbi_field "$1" hash)" || return 1
  mbi_format "$(mbi_field "$1" version || printf '?')" "$h" "$(mbi_field "$1" dirty)"
}

# Writes <repo>/build-info.json atomically and prints the version string.
mbi_write() { # repo
  local n h d at file="$1/build-info.json"
  n="$(mbi_number "$1")" h="$(mbi_hash "$1")" d="$(mbi_dirty "$1")"
  at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  # Every value is a digit string, "?", hex, "unknown" or a bool: nothing needs JSON escaping.
  if ! printf '{\n  "version": "%s",\n  "hash": "%s",\n  "dirty": %s,\n  "builtAt": "%s"\n}\n' "$n" "$h" "$d" "$at" \
    >"$file.tmp.$$" || ! mv -f "$file.tmp.$$" "$file"; then
    rm -f "$file.tmp.$$"
    return 1
  fi
  mbi_format "$n" "$h" "$d"
  printf '\n'
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  set -uo pipefail
  repo="$(mbi_repo)"
  case "${1:-}" in
    "") mbi_string "$repo"; printf '\n' ;;
    --write) mbi_write "$repo" || { echo "build-info.sh: couldn't write $repo/build-info.json" >&2; exit 1; } ;;
    *) echo "usage: bash scripts/build-info.sh [--write]" >&2; exit 2 ;;
  esac
fi
