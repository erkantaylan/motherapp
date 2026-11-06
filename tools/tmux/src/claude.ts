// What Claude Code says about itself, read from its own files. This is an undocumented internal
// format and the user accepts that: every read here may fail or find a shape it doesn't know,
// and the answer is then "nothing", so the caller falls back to pane output. Nothing here throws.
//
//   ~/.claude/sessions/<pid>.json   { pid, sessionId, status, procStart?, waitingFor?, name?, … }
//     status seen: "busy", "shell", "idle", "waiting" (with waitingFor: "permission prompt").
//     Written by the running Claude and removed when it exits (a kill -9 leaves it behind).
//   ~/.claude/projects/*/<sessionId>.jsonl   the transcript, one record a line:
//     { type: "ai-title", aiTitle }, { type: "last-prompt", lastPrompt },
//     { type: "assistant", isSidechain, message: { usage, content: [{ type: "text", text }, …] } }
//     Transcripts reach tens of MB, so they're read from the tail and then only what was appended.
//   ~/.claude/projects/*/<sessionId>/subagents/agent-<id>.meta.json  + agent-<id>.jsonl
//     Sub-agents run inside the Claude process, so there is no child process to count.
//
// Which sub-agents are running, measured on 2.1.319 against 415 real meta files and real runs:
// `finished: true` appears when an agent ends and goes away again while SendMessage continues it,
// but alone it isn't enough. Metas from before 2.1.301 never have it. A kill -9 leaves it unset, so
// after a resume the old meta still looks running: it predates the new process. TaskStop leaves
// it unset too, and only the agent's transcript shows it, ending "[Request interrupted by user".
// The status file settles the rest: it stays "busy" while any sub-agent runs, so "idle" and
// "shell" mean none. `runningAgents` takes all of that together, and an unknown version is no answer.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface ClaudeStatus {
  pid: number;
  sessionId: string;
  status: string;
  waitingFor?: string;
  name?: string;
  /** Epoch ms. */
  startedAt?: number;
  version?: string;
}

export interface ClaudeDetails {
  title?: string;
  lastPrompt?: string;
  lastMessage?: string;
  /** Tokens in the context at the latest reply. */
  contextTokens?: number;
  model?: string;
}

export interface ClaudeSource {
  /** Pane pid → the Claude in that pane: the pane's own process, or else its nearest descendant. */
  forPanes(panePids: ReadonlySet<number>): Map<number, ClaudeStatus>;
  details(sessionId: string): ClaudeDetails | undefined;
  /** Sub-agents running now, or undefined when that can't be told. */
  runningAgents(status: ClaudeStatus): number | undefined;
}

export const TAIL_BYTES = 1 << 20;
export const MAX_TAIL_BYTES = 16 << 20;
const MAX_HOPS = 32;
const MAX_PROMPT = 2000;
const MAX_MESSAGE = 4000;
const SESSION_ID = /^[0-9a-f-]{8,64}$/i;
const STATUS_FILE = /^(\d+)\.json$/;
const AGENT_META = /^agent-.+\.meta\.json$/;
/** The first version that writes `finished`. */
const FINISHED_SINCE = [2, 1, 301];
const INTERRUPTED = "[Request interrupted by user";
const AGENT_TAIL_BYTES = 64 * 1024;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `/proc/<pid>/stat`: the name may hold spaces and ")", so fields count from the last ")". */
export function parseProcStat(stat: string): { ppid: number; start: string } | undefined {
  const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const ppid = Number(f[1]);
  return Number.isInteger(ppid) && f[19] ? { ppid, start: f[19] } : undefined;
}

/** A status file's content, or undefined when it isn't one. */
export function parseStatus(text: string, pid: number): (ClaudeStatus & { procStart?: string }) | undefined {
  let d: unknown;
  try {
    d = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(d) || d.pid !== pid || typeof d.sessionId !== "string" || typeof d.status !== "string") return undefined;
  return {
    pid,
    sessionId: d.sessionId,
    status: d.status,
    ...(typeof d.waitingFor === "string" ? { waitingFor: d.waitingFor } : {}),
    ...(typeof d.name === "string" ? { name: d.name } : {}),
    ...(typeof d.procStart === "string" ? { procStart: d.procStart } : {}),
    ...(typeof d.startedAt === "number" ? { startedAt: d.startedAt } : {}),
    ...(typeof d.version === "string" ? { version: d.version } : {}),
  };
}

/** Does this version write `finished`? An unparsable version is a no. */
export function writesFinished(version: string | undefined): boolean {
  const v = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? "")?.slice(1).map(Number);
  if (!v) return false;
  for (let i = 0; i < 3; i++) if (v[i] !== FINISHED_SINCE[i]) return v[i]! > FINISHED_SINCE[i]!;
  return true;
}

