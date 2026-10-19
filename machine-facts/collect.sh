#!/usr/bin/env bash
# Collects target-machine facts for DESIGN.md § 6. Read-only: nothing here changes system state.
# Usage: ./collect.sh > raw-output.txt

run() {
    echo "\$ $1"
    bash -c "$1" 2>&1
    echo "[exit $?]"
    echo
}

echo "# collected $(date -Iseconds) on $(hostname)"
echo

echo "## Commands requested in DESIGN.md § 6"
echo
run "lsb_release -ds"
run "wpctl --version"
run "ddcutil --version"
run "pactl info | grep 'Server Name'"
run "ls /usr/lib/*/girepository-1.0/ | grep -i -E '^Wp-'"
run "node --version"
run "bun --version"
run "deno --version"

echo "## Follow-ups (wpctl has no --version, pactl is not installed)"
echo
run "dpkg-query -W -f='\${Package} \${Version} \${db:Status-Status}\n' wireplumber libwireplumber-0.4-0 pipewire pipewire-pulse pulseaudio-utils gir1.2-wp-0.4 gir1.2-wp-0.5 ddcutil libddcutil4 libddcutil-dev"
run "apt-cache policy gir1.2-wp-0.4 pulseaudio-utils | grep -E '^[a-z]|Installed|Candidate'"
run "pipewire --version"
run "systemctl --user is-active pipewire pipewire-pulse.socket pipewire-pulse wireplumber"
run "ls -l \$XDG_RUNTIME_DIR/pulse/native"
run "ls /usr/lib/x86_64-linux-gnu/girepository-1.0/ | grep -iE '^(Wp|Gvc)'"
run "gjs --version"
run "gnome-shell --version"
run "echo \$XDG_SESSION_TYPE"

echo "## DDC/CI: detection and brightness reads, timed"
echo
run "time ddcutil detect --brief"
run "time ddcutil --bus 1 getvcp 10"
run "time ddcutil --bus 3 getvcp 10"
