#!/usr/bin/env python3
"""audio-switch: one-click default output/input switcher for PipeWire, with test buttons."""

import array
import json
import math
import subprocess
import threading
from dataclasses import dataclass

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
from gi.repository import Adw, GLib, Gtk  # noqa: E402

APP_ID = "io.github.kappa.AudioSwitch"
RATE = 48000
CHUNK_BYTES = RATE // 20 * 2  # 50 ms of mono s16
RECORD_SECONDS = 3
REFRESH_SECONDS = 2
SOUNDS = "/usr/share/sounds/freedesktop/stereo"
TEST_SOUNDS = [f"{SOUNDS}/audio-channel-front-left.oga", f"{SOUNDS}/audio-channel-front-right.oga"]


@dataclass(frozen=True)
class Device:
    id: int
    name: str  # node.name, what pw-play/pw-record --target take
    title: str
    subtitle: str


def read_devices():
    """Return (sinks, sources, default sink name, default source name) from pw-dump."""
    dump = json.loads(subprocess.run(["pw-dump"], capture_output=True, text=True, check=True).stdout)
    sinks, sources, defaults = [], [], {}
    for obj in dump:
        if obj["type"] == "PipeWire:Interface:Node":
            props = obj["info"]["props"]
            cls = props.get("media.class")
            if cls not in ("Audio/Sink", "Audio/Source"):
                continue
            desc = props.get("node.description") or props["node.name"]
            dev = Device(obj["id"], props["node.name"], props.get("node.nick") or desc, desc)
            (sinks if cls == "Audio/Sink" else sources).append(dev)
        elif obj["type"] == "PipeWire:Interface:Metadata" and obj.get("props", {}).get("metadata.name") == "default":
            for entry in obj.get("metadata") or []:
                if isinstance(entry.get("value"), dict):  # other keys carry plain ints/strings
                    defaults[entry["key"]] = entry["value"].get("name")
    key = lambda d: d.title.lower()
    return (sorted(sinks, key=key), sorted(sources, key=key),
            defaults.get("default.audio.sink"), defaults.get("default.audio.source"))


