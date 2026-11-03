#!/bin/bash
# motherapp energy counter access (AMD), run as root by udev for each powercap device that
# appears (/etc/udev/rules.d/70-motherapp-energy.rules, rendered by install.sh from
# packaging/motherapp-energy.rules). install.sh copies this file to
# /usr/local/lib/motherapp/energy-access (root-owned, so the user can't change what root runs).
#
# Gives GROUP read access to one file: energy_uj of a package RAPL zone (intel-rapl:N or
# intel-rapl-mmio:N whose name starts with "package"), for the package power the CPU page shows.
# The kernel keeps it root-only because power readings are a side channel (CVE-2020-8694).
# Read only: nothing becomes writable, no other file changes, no values are written. Subzones
# (intel-rapl:0:0, the cores) are refused: the rule's KERNEL glob matches them too.
# sysfs permissions don't survive a reboot; udev runs this again for every boot (and for every
# zone the kernel adds later). udev's GROUP= and MODE= only apply to device nodes, not to sysfs
# attributes, which is why this is a RUN+= helper.
#
# Usage: energy-access GROUP ZONE    (ZONE = the kernel name, udev's %k, e.g. intel-rapl:0)
# MOTHERAPP_ENERGY_ACCESS_ROOT=<dir> works on <dir>/sys instead of /sys (tests only).
set -u

group=${1:-} zone=${2:-}
if [[ $# -ne 2 || ! $group =~ ^[a-z_][a-z0-9_-]*$ ]]; then
  echo "energy-access: usage: energy-access GROUP ZONE" >&2
  exit 2
fi
if [[ ! $zone =~ ^intel-rapl(-mmio)?:[0-9]+$ ]]; then
  echo "energy-access: \"$zone\" is not a package zone (intel-rapl:N or intel-rapl-mmio:N); nothing changed" >&2
  exit 2
fi
if ! getent group "$group" >/dev/null; then
  echo "energy-access: no group \"$group\"" >&2
  exit 2
fi

z=${MOTHERAPP_ENERGY_ACCESS_ROOT:-}/sys/class/powercap/$zone
name=""
[[ -f $z/name ]] && name=$(<"$z/name")
if [[ $name != package* ]]; then
  echo "energy-access: $zone is \"${name:-?}\", not a package zone; nothing changed"
  exit 0
fi
f=$z/energy_uj
if [[ ! -f $f || -L $f ]]; then
  echo "energy-access: $zone has no energy_uj; nothing changed"
  exit 0
fi
if chgrp "$group" "$f" && chmod g+r "$f"; then
  echo "energy-access: group $group may now read $zone/energy_uj"
else
  echo "energy-access: couldn't change $zone/energy_uj" >&2
  exit 1
fi
