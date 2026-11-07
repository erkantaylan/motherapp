// Branch and uncommitted changes of the folders sessions work in. These are folders the user's
// Claudes are busy in, so everything is read-only and takes no lock: `--no-optional-locks` keeps
// `git status` from refreshing the index. A repo's own config can't run anything here either:
// `core.fsmonitor` is the one setting `git status` would execute.
//
// Never on the poll's critical path: `get` answers from memory, and `refresh` starts at most one
// git at a time, per folder rather than per session. A folder seen for the first time goes first
// and the next follows at once; after that each one is read again every TTL_MS, one per poll.
import { run } from "./runner.ts";
import type { Runner } from "./runner.ts";

export interface GitState {
  /** The repo's top level. */
  root: string;
  /** Branch name, or the short commit when detached. */
  branch: string;
  /** Changed, staged and untracked files. */
  changes: number;
}

export interface GitSource {
  /** Known state; null when the folder isn't a usable repo; undefined when not read yet. */
  get(path: string): GitState | null | undefined;
  /** The folders in use now. Forgets others, and reads what's due. */
  refresh(paths: Iterable<string>): void;
}

export const TTL_MS = 30_000;
/** A folder that isn't a repo rarely becomes one. */
export const NOT_REPO_TTL_MS = 120_000;
const TIMEOUT_MS = 5000;

const git = (path: string, ...args: string[]) => ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", path, ...args];

/** `git status --porcelain=v2 --branch`: "# branch.head x", "# branch.oid y", a line per change. */
export function parseStatus(out: string): { branch: string; changes: number } | undefined {
  let head: string | undefined;
  let oid = "";
  let changes = 0;
  for (const line of out.split("\n")) {
    if (line.startsWith("# branch.head ")) head = line.slice(14);
    else if (line.startsWith("# branch.oid ")) oid = line.slice(13);
    else if (line !== "" && !line.startsWith("#")) changes++;
  }
  if (head === undefined) return undefined;
  return { branch: head === "(detached)" ? oid.slice(0, 7) : head, changes };
}

interface Entry {
  state: GitState | null;
  readAt: number;
}

export class GitCache implements GitSource {
  private runner: Runner;
  private now: () => number;
  private entries = new Map<string, Entry>();
  private wanted = new Set<string>();
  private busy = false;

  constructor(opts: { runner: Runner; now?: () => number }) {
    this.runner = opts.runner;
    this.now = opts.now ?? Date.now;
  }

  get(path: string): GitState | null | undefined {
    return this.entries.get(path)?.state;
  }

  refresh(paths: Iterable<string>): void {
    this.wanted = new Set(paths);
    for (const p of this.entries.keys()) if (!this.wanted.has(p)) this.entries.delete(p);
    this.next();
  }

  /** The folder to read now: one never read, else the one overdue the longest. */
  private due(): string | undefined {
    const now = this.now();
    let best: string | undefined;
    let bestAge = 0;
    for (const p of this.wanted) {
      const e = this.entries.get(p);
      if (!e) return p;
      const age = now - e.readAt - (e.state ? TTL_MS : NOT_REPO_TTL_MS);
      if (age >= 0 && (best === undefined || age > bestAge)) {
        best = p;
        bestAge = age;
      }
    }
    return best;
  }

  private next(): void {
    if (this.busy) return;
    const path = this.due();
    if (path === undefined) return;
    const first = !this.entries.has(path);
    this.busy = true;
    void this.read(path)
      .then((state) => {
        if (this.wanted.has(path)) this.entries.set(path, { state, readAt: this.now() });
      })
      .finally(() => {
        this.busy = false;
        if (first) this.next();
      });
  }

  /** A folder that's gone, a broken repo, no git at all: all simply "not a repo". */
  private async read(path: string): Promise<GitState | null> {
    try {
      let root = this.entries.get(path)?.state?.root;
      if (!root) {
        const r = await run(this.runner, "git", git(path, "rev-parse", "--show-toplevel"), TIMEOUT_MS);
        root = r.code === 0 ? r.stdout.trim() : "";
        if (!root) return null;
      }
      const s = await run(this.runner, "git", git(path, "status", "--porcelain=v2", "--branch", "--ignore-submodules=all"), TIMEOUT_MS);
      const parsed = s.code === 0 ? parseStatus(s.stdout) : undefined;
      return parsed ? { root, ...parsed } : null;
    } catch {
      return null;
    }
  }
}
