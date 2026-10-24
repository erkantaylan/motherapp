#!/bin/bash
# motherapp CPU voltage offset (undervolt), run as root through sudo by the CPU tool.
# install.sh copies it to /usr/local/lib/motherapp/cpu-voltage (root-owned, so the user can't
# change what root runs) and adds a sudoers rule that lets the user run this one file without a
# password (packaging/motherapp-cpu-voltage.sudoers). The tool never gets /dev/cpu/*/msr
# itself: that would be root-equivalent.
#
# It talks to the CPU's overclocking mailbox (MSR 0x150) on Intel Core CPUs, for two voltage
# planes only: core (0) and cache (2), which take the same offset on Raptor Lake. It only
# accepts offsets from 0 down to -150 mV: never a positive one (overvolting). Offsets don't
# survive a reboot. Needs msr-tools (rdmsr, wrmsr) and the BIOS's "Undervolt Protection" off;
# with it on, the CPU ignores the offset, and `set` says so.
#
# Usage: cpu-voltage read          prints "core <mV>" and "cache <mV>"
#        cpu-voltage set <mV>      sets both, prints them as read back (mV: -150..0)
# Exit codes: 0 ok, 2 usage, 3 the CPU didn't take the offset, 4 can't talk to the CPU.
# MOTHERAPP_CPU_VOLTAGE_TEST=1 (tests only; sudo drops it): no root check, no modprobe, rdmsr
# and wrmsr from $PATH, /proc/cpuinfo under $MOTHERAPP_CPU_VOLTAGE_ROOT.
set -u
MIN_MV=-150
MB=0x150

if [[ ${MOTHERAPP_CPU_VOLTAGE_TEST:-} == 1 ]]; then
  root=${MOTHERAPP_CPU_VOLTAGE_ROOT:-}
else
  export PATH=/usr/sbin:/usr/bin:/sbin:/bin
  root=
  if [[ $(id -u) != 0 ]]; then
    echo "cpu-voltage: run as root (sudo)" >&2
    exit 4
  fi
fi

usage() {
  echo "cpu-voltage: usage: cpu-voltage read | cpu-voltage set <mV>   (mV: whole number, $MIN_MV..0)" >&2
  exit 2
}

case ${1:-} in
  read) (( $# == 1 )) || usage ;;
  set)
    (( $# == 2 )) || usage
    [[ $2 =~ ^(0|-[1-9][0-9]{0,2})$ ]] || usage
    (( $2 >= MIN_MV )) || usage
    ;;
  *) usage ;;
esac

if ! grep -q '^vendor_id[[:space:]]*:[[:space:]]*GenuineIntel' "$root/proc/cpuinfo" 2>/dev/null; then
  echo "cpu-voltage: not an Intel CPU" >&2
  exit 4
fi
for t in rdmsr wrmsr; do
  type -P $t >/dev/null || { echo "cpu-voltage: $t is missing: sudo apt-get install msr-tools" >&2; exit 4; }
done
if [[ ${MOTHERAPP_CPU_VOLTAGE_TEST:-} != 1 ]] && ! modprobe msr 2>/dev/null; then
  echo "cpu-voltage: can't load the msr kernel module" >&2
  exit 4
fi

# One mailbox command (bit 63 = run, bits 39:32 = command, 47:40 = plane), then its answer: bits
# 39:32 of the answer are the error code (0 = done).
mailbox() { # value -> answer (hex) on stdout
  local v
  wrmsr -p 0 $MB "$(printf '0x%x' "$1")" || return 1
  v=$(rdmsr -p 0 -c $MB) || return 1
  if (( (v >> 32) & 0xFF )); then
    echo "cpu-voltage: the CPU's mailbox answered error $(( (v >> 32) & 0xFF ))" >&2
    return 1
  fi
  printf '%s\n' "$v"
}

read_plane() { # plane -> mV, rounded to whole mV
  local v f
  v=$(mailbox $(( 0x8000001000000000 | ($1 << 40) ))) || return 1
  f=$(( (v >> 21) & 0x7FF ))
  (( f > 0x3FF )) && f=$(( f - 0x800 ))
  # 1/1.024 mV units; round half away from zero
  if (( f < 0 )); then echo $(( -((-f * 1000 + 512) / 1024) )); else echo $(( (f * 1000 + 512) / 1024 )); fi
}

set_plane() { # plane mV (<= 0)
  local mv=$2 f
  f=$(( -((-mv * 1024 + 500) / 1000) ))
  mailbox $(( 0x8000001100000000 | ($1 << 40) | ((f & 0x7FF) << 21) )) >/dev/null
}

report() {
  local core cache
  core=$(read_plane 0) && cache=$(read_plane 2) || { echo "cpu-voltage: can't read the voltage offsets" >&2; exit 4; }
  echo "core $core"
  echo "cache $cache"
  CORE=$core CACHE=$cache
}

if [[ $1 == read ]]; then
  report
  exit 0
fi

set_plane 0 "$2" && set_plane 2 "$2" || { echo "cpu-voltage: writing the offset failed" >&2; exit 4; }
report
if (( CORE != $2 || CACHE != $2 )); then
  echo "cpu-voltage: the CPU didn't take $2 mV (it reads core $CORE mV, cache $CACHE mV): turn off \"Undervolt Protection\" (and \"IA CEP Support\") in the BIOS" >&2
  exit 3
fi
