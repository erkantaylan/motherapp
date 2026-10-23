#!/bin/bash
# motherapp CPU limits access, run as root by motherapp-cpu-access.service at boot and after
# every resume. install.sh copies it to /usr/local/lib/motherapp/cpu-access (root-owned, so
# the user can't change what root runs) and passes the user's primary group.
#
# Gives that group write access to these sysfs files only, so the CPU tool can set them
# without sudo: per-CPU clock caps, governor and EPP (cpufreq), turbo (intel_pstate no_turbo or
# cpufreq boost), and the package power limits PL1/PL2 (RAPL). The kernel checks every value
# written to them. Nothing else changes: no voltages, no MSRs, no values are written here.
# sysfs permissions don't survive a reboot, which is why this runs at every boot.
#
# Usage: cpu-access GROUP
# MOTHERAPP_CPU_ACCESS_ROOT=<dir> works on <dir>/sys instead of /sys (tests only).
set -u
shopt -s nullglob

group=${1:-}
if [[ ! $group =~ ^[a-z_][a-z0-9_-]*$ ]]; then
  echo "cpu-access: usage: cpu-access GROUP" >&2
  exit 2
fi
if ! getent group "$group" >/dev/null; then
  echo "cpu-access: no group \"$group\"" >&2
  exit 2
fi

root=${MOTHERAPP_CPU_ACCESS_ROOT:-}
cpu=$root/sys/devices/system/cpu
n=0 failed=0

grant() {
  local f
  for f in "$@"; do
    [[ -f $f && ! -L $f ]] || continue
    if chgrp "$group" "$f" && chmod g+w "$f"; then n=$((n + 1)); else failed=$((failed + 1)); fi
  done
}

for d in "$cpu"/cpufreq/policy[0-9]*; do
  grant "$d"/scaling_max_freq "$d"/scaling_governor "$d"/energy_performance_preference
done
grant "$cpu"/intel_pstate/no_turbo "$cpu"/cpufreq/boost

# Package zones only (intel-rapl:0, intel-rapl-mmio:0), not their core/uncore subzones
# (intel-rapl:0:0), and only the long-term (PL1) and short-term (PL2) constraints.
for z in "$root"/sys/class/powercap/intel-rapl:* "$root"/sys/class/powercap/intel-rapl-mmio:*; do
  [[ ${z##*/} =~ ^intel-rapl(-mmio)?:[0-9]+$ ]] || continue
  for c in "$z"/constraint_[0-9]_name; do
    case $(<"$c") in
      long_term | short_term) grant "${c%_name}_power_limit_uw" ;;
    esac
  done
done

if (( failed )); then
  echo "cpu-access: group $group can now write $n CPU limit file(s); $failed couldn't be changed" >&2
  exit 1
fi
echo "cpu-access: group $group can now write $n CPU limit file(s)"
