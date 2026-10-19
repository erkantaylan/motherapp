# motherapp

A locally served control panel for my Linux desktop: an always-running background service with a
web UI (sidebar + sections). The core is a generic manager; every feature — audio, monitor
brightness, and later logs, storage, networking — is an independent CLI tool that also works on
its own, and the manager is just a UI over them.

Design phase. See [DESIGN.md](DESIGN.md) for what is decided and what is still open.

`reference/audio-switch/` holds the predecessor app (Python, GTK4/libadwaita) for context.