/** Did an agent's transcript end by being stopped? Looks at the last message record of a tail. */
export function endsInterrupted(tail: string): boolean {
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!/"type":"(user|assistant)"/.test(lines[i]!)) continue;
    let r: unknown;
    try {
      r = JSON.parse(lines[i]!);
    } catch {
      continue; // the cut first line of the tail, or a line still being written
    }
    if (!isObject(r) || (r.type !== "user" && r.type !== "assistant")) continue;
    if (r.type === "assistant" || !isObject(r.message)) return false;
    const c = r.message.content;
    return (typeof c === "string" ? c : JSON.stringify(c ?? "")).includes(INTERRUPTED);
  }
  return false;
}

function messageText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const texts = content.filter((c) => isObject(c) && c.type === "text" && typeof c.text === "string" && c.text.trim() !== "").map((c) => (c as { text: string }).text);
  return texts.length ? texts.join("\n") : undefined;
}

/** Later records win. Only the record types we use are parsed; the big ones are skipped unread. */
export function scanTranscript(text: string, into: ClaudeDetails = {}): ClaudeDetails {
  for (const line of text.split("\n")) {
    if (!/"type":"(ai-title|last-prompt|assistant)"/.test(line)) continue;
    let r: unknown;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(r)) continue;
    if (r.type === "ai-title" && typeof r.aiTitle === "string") into.title = r.aiTitle;
    else if (r.type === "last-prompt" && typeof r.lastPrompt === "string") into.lastPrompt = r.lastPrompt.slice(0, MAX_PROMPT);
    else if (r.type === "assistant" && r.isSidechain !== true && isObject(r.message)) {
      const m = r.message;
      const said = messageText(m.content);
      if (said !== undefined) into.lastMessage = said.slice(-MAX_MESSAGE);
      if (isObject(m.usage)) {
        const n = (k: string) => (typeof (m.usage as Record<string, unknown>)[k] === "number" ? ((m.usage as Record<string, unknown>)[k] as number) : 0);
        const tokens = n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens");
        if (tokens > 0) {
          into.contextTokens = tokens;
          if (typeof m.model === "string") into.model = m.model;
        }
      }
    }
  }
  return into;
}

const complete = (d: ClaudeDetails) => d.title !== undefined && d.lastPrompt !== undefined && d.lastMessage !== undefined && d.contextTokens !== undefined;

interface Cached {
  file: string;
  size: number;
  mtimeMs: number;
  /** Everything before this byte has been read; it is always just after a newline. */
  offset: number;
  details: ClaudeDetails;
}

export class ClaudeFiles implements ClaudeSource {
  private dir: string;
  private proc: string;
  private statusCache = new Map<string, { mtimeMs: number; size: number; status: ReturnType<typeof parseStatus> }>();
  private transcripts = new Map<string, Cached>();
  private located = new Map<string, string>();
  private metas = new Map<string, { mtimeMs: number; size: number; ended: boolean }>();

  constructor(opts: { dir?: string; proc?: string } = {}) {
    this.dir = opts.dir ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
    this.proc = opts.proc ?? "/proc";
  }

  private procInfo(pid: number): { ppid: number; start: string } | undefined {
    try {
      return parseProcStat(fs.readFileSync(path.join(this.proc, String(pid), "stat"), "utf8"));
    } catch {
      return undefined;
    }
  }

  /** Every status file of a process that is alive and is the one that wrote it. */
  private statuses(): (ClaudeStatus & { ppid: number })[] {
    const dir = path.join(this.dir, "sessions");
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    const out: (ClaudeStatus & { ppid: number })[] = [];
    const seen = new Set<string>();
    for (const name of names) {
      const m = STATUS_FILE.exec(name);
      if (!m) continue;
      seen.add(name);
      const s = this.readStatus(path.join(dir, name), name, Number(m[1]));
      if (!s) continue;
      const info = this.procInfo(s.pid);
      // A crash leaves the file behind, and its pid can come back as something else.
      if (!info || (s.procStart !== undefined && s.procStart !== info.start)) continue;
      out.push({ ...s, ppid: info.ppid });
    }
    for (const k of this.statusCache.keys()) if (!seen.has(k)) this.statusCache.delete(k);
    return out;
  }

  private readStatus(file: string, name: string, pid: number): ReturnType<typeof parseStatus> {
    try {
      const st = fs.statSync(file);
      const c = this.statusCache.get(name);
      if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.status;
      const status = parseStatus(fs.readFileSync(file, "utf8"), pid);
      this.statusCache.set(name, { mtimeMs: st.mtimeMs, size: st.size, status });
      return status;
    } catch {
      return undefined;
    }
  }

