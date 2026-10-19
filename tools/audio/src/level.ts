// Mic level from raw `pw-record` output (mono s16le), the same mapping audio-switch uses.

export const RATE = 48000;
/** 50 ms of mono s16, so the meter updates at ~20 Hz. */
export const CHUNK_BYTES = (RATE / 20) * 2;

/** RMS of an s16le chunk mapped from -60..0 dBFS onto 0..1. */
export function chunkLevel(chunk: Uint8Array): number {
  const n = chunk.length >> 1;
  if (n === 0) return 0;
  const view = new DataView(chunk.buffer, chunk.byteOffset, n * 2);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = view.getInt16(i * 2, true);
    sum += s * s;
  }
  const rms = Math.sqrt(sum / n);
  if (rms < 1) return 0;
  return Math.min(1, Math.max(0, (20 * Math.log10(rms / 32768) + 60) / 60));
}

/** Accumulates raw bytes and returns the level of the newest complete chunk, if any. */
export class LevelMeter {
  private buf: Buffer = Buffer.alloc(0);

  push(data: Buffer): number | undefined {
    this.buf = this.buf.length === 0 ? data : Buffer.concat([this.buf, data]);
    let level: number | undefined;
    while (this.buf.length >= CHUNK_BYTES) {
      level = chunkLevel(this.buf.subarray(0, CHUNK_BYTES));
      this.buf = this.buf.subarray(CHUNK_BYTES);
    }
    return level;
  }
}
