# Extension contract: how to write a motherapp tool

A tool is a standalone CLI that also has a long-running `serve` mode. The core starts
`serve` once, talks JSON-RPC 2.0 over its stdin/stdout, caches its state, and renders its page.
The source of truth for the design is `DESIGN.md` (§ 4.1, § 4.6–4.9, § 4.12). The types for every
message are in `packages/protocol/src/` (`tool.ts`, `layout.ts`, `ui.ts`, `page.ts`).
`tools/demo/` is a working example of everything below.

## 1. Layout on disk

```
tools/<id>/
  manifest.json
  <id>.ts         CLI entry; `serve` is one of its subcommands
  package.json    {"type": "module", "dependencies": {"@motherapp/tool-sdk": "*"}}
  page.ts         only for a custom page
```

`manifest.json`:

```json
{ "id": "audio", "title": "Audio", "icon": "🔊", "serve": ["node", "audio.ts", "serve"] }
```

| Field | Meaning |
|---|---|
| `id` | `[a-z0-9][a-z0-9_-]*`, unique, `core` is reserved. Also the state file name and the log tag. |
| `title`, `icon` | Sidebar entry. `icon` is text (an emoji) or a file in the tool dir ending in `.svg`/`.png`. |
| `serve` | Command line, relative to the tool dir. `"node"` means the Node that runs the core (so systemd's PATH doesn't matter). A command with a `/` is resolved against the tool dir. Any language works. |
| `page` | Optional custom page module (see § 6). |
| `defaultEnabled` | Optional, default `true`. Whether the tool is enabled when first discovered. |
| `bin` | Optional. `{ "<command>": "<script relative to the tool dir>" }`, e.g. `{"audioctl": "audioctl.ts"}`. For each entry `install.sh` writes `~/.local/bin/<command>`, a bash wrapper that runs the script with the installer's Node 24 by absolute path (so an older `node` on PATH or a keyboard shortcut's minimal PATH doesn't matter), and `--uninstall` removes it. The script must be a Node script; the command name matches `[A-Za-z0-9][A-Za-z0-9._-]*` and must be unique across tools. The core ignores this field. |

| `commands` | Optional. Suggested invocations of the tool's `bin` commands that are worth binding to a key: `{ "<command>": [{ "title": "<what it does>", "args": ["<arg>", …] }] }`, keyed by a command from `bin`. The shortcuts tool (`tools/shortcuts/`) offers them in its "Suggested command" list and writes the command as the `~/.local/bin` wrapper's absolute path plus the quoted `args`. Keep `title` short and imperative. The core and the installer ignore this field. |

```json
"bin": { "audioctl": "audioctl.ts" },
"commands": {
  "audioctl": [
    { "title": "Mute/unmute Firefox", "args": ["app-mute", "firefox", "toggle"] },
    { "title": "Firefox volume up", "args": ["app-volume", "firefox", "+10"] }
  ]
}
```

The core reads `tools/*/manifest.json` at startup. Enabled/disabled is stored in
`~/.config/motherapp/config.json` (`{"port": 7323, "tools": {"<id>": {"enabled": true}}}`) and can
be changed on the Settings page. Unknown manifest fields are ignored. After adding a tool, run `npm install` once at the repo root
(the tool is a workspace) and restart the core.

## 2. Serve mode: messages

One JSON-RPC 2.0 message per line. Requests go core → tool and must be answered; notifications
go tool → core. **Nothing else may be written to stdout.** stderr is fine: every stderr line
becomes a log entry with level `error`.

| Message | Kind | Params → result |
|---|---|---|
| `describe` | request | → `{ title, icon?, page: "declarative" \| "custom", layout? }` |
| `state.get` | request | → `{ state: {...}, stale?: string[] }` full snapshot |
| `action` | request | `{ name, args? }` → any JSON, or error `{ code, message }` |
| `stream.open` / `stream.close` | request | `{ name }` → `null` |
| `state` | notification | `{ changes: [{ path, value, stale? }] }` |
| `progress` | notification | `{ id, text, fraction? }`, `id` = the action request's id |
| `stream` | notification | `{ name, value }`, only while open, never cached, ≤ ~20 Hz |
| `log` | notification | `{ level: "debug"\|"info"\|"warn"\|"error", msg, fields? }` |