  forPanes(panePids: ReadonlySet<number>): Map<number, ClaudeStatus> {
    const found = new Map<number, { hops: number; status: ClaudeStatus }>();
    for (const { ppid, ...status } of this.statuses()) {
      let pid = status.pid;
      let parent = ppid;
      for (let hops = 0; hops < MAX_HOPS && pid > 1; hops++) {
        if (panePids.has(pid)) {
          const best = found.get(pid);
          if (!best || hops < best.hops) found.set(pid, { hops, status });
          break;
        }
        pid = parent;
        parent = this.procInfo(pid)?.ppid ?? 0;
      }
    }
    return new Map([...found].map(([pid, f]) => [pid, f.status]));
  }

  private locate(sessionId: string): string | undefined {
    const known = this.located.get(sessionId);
    if (known && fs.existsSync(known)) return known;
    this.located.delete(sessionId);
    const root = path.join(this.dir, "projects");
    try {
      for (const project of fs.readdirSync(root)) {
        const file = path.join(root, project, `${sessionId}.jsonl`);
        if (fs.existsSync(file)) {
          this.located.set(sessionId, file);
          return file;
        }
      }
    } catch {
      // no projects dir
    }
    return undefined;
  }

  runningAgents(s: ClaudeStatus): number | undefined {
    if (!SESSION_ID.test(s.sessionId) || !writesFinished(s.version) || s.startedAt === undefined) return undefined;
    if (s.status === "idle" || s.status === "shell") return 0; // both mean no sub-agent is running
    if (s.status !== "busy" && s.status !== "waiting") return undefined;
    try {
      const file = this.locate(s.sessionId);
      if (!file) return 0; // no transcript yet: nothing has been launched
      const dir = path.join(file.slice(0, -".jsonl".length), "subagents");
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return 0; // never had one
        throw e;
      }
      let n = 0;
      for (const name of names) if (AGENT_META.test(name) && this.isRunning(path.join(dir, name), s.startedAt)) n++;
      return n;
    } catch {
      return undefined;
    }
  }

  private isRunning(meta: string, startedAt: number): boolean {
    const st = fs.statSync(meta);
    if (st.mtimeMs < startedAt) return false; // from an earlier process, which took it with it
    let c = this.metas.get(meta);
    if (!c || c.mtimeMs !== st.mtimeMs || c.size !== st.size) {
      const d: unknown = JSON.parse(fs.readFileSync(meta, "utf8"));
      c = { mtimeMs: st.mtimeMs, size: st.size, ended: !isObject(d) || d.finished === true || d.stoppedByUser === true };
      this.metas.set(meta, c);
    }
    return !c.ended && !endsInterrupted(this.tail(meta.replace(/\.meta\.json$/, ".jsonl")));
  }

  private tail(file: string): string {
    let fd: number;
    try {
      fd = fs.openSync(file, "r");
    } catch {
      return ""; // launched a moment ago
    }
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - AGENT_TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      return buf.toString("utf8", 0, fs.readSync(fd, buf, 0, buf.length, start));
    } finally {
      fs.closeSync(fd);
    }
  }

  details(sessionId: string): ClaudeDetails | undefined {
    if (!SESSION_ID.test(sessionId)) return undefined;
    try {
      return this.read(sessionId);
    } catch {
      return this.transcripts.get(sessionId)?.details;
    }
  }

  private read(sessionId: string): ClaudeDetails | undefined {
    let c = this.transcripts.get(sessionId);
    const file = c && fs.existsSync(c.file) ? c.file : this.locate(sessionId);
    if (!file) return undefined;
    const st = fs.statSync(file);
    if (c && c.file === file && c.size === st.size && c.mtimeMs === st.mtimeMs) return c.details;
    // Shorter than what was read: it was replaced, start over.
    if (!c || c.file !== file || st.size < c.offset) c = { file, size: 0, mtimeMs: 0, offset: 0, details: {} };
    this.scan(c, st.size);
    c.size = st.size;
    c.mtimeMs = st.mtimeMs;
    this.transcripts.set(sessionId, c);
    return c.details;
  }

  /** Reads what's new: at most the tail, growing it only while a field is still missing. */
  private scan(c: Cached, size: number): void {
    const fd = fs.openSync(c.file, "r");
    try {
      for (let want = TAIL_BYTES; ; want *= 4) {
        const start = Math.max(c.offset, size - want);
        const buf = Buffer.alloc(size - start);
        const got = fs.readSync(fd, buf, 0, buf.length, start);
        const data = buf.subarray(0, got);
        const end = data.lastIndexOf(10) + 1; // a line still being written waits for the next read
        const begin = start > c.offset ? data.indexOf(10) + 1 : 0; // mid-line after a jump
        const details = scanTranscript(data.toString("utf8", begin, Math.max(begin, end)), { ...c.details });
        if (start === c.offset || complete(details) || want >= MAX_TAIL_BYTES) {
          c.details = details;
          c.offset = start + end;
          return;
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  }
}
