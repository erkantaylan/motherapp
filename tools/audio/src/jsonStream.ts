// Splits `pw-dump --monitor` output into its top-level JSON values. pw-dump prints one
// pretty-printed JSON array per update, back to back; a chunk from the pipe can end anywhere,
// including inside a string. This tracks bracket depth and string state across chunks.

export class JsonStreamParser {
  private buf = "";
  /** Scan position in `buf`. */
  private pos = 0;
  /** Start of the value being collected, or -1 between values. */
  private start = -1;
  private depth = 0;
  private inString = false;
  private escape = false;

  /** Feeds a chunk; returns the raw text of every value it completed. */
  push(chunk: string): string[] {
    this.buf += chunk;
    const out: string[] = [];
    const s = this.buf;
    for (let i = this.pos; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (this.start < 0) {
        if (c === 0x5b /* [ */ || c === 0x7b /* { */) {
          this.start = i;
          this.depth = 1;
        }
        continue; // whitespace (or junk) between values
      }
      if (this.inString) {
        if (this.escape) this.escape = false;
        else if (c === 0x5c /* \ */) this.escape = true;
        else if (c === 0x22 /* " */) this.inString = false;
        continue;
      }
      if (c === 0x22) this.inString = true;
      else if (c === 0x5b || c === 0x7b) this.depth++;
      else if (c === 0x5d /* ] */ || c === 0x7d /* } */) {
        this.depth--;
        if (this.depth === 0) {
          out.push(s.slice(this.start, i + 1));
          this.start = -1;
        }
      }
    }
    // Drop what's been consumed so the buffer doesn't grow without bound.
    if (this.start < 0) {
      this.buf = "";
      this.pos = 0;
    } else {
      this.buf = s.slice(this.start);
      this.pos = this.buf.length;
      this.start = 0;
    }
    return out;
  }

  /** True while a value is half read. */
  get pending(): boolean {
    return this.start >= 0;
  }
}