Startup: the core sends `describe`, then `state.get` (10 s timeout each; failure counts as a
crash). Only then is the tool `running`. Actions time out after 30 s. Error message strings are
shown to the user on the failed dot, so write them for humans. Codes: `-32000` action failed
(the SDK's default for a thrown `Error`), `-32602` invalid params, `-32601` unknown
action/method; the core itself uses `-32001` timeout, `-32002` tool unavailable,
`-32003` unknown tool.

### State, paths and deltas

- State is a JSON object. A **path** is a dotted key string: `"defaultSink"`,
  `"sinks.42.volume"`. Keys must not contain `.`, so key maps by ids (PipeWire object ids,
  bus numbers), not by names.
- A change sets the value at its path, creating parent objects as needed. **`value: null`
  deletes the key**; state never stores `null`.
- Send small deltas (`{"path": "sinks.42.volume", "value": 0.6}`), not whole objects.
- **Stale**: `stale: true` on a change marks the value unconfirmed; a change without it
  confirms it. A stale path covers everything below it. While a tool is down or the UI is
  disconnected, the UI shows everything as stale anyway.
- The core caches the full state; page loads never reach the tool. After a crash the cache is
  kept (shown stale) until the restarted tool's `state.get` replaces it.

### Crash handling (core side)

Any exit the core didn't ask for is a crash: restart after 1 s, 2 s, 4 s … capped at 30 s
(the backoff resets after a run of ≥ 60 s). The 5th crash within 2 minutes stops retrying;
the tool shows `failed` and a Restart button. Shutdown/disable sends SIGTERM, then SIGKILL
after 3 s. If stdin closes, exit.

## 3. The SDK (`@motherapp/tool-sdk`)

```ts
import { createTool, RpcError } from "@motherapp/tool-sdk";
import type { Widget } from "@motherapp/tool-sdk";

const tool = createTool({
  id: "brightness",            // must equal manifest id
  title: "Brightness",
  layout: [/* Widget[] */],
  initialState: { monitors: {} },
  // persist: true (default)   -> $XDG_STATE_HOME/motherapp/brightness.json
});

tool.action("setBrightness", async (args, ctx) => {
  const id = String(args.id), value = Number(args.value);
  if (!Number.isFinite(value)) throw new RpcError(-32602, "value must be a number");
  ctx.progress("writing…", 0.5);           // optional
  await writeMonitor(id, value);
  tool.set(`monitors.${id}.brightness`, value);   // publishes a delta, marks it fresh
});

tool.stream("level", ({ name, param, emit }) => {   // matches "level" and "level/<param>"
  const t = setInterval(() => emit(readLevel(param)), 50);
  return () => clearInterval(t);                    // called on stream.close / shutdown
});

if (process.argv[2] === "serve") {
  const serving = tool.serve();   // starts reading stdin; resolves after shutdown
  tool.log.info("serving");       // log after serve(): before it, logs go to stderr
  await serving;
} else {
  // plain CLI subcommands here (they must work without the core)
}
```

| API | Notes |
|---|---|
| `tool.get(path?)` | Current value (`""` = whole state). |
| `tool.set(path, value, { stale? })` | Sets + publishes. Changes made in the same tick go out as one `state` notification. Values are copied. |
| `tool.delete(path)` | Sends `value: null`. |
| `tool.markStale(path)` / `tool.markFresh(path)` / `tool.isStale(path)` | Stale bit without changing the value. |
| `tool.action(name, handler)` | `handler(args, { id, progress })`; return value is the result, a throw is the error. |
| `tool.stream(name, handler)` | See above. |
| `tool.log.debug/info/warn/error(msg, fields?)` | `log` notification. While serving, `console.log/info/debug/warn` are routed here too; `console.error` goes to stderr (→ level error). |
| `tool.save()` | Write the state file now (otherwise debounced 500 ms, and on shutdown). |
| `readPersistedState(id)` | For plain CLI subcommands that want the last known state. |

**Persistence.** On construction the SDK loads `$XDG_STATE_HOME/motherapp/<id>.json`
(default `~/.local/state/motherapp/`) over `initialState` and **marks every loaded top-level key
stale**. Re-read the real value and `set` it (or `markFresh` keys your process owns, like the
demo does). The file is written atomically. Settings a tool needs belong in
`~/.config/motherapp/` (its own file), not in the state file.

## 4. Declarative layout

`layout` is a `Widget[]` rendered top to bottom. Controls bind to a state path (`bind`) and name
an action. When the user changes a control, the action is called with `{ ...args, value }`.

| Widget | Fields |
|---|---|
| `text` | `text?` (static), `bind?` (shown value), `style?: "heading" \| "body" \| "muted"` |
| `button` | `label`, `action?`, `args?`, `style?: "default" \| "primary" \| "danger"`, `confirm?`, `copy?` — sends `args`. `action` is required unless `copy` is set. See "Buttons: confirm and copy" below. |
| `toggle` | `label?`, `bind`, `action`, `args?` — `value: boolean` |
| `slider` | `label?`, `bind`, `action`, `min`, `max`, `step?`, `unit?`, `args?` — `value: number` |
| `radio` | `label?`, `bind`, `action`, `args?`, and either `options: [{value,label}]` (a group) or `value` (one button, checked when `state[bind] == value`; buttons sharing a `bind` form one group — use this inside list rows for "default device") |
| `meter` | `label?`, `stream?` or `bind?`, `min?` (0), `max?` (1), `manual?` (shows a Monitor button; the stream is only open while it is on). Without `manual` the stream is open while the meter is on screen. |
| `list` | `label?`, `bind`, `item: { label?, sublabel?, widgets? }`, `sort?` (item field), `empty?` |

**Lists** bind to an **object map** `{ [key]: item }`. Rows are keyed by the map key and
updated in place: a volume change on one row touches only that slider; rows appearing or
vanishing don't rebuild the others; a slider being dragged is never overwritten. Inside `item`,
every string may use `{key}`, `{path}` (`<bind>.<key>`) and `{field}` (a field of the item):

```json
{ "type": "list", "bind": "sinks", "sort": "description",
  "item": { "label": "{description}", "sublabel": "{name}",
            "widgets": [
              { "type": "radio", "bind": "defaultSink", "value": "{key}", "action": "setDefault", "args": { "id": "{key}" } },
              { "type": "slider", "bind": "sinks.{key}.volume", "action": "setVolume", "args": { "id": "{key}" }, "min": 0, "max": 1.5, "step": 0.01 },
              { "type": "meter", "stream": "level/{key}", "manual": true }
            ] } }
```

**Buttons: confirm and copy.** A click runs these steps in order:

1. **`confirm: string`**: an in-page dialog (a native `<dialog>` styled as a Bootstrap dialog,
   not `window.confirm`) shows
   this text with Cancel (focused) and a button carrying the widget's `label`. Cancel or Escape
   stops here: nothing is copied and no action is sent. A button with `confirm` gets the
   `danger` style unless it sets `style` itself.
2. **`copy: string | { bind: string }`**: copies text to the clipboard, in the browser, with no
   tool round-trip. A string is the text; `{ bind }` copies the value at that state path at
   click time (objects as JSON). It uses `navigator.clipboard.writeText` (127.0.0.1 is a secure
   context). Where that is missing or refused, e.g. over plain-HTTP LAN access, it falls back
   to a hidden textarea and `document.execCommand("copy")`, and failing that shows the text
   selected with "press Ctrl+C". A "Copied to the clipboard" toast shows for 1.5 s. A
   copy-only button has no status dot.
3. **`action`**: sends `args` as usual (status dot and all).

Inside a list row, `confirm` and a string `copy` are interpolated **when clicked**, against
the row's item at that moment, so `"Remove '{name}'?"` follows a rename. Everything else in a
row's widgets (including `args` and a `copy.bind` path) is interpolated once, when the row is
created, so use the row's stable `{key}` there. Outside a list, placeholders become empty
strings. Values are shown as plain text, never HTML. Text a template can't build (say, a
shell-quoted command) belongs in a state field, e.g. `copy: { bind: "sessions.{key}.attachCommand" }`.