class MicReader:
    """Streams mono s16 from a source via pw-record, calling on_chunk(bytes) on a worker thread."""

    def __init__(self, target, on_chunk):
        self.proc = subprocess.Popen(
            ["pw-record", "--target", target, "--format", "s16", "--rate", str(RATE), "--channels", "1", "-"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        threading.Thread(target=self._run, args=(on_chunk,), daemon=True).start()

    def _run(self, on_chunk):
        while chunk := self.proc.stdout.read(CHUNK_BYTES):
            on_chunk(chunk)

    def stop(self):
        if self.proc.poll() is None:
            self.proc.terminate()


def chunk_level(chunk):
    """RMS of an s16 chunk mapped from -60..0 dBFS onto 0..1."""
    samples = array.array("h", chunk[: len(chunk) & ~1])
    if not samples:
        return 0.0
    rms = math.sqrt(sum(s * s for s in samples) / len(samples))
    if rms < 1:
        return 0.0
    return min(1.0, max(0.0, (20 * math.log10(rms / 32768) + 60) / 60))


class Window(Adw.ApplicationWindow):
    def __init__(self, app):
        super().__init__(application=app, title="Audio Switch", default_width=540, default_height=600)
        self.readers = set()
        self.checks = {}  # node.name -> radio CheckButton
        self.layout = None
        self.updating = False

        self.toasts = Adw.ToastOverlay()
        view = Adw.ToolbarView(content=self.toasts)
        view.add_top_bar(Adw.HeaderBar())
        self.set_content(view)

        self.refresh()
        self.timer = GLib.timeout_add_seconds(REFRESH_SECONDS, self.refresh)
        self.connect("close-request", self.on_close)

    def toast(self, text):
        self.toasts.add_toast(Adw.Toast(title=text, timeout=2, use_markup=False))

    def on_close(self, _win):
        GLib.source_remove(self.timer)
        self.stop_readers()
        return False

    def stop_readers(self):
        for reader in list(self.readers):
            reader.stop()
        self.readers.clear()

    # --- device list ---

    def refresh(self):
        try:
            sinks, sources, def_sink, def_source = read_devices()
        except (OSError, subprocess.CalledProcessError, json.JSONDecodeError) as e:
            self.toast(f"pw-dump failed: {e}")
            return GLib.SOURCE_CONTINUE
        layout = (tuple(sinks), tuple(sources))
        if layout != self.layout:
            self.layout = layout
            self.build(sinks, sources)
        self.updating = True
        for name, check in self.checks.items():
            check.set_active(name in (def_sink, def_source))
        self.updating = False
        return GLib.SOURCE_CONTINUE

    def build(self, sinks, sources):
        self.stop_readers()
        self.checks.clear()
        page = Adw.PreferencesPage()
        for title, devices, is_output in (("Output", sinks, True), ("Input", sources, False)):
            group = Adw.PreferencesGroup(title=title)
            if not devices:
                group.add(Adw.ActionRow(title="No devices"))
            first = None
            for dev in devices:
                check = Gtk.CheckButton(valign=Gtk.Align.CENTER)
                if first:
                    check.set_group(first)
                first = first or check
                check.connect("toggled", self.on_toggled, dev)
                self.checks[dev.name] = check

                row = Adw.ActionRow(title=dev.title, subtitle=dev.subtitle)
                row.add_prefix(check)
                row.set_activatable_widget(check)
                for widget in (self.output_tests(dev) if is_output else self.input_tests(dev)):
                    row.add_suffix(widget)
                group.add(row)
            page.add(group)
        self.toasts.set_child(page)

    def on_toggled(self, check, dev):
        if self.updating or not check.get_active():
            return
        result = subprocess.run(["wpctl", "set-default", str(dev.id)], capture_output=True, text=True)
        if result.returncode:
            self.toast(f"Switch failed: {result.stderr.strip() or result.returncode}")
            self.refresh()
        else:
            self.toast(f"Switched to {dev.title}")

    # --- output test ---

    def output_tests(self, dev):
        button = Gtk.Button(icon_name="media-playback-start-symbolic", valign=Gtk.Align.CENTER,
                            tooltip_text="Play left/right test sound on this device")
        button.add_css_class("flat")
        button.connect("clicked", self.on_play_test, dev)
        return [button]

    def on_play_test(self, button, dev):
        button.set_sensitive(False)

        def play():
            for sound in TEST_SOUNDS:
                subprocess.run(["pw-play", "--target", dev.name, sound], stderr=subprocess.DEVNULL)
            GLib.idle_add(button.set_sensitive, True)

        threading.Thread(target=play, daemon=True).start()

    # --- input tests ---

    def input_tests(self, dev):
        level = Gtk.LevelBar(min_value=0, max_value=1, valign=Gtk.Align.CENTER, visible=False)
        level.set_size_request(110, -1)
        monitor = Gtk.ToggleButton(icon_name="audio-input-microphone-symbolic", valign=Gtk.Align.CENTER,
                                   tooltip_text="Show live mic level")
        monitor.add_css_class("flat")
        monitor.connect("toggled", self.on_monitor, dev, level, {})
        record = Gtk.Button(icon_name="media-record-symbolic", valign=Gtk.Align.CENTER,
                            tooltip_text=f"Record {RECORD_SECONDS} s and play it back on the default output")
        record.add_css_class("flat")
        record.connect("clicked", self.on_record, dev)
        return [level, monitor, record]

    def on_monitor(self, button, dev, level, state):
        if button.get_active():
            state["reader"] = MicReader(dev.name, lambda c: GLib.idle_add(level.set_value, chunk_level(c)))
            self.readers.add(state["reader"])
            level.set_visible(True)
        else:
            state["reader"].stop()
            self.readers.discard(state["reader"])
            level.set_value(0)
            level.set_visible(False)

    def on_record(self, button, dev):
        button.set_sensitive(False)
        self.toast(f"Recording {RECORD_SECONDS} s, speak now")
        buf = bytearray()
        target = RATE * 2 * RECORD_SECONDS

        def on_chunk(chunk):
            if len(buf) >= target:
                return
            buf.extend(chunk)
            if len(buf) >= target:
                reader.stop()
                self.readers.discard(reader)
                GLib.idle_add(self.toast, "Playing back")
                threading.Thread(target=playback, daemon=True).start()

        def playback():
            subprocess.run(["pw-play", "--format", "s16", "--rate", str(RATE), "--channels", "1", "-"],
                           input=bytes(buf[:target]), stderr=subprocess.DEVNULL)
            GLib.idle_add(button.set_sensitive, True)

        reader = MicReader(dev.name, on_chunk)
        self.readers.add(reader)


class App(Adw.Application):
    def __init__(self):
        super().__init__(application_id=APP_ID)

    def do_activate(self):
        (self.props.active_window or Window(self)).present()


if __name__ == "__main__":
    App().run()
