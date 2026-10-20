// GVariant text format, as `gsettings get` / `list-recursively` print it and `gsettings set`
// reads it. Only what keybinding settings use: strings, arrays, booleans, numbers, and the
// `@as []` / `uint32 5` type annotations.
//
// What gsettings 2.80 prints (checked in the container, see test/real-gsettings.test.ts):
// - a string in single quotes, or in double quotes when it contains a ' (then " is escaped);
// - escapes \\ \' \" \n \t \a \b \f \r \v and \uXXXX (\UXXXXXXXX above the BMP);
// - non-ASCII text as-is, but only in a UTF-8 locale: under LANG=C it prints "?" instead,
//   which is why every gsettings call runs with LC_ALL=C.UTF-8 (gnome.ts);
// - an empty string array as `@as []`.

export type GValue = string | number | boolean | GValue[];

export class GVariantError extends Error {}

const SIMPLE_ESCAPES: Record<string, string> = { n: "\n", t: "\t", a: "\x07", b: "\b", f: "\f", r: "\r", v: "\v" };

class Parser {
  i = 0;
  readonly s: string;
  constructor(s: string) {
    this.s = s;
  }

  fail(what: string): never {
    throw new GVariantError(`cannot parse GVariant ${JSON.stringify(this.s.length > 80 ? this.s.slice(0, 80) + "…" : this.s)}: ${what} at ${this.i}`);
  }

  ws(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i++;
  }

  value(): GValue {
    this.ws();
    const c = this.s[this.i];
    if (c === undefined) this.fail("unexpected end");
    if (c === "'" || c === '"') return this.string();
    if (c === "[") return this.array();
    if (c === "@") {
      // type annotation: "@as []", "@s 'x'"
      this.i++;
      while (this.i < this.s.length && !/\s/.test(this.s[this.i]!)) this.i++;
      return this.value();
    }
    const word = /^[A-Za-z0-9_.+-]+/.exec(this.s.slice(this.i))?.[0];
    if (!word) this.fail(`unexpected ${JSON.stringify(c)}`);
    // "uint32 5", "int64 -1", "byte 0x10": a type keyword followed by a value
    if (/^(u?int(16|32|64)|byte|handle|double|boolean|string|objectpath|signature)$/.test(word)) {
      this.i += word.length;
      return this.value();
    }
    this.i += word.length;
    if (word === "true") return true;
    if (word === "false") return false;
    const n = Number(word);
    if (!Number.isNaN(n)) return n;
    this.fail(`unexpected word ${JSON.stringify(word)}`);
  }

  string(): string {
    const q = this.s[this.i++]!;
    let out = "";
    for (;;) {
      const c = this.s[this.i++];
      if (c === undefined) this.fail("unterminated string");
      if (c === q) return out;
      if (c !== "\\") {
        out += c;
        continue;
      }
      const e = this.s[this.i++];
      if (e === undefined) this.fail("unterminated escape");
      if (e in SIMPLE_ESCAPES) out += SIMPLE_ESCAPES[e];
      else if (e === "u" || e === "U") {
        const len = e === "u" ? 4 : 8;
        const hex = this.s.slice(this.i, this.i + len);
        if (!new RegExp(`^[0-9a-fA-F]{${len}}$`).test(hex)) this.fail(`bad \\${e} escape`);
        this.i += len;
        out += String.fromCodePoint(parseInt(hex, 16));
      } else out += e; // \\ \' \" and anything else stands for itself
    }
  }

  array(): GValue[] {
    this.i++; // [
    const out: GValue[] = [];
    this.ws();
    if (this.s[this.i] === "]") {
      this.i++;
      return out;
    }
    for (;;) {
      out.push(this.value());
      this.ws();
      const c = this.s[this.i++];
      if (c === "]") return out;
      if (c !== ",") this.fail("expected , or ]");
    }
  }
}

/** Parses one GVariant text value. Throws GVariantError on anything it doesn't understand. */
export function parseGVariant(text: string): GValue {
  const p = new Parser(text);
  const v = p.value();
  p.ws();
  if (p.i !== text.length) p.fail("trailing text");
  return v;
}

/** Parses a value that must be a string. */
export function parseString(text: string): string {
  const v = parseGVariant(text);
  if (typeof v !== "string") throw new GVariantError(`expected a string, got ${text.trim()}`);
  return v;
}

/** Parses a value that must be an array of strings (`@as []` included). */
export function parseStringArray(text: string): string[] {
  const v = parseGVariant(text);
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new GVariantError(`expected an array of strings, got ${text.trim()}`);
  return v as string[];
}

/**
 * GVariant text for a string: single-quoted, with \\ and \' escaped, and everything outside
 * printable ASCII written as \uXXXX / \UXXXXXXXX, so the text survives any locale.
 */
export function printString(s: string): string {
  let out = "'";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === "\\" || ch === "'") out += "\\" + ch;
    else if (cp >= 0x20 && cp < 0x7f) out += ch;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else if (cp <= 0xffff) out += "\\u" + cp.toString(16).padStart(4, "0");
    else out += "\\U" + cp.toString(16).padStart(8, "0");
  }
  return out + "'";
}

/** GVariant text for an `as`; the empty array needs its type, `@as []`. */
export function printStringArray(a: readonly string[]): string {
  return a.length === 0 ? "@as []" : `[${a.map(printString).join(", ")}]`;
}
