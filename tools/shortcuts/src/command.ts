// The `command` of a custom shortcut. gnome-settings-daemon splits it with g_shell_parse_argv
// and spawns the result directly: no shell, so no pipes, variables, globs or ~, and the PATH
// is whatever the session has. Hence:
// - tool commands are written with the ~/.local/bin wrapper's absolute path;
// - arguments are quoted the way g_shell_parse_argv reads them ('…' with '\'' for a quote);
// - a command line that needs a shell (| ; & < > $ ` ( ) outside quotes) is wrapped in
//   `sh -c '…'`. Everything else is kept as an argv.
// Browser-safe (page.ts uses it for the preview): no imports.

/** Unquoted, these characters mean something only to a shell. */
const SHELL_OPERATORS = /[|&;<>()$`]/;

/** Quotes one argument for g_shell_parse_argv (and POSIX sh, which reads it the same way). */
export function quoteArg(s: string): string {
  if (s !== "" && /^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

export function joinArgv(argv: readonly string[]): string {
  return argv.map(quoteArg).join(" ");
}

export interface SplitResult {
  argv: string[];
  /** A shell operator appeared outside quotes. */
  needsShell: boolean;
  /** Index set of words that started with an unquoted "~/". */
  tilde: Set<number>;
}

/**
 * Splits like GLib's g_shell_parse_argv: blanks separate words; '…' is literal; "…" is
 * literal except \ before $ ` " \ and newline; an unquoted \ escapes the next character
 * (\<newline> vanishes); # at the start of a word starts a comment. Throws on an
 * unterminated quote or an empty command.
 */
export function shellSplit(s: string): SplitResult {
  const argv: string[] = [];
  const tilde = new Set<number>();
  let needsShell = false;
  let cur = "";
  let inWord = false;
  let i = 0;
  const end = () => {
    if (inWord) argv.push(cur);
    cur = "";
    inWord = false;
  };
  while (i < s.length) {
    const c = s[i]!;
    if (c === " " || c === "\t" || c === "\n") {
      end();
      i++;
    } else if (c === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0) throw new Error("The command has a ' without its closing '.");
      cur += s.slice(i + 1, j);
      inWord = true;
      i = j + 1;
    } else if (c === '"') {
      i++;
      inWord = true;
      for (;;) {
        if (i >= s.length) throw new Error('The command has a " without its closing ".');
        const d = s[i]!;
        if (d === '"') {
          i++;
          break;
        }
        if (d === "\\" && i + 1 < s.length && '$`"\\\n'.includes(s[i + 1]!)) {
          if (s[i + 1] !== "\n") cur += s[i + 1];
          i += 2;
        } else {
          cur += d;
          i++;
        }
      }
    } else if (c === "\\") {
      if (i + 1 < s.length) {
        if (s[i + 1] !== "\n") cur += s[i + 1];
        inWord = true;
      }
      i += 2;
    } else if (c === "#" && !inWord) {
      const j = s.indexOf("\n", i);
      i = j < 0 ? s.length : j;
    } else {
      if (!inWord && c === "~" && s[i + 1] === "/") tilde.add(argv.length);
      if (SHELL_OPERATORS.test(c)) needsShell = true;
      cur += c;
      inWord = true;
      i++;
    }
  }
  end();
  if (argv.length === 0) throw new Error("The command is empty.");
  return { argv, needsShell, tilde };
}

export interface CommandContext {
  /** Absolute ~/.local/bin, where install.sh writes the tool wrappers. */
  binDir: string;
  home: string;
  /** Command names the tools declare in their manifest `bin`. */
  bins: ReadonlySet<string>;
}

const expandHome = (w: string, home: string) => home.replace(/\/+$/, "") + w.slice(1);

/** argv[0] as GNOME must see it: a tool command becomes its wrapper's absolute path. */
function resolveProgram(p: string, ctx: CommandContext): string {
  if (!p.includes("/") && ctx.bins.has(p)) return `${ctx.binDir.replace(/\/+$/, "")}/${p}`;
  return p;
}

/** A command as argv (from a suggestion or the CLI after `--`): resolved and quoted. */
export function commandFromArgv(argv: readonly string[], ctx: CommandContext): string {
  if (argv.length === 0 || argv[0] === "") throw new Error("The command is empty.");
  const a = [...argv];
  if (a[0]!.startsWith("~/")) a[0] = expandHome(a[0]!, ctx.home);
  a[0] = resolveProgram(a[0]!, ctx);
  return joinArgv(a);
}

/**
 * A command typed as one line. Read the way GNOME will read it (g_shell_parse_argv); if it
 * uses shell syntax it is wrapped in `sh -c '<line>'` (with a tool command first on the line
 * turned into its absolute path); otherwise it is kept as an argv with a tool command and
 * unquoted leading ~/ expanded.
 */
export function commandFromLine(line: string, ctx: CommandContext): string {
  const text = line.trim();
  const sp = shellSplit(text);
  if (sp.needsShell) {
    const m = /^(\S+)(.*)$/s.exec(text)!;
    const first = /^[A-Za-z0-9._-]+$/.test(m[1]!) ? resolveProgram(m[1]!, ctx) : m[1]!;
    return `sh -c ${quoteArg(first + m[2]!)}`;
  }
  const argv = sp.argv.map((w, i) => (sp.tilde.has(i) ? expandHome(w, ctx.home) : w));
  argv[0] = resolveProgram(argv[0]!, ctx);
  return joinArgv(argv);
}

/** The program a command runs (for "does the wrapper exist" checks): argv[0], or sh's first word. */
export function commandProgram(command: string): string | null {
  try {
    const { argv } = shellSplit(command);
    if (argv[0] === "sh" && argv[1] === "-c" && argv[2] !== undefined) return /^\s*(\S+)/.exec(argv[2])?.[1] ?? null;
    return argv[0] ?? null;
  } catch {
    return null;
  }
}