```json
{ "type": "button", "label": "Kill", "action": "kill", "args": { "id": "{key}" },
  "confirm": "Kill tmux session '{name}'?{attachedNote}" }
```

`tools/demo/` uses all three forms; `tools/tmux/` uses `copy: { bind }` and `confirm`.

**Status dots** come for free: *setting* while the request is out, *set* on success, *failed*
on error (message on hover). Slider values sent while a request is in flight are coalesced:
only the newest is sent when the reply arrives, so slow devices aren't flooded. Reply only
after the change is applied (or failed); then publish the real value via `set`.

## 5. Logs

All log entries share one shape (`LogEntry` in `ui.ts`): `{ seq, ts, level, tool, src, msg,
fields? }` where `src` is `core` (start/exit/crash/restart, written by the core about your
tool), `tool` (your `log` notifications) or `stderr`. They go to the core's stdout (journald),
to `~/.local/state/motherapp/log.jsonl` (5 MiB, 2 rotated files) and to the Logs page.

## 6. Custom pages (escape hatch)

Set `"page": "page.ts"` in the manifest and return `page: "custom"` from `describe`. The module
must default-export a custom element class; the shell defines it as `ma-page-<id>`, sets
`ctx` (`PageContext` from `@motherapp/protocol/page`) and attaches it. The core serves files
under `/tools/<id>/` (`.ts` is type-stripped on the fly; relative `./x.ts` imports work; use
`import type` only for packages, since bare imports don't resolve in the browser).

```ts
import type { PageContext } from "@motherapp/protocol/page";
export default class AudioPage extends HTMLElement {
  ctx?: PageContext;
  private off: (() => void)[] = [];
  connectedCallback() {
    const ctx = this.ctx!;
    this.off.push(ctx.subscribe("sinks", (v) => { /* update in place */ }));
    this.off.push(ctx.render([{ type: "slider", bind: "master", action: "setMaster", min: 0, max: 1, step: 0.01 }], this));
  }
  disconnectedCallback() { this.off.forEach((f) => f()); }
}
```

`ctx` offers `get`, `isStale`, `subscribe`, `action(name, args, onProgress)`, `openStream`,
`render(widgets, container)` (the declarative renderer, for mixing) and `info()`. Use the theme
CSS variables (`--fg`, `--bg`, `--surface`, `--muted`, `--border`, `--accent`, `--ok`,
`--warn`, `--err`). They follow the OS light/dark setting.

The shell's stylesheet is **Bootstrap 6** (6.0.0-alpha.1), so a custom page can also use its
classes and tokens. Write v6 markup, not v5: `btn-solid theme-primary`, `btn-outline
theme-secondary`, `btn-sm`; `list-group` / `list-group-item`; `badge badge-subtle theme-success`;
`form-control` (also on `<select>`); a radio is `<input type="radio" class="radio">`; a switch
is `<div class="switch"><input type="checkbox" role="switch" switch></div>`; a range is
`<div class="form-range"><input type="range" class="form-range-input"></div>` (set
`--bs-range-fill` to 0…1 on the wrapper to fill the track); a meter is `progress` /
`progress-bar`. Bootstrap's tokens are prefixed `--bs-` (e.g. `var(--bs-primary-base)`,
`var(--bs-bg-1)`), as in Bootstrap's own dist CSS. Only part of Bootstrap is included (reboot,
forms, buttons, list group, nav, badge, dialog, toast, progress, theme colors, a subset of
utilities): see `web/src/styles.scss` and `web/src/_utilities-subset.scss`. Bootstrap's
JavaScript is not loaded.

`tools/shortcuts/page.ts` is a working example: its own form and rows, styled only with the
theme variables above (an unlayered `<style>` scoped by a class on its root, so it doesn't
depend on Bootstrap's classes),
plus `ctx.render` for single `button` widgets, so Remove gets the shell's confirm dialog and
status dot. Outside a list a button's `confirm` has no row, so text you put in it must not
contain `{word}` placeholders (that page inserts a zero-width space after each `{`). Logic the
page and the tool share (`src/accel.ts`, `src/command.ts`) imports nothing, so the browser can
load it through relative `./src/….ts` imports.

## 7. Checklist for a new tool

1. `tools/<id>/manifest.json`, `package.json`, `<id>.ts` with `serve` + plain CLI subcommands.
2. Key list maps by ids; publish deltas; mark hardware-backed values stale until re-read.
3. Errors as `throw new Error("human readable")`; never print to stdout outside the SDK.
4. Tests with `node:test` next to the tool; drive `serve` through `input`/`output` streams
   (see `packages/tool-sdk/test/sdk.test.ts`).
