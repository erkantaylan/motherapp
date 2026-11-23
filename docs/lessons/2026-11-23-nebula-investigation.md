# Nebula investigation for a motherapp tool (2026-11-23, main session)

Read-only look at `~/Desktop/projects/nebula` (a separate repo, Rust, v0.1.0, installed as
`~/.local/bin/nebula`) to see how a motherapp tool could show its runs and their output. Nothing
was built.

## Lessons

- [local] Nebula's CLI has no machine-readable output: `nebula list`, `show`, `status` print
  aligned text only, and `nebula output <id>` prints the whole output with no "from offset". →
  A tool either parses text, gets a `--json` added in the nebula repo, or reads the database.
- [local] The database is the documented channel between Nebula's parts
  (`~/.local/share/nebula/nebula.db`, or `$NEBULA_HOME`, `$XDG_DATA_HOME/nebula`; SQLite in WAL
  mode, file mode 0600). `node:sqlite` opens it with `{ readOnly: true }` while the daemon runs
  (tried on Node 22.23.2). Tables: `runs`, `chunks (run_id, off, data)`, `scripts (sha256, body)`,
  `daemon (key, value)`. Output is `chunks` ordered by `off`, so a live tail is
  `WHERE run_id = ? AND off >= ?`.
- [local] `PRAGMA user_version` is 0 and new columns arrive through `ALTER TABLE`, so there is no
  schema version to check. → Name the columns in every query and treat a missing one as "this
  Nebula is too new/old", not as a crash.
- [local] `runs.token` is the secret part of a run's link, stored in clear. → Never select it;
  never `SELECT *` from `runs`.
- [local] States: `pending`, `fetched`, `running` are open; `done`, `cancelled`, `expired`,
  `lost`, `closed` are ends. With `--uses N` each execution is a row of its own with `parent_id`
  and `seq` (shown as `42.2`); the parent row is the link.
- [local] Deleting in Nebula is a secure delete followed by a WAL checkpoint-truncate, which a
  reader in the middle of a read delays (Nebula retries for 3 s). → Keep read transactions short:
  no open statement or iterator held between polls.
- [local] Without a daemon, `nebula status`/`list`/`show` do housekeeping (expire, mark lost, fire
  hooks). Reading the database does none of that, so a tool that only reads never changes a run.
- [local] Times in the database are milliseconds since the epoch.

## Open

- Which way the tool reads Nebula (database or a new `--json` in Nebula) is the user's call.
- Not checked: a read while a run is uploading output, and a database written by a Nebula with a
  different schema.
