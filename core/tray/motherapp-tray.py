#!/usr/bin/env python3
"""motherapp's tray icon (DESIGN.md § 3 "Tray icon"). Started and supervised by the core
(core/src/tray.ts); not meant to be run by hand, and it knows nothing about motherapp beyond
what the core tells it.

    motherapp-tray.py <ok-icon.png> <warning-icon.png>

Protocol: JSON lines over stdio, nothing else is ever written to stdout.

  core -> helper (stdin), always the whole view, so a line can be repeated or lost safely:
    {"icon": "ok" | "warn", "status": "6 tools running", "muted": false}

  helper -> core (stdout):
    {"event": "ready"}                       the indicator exists
    {"event": "host", "connected": bool}     a tray host shows the icon / none does (sent ~3 s
                                             after start and whenever it changes)
    {"event": "open"}                        "Open motherapp" was clicked
    {"event": "mute", "muted": bool}         the user ticked or unticked "Mute notifications"
    {"event": "unavailable", "reason": "...", "retry": bool}
                                             can't run; the helper exits right after. retry
                                             false: something isn't installed, don't try again

The helper exits when stdin closes (the core is gone) or on SIGTERM, so it never outlives
the core, inside or outside the systemd unit.
"""
import json
import os
import signal
import sys


def emit(obj):
    try:
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()
    except (BrokenPipeError, OSError):
        os._exit(0)  # the core is gone


def unavailable(reason, retry=False):
    emit({"event": "unavailable", "reason": reason, "retry": retry})
    sys.exit(3)


if len(sys.argv) != 3:
    sys.stderr.write("usage: motherapp-tray.py <ok-icon.png> <warning-icon.png>\n")
    sys.exit(2)
ICONS = {"ok": sys.argv[1], "warn": sys.argv[2]}

try:
    import gi
except ImportError:
    unavailable("the Python module gi is missing (Ubuntu package: python3-gi)")
try:
    gi.require_version("Gtk", "3.0")
    from gi.repository import GLib, Gtk
except (ValueError, ImportError):
    unavailable("GTK 3 for Python is missing (Ubuntu package: gir1.2-gtk-3.0)")
try:
    gi.require_version("AyatanaAppIndicator3", "0.1")
    from gi.repository import AyatanaAppIndicator3 as AppIndicator
except (ValueError, ImportError):
    unavailable("the AyatanaAppIndicator3 typelib is missing (Ubuntu package: gir1.2-ayatanaappindicator3-0.1)")

if not Gtk.init_check(None)[0]:
    # At login the service can start before the session has a display.
    unavailable("no display to connect to (WAYLAND_DISPLAY / DISPLAY)", retry=True)

indicator = AppIndicator.Indicator.new("motherapp", ICONS["ok"], AppIndicator.IndicatorCategory.APPLICATION_STATUS)
indicator.set_title("motherapp")

menu = Gtk.Menu()
open_item = Gtk.MenuItem(label="Open motherapp")
mute_item = Gtk.CheckMenuItem(label="Mute notifications")
status_item = Gtk.MenuItem(label="Starting…")
status_item.set_sensitive(False)
for item in (open_item, mute_item, Gtk.SeparatorMenuItem(), status_item):
    menu.append(item)
menu.show_all()

open_item.connect("activate", lambda _item: emit({"event": "open"}))
mute_handler = mute_item.connect("toggled", lambda item: emit({"event": "mute", "muted": item.get_active()}))

indicator.set_menu(menu)
indicator.set_status(AppIndicator.IndicatorStatus.ACTIVE)

current_icon = "ok"


def apply(view):
    """One line from the core. Unknown or malformed parts are ignored."""
    global current_icon
    if not isinstance(view, dict):
        return
    icon = view.get("icon")
    if icon in ICONS and icon != current_icon:
        current_icon = icon
        indicator.set_icon_full(ICONS[icon], "motherapp" if icon == "ok" else "motherapp: a tool needs attention")
    status = view.get("status")
    if isinstance(status, str) and status != status_item.get_label():
        status_item.set_label(status)
    muted = view.get("muted")
    if isinstance(muted, bool) and muted != mute_item.get_active():
        # The core's value, not a click: don't report it back.
        mute_item.handler_block(mute_handler)
        mute_item.set_active(muted)
        mute_item.handler_unblock(mute_handler)


buffer = b""


def on_stdin(fd, condition):
    global buffer
    if condition & GLib.IO_IN:
        try:
            chunk = os.read(fd, 65536)
        except BlockingIOError:
            return True
        except OSError:
            chunk = b""
        if chunk:
            buffer += chunk
            *lines, buffer = buffer.split(b"\n")
            for line in lines:
                try:
                    apply(json.loads(line))
                except ValueError:
                    pass
            return True
    Gtk.main_quit()  # EOF or hang-up: the core is gone
    return False


def report_host():
    emit({"event": "host", "connected": bool(indicator.get_property("connected"))})
    return False


def quit_on_signal():
    Gtk.main_quit()
    return False


os.set_blocking(0, False)
GLib.io_add_watch(0, GLib.PRIORITY_DEFAULT, GLib.IO_IN | GLib.IO_HUP | GLib.IO_ERR, on_stdin)
GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGTERM, quit_on_signal)
GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGINT, quit_on_signal)
indicator.connect("connection-changed", lambda _ind, connected: emit({"event": "host", "connected": bool(connected)}))
GLib.timeout_add(3000, report_host)

emit({"event": "ready"})
Gtk.main()
