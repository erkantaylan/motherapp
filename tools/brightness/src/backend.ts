// The one interface both ways of talking DDC/CI implement: libddcutil kept loaded in a worker
// thread (libBackend.ts) and the ddcutil command as the fallback (cliBackend.ts). The service
// only sees this, so tests drive it with a fake.

/** A monitor as detection reports it. Monitors are addressed by I2C bus number. */
export interface MonitorInfo {
  bus: number;
  /** DRM connector without the card prefix, e.g. "DP-1", when known. */
  connector?: string;
  /** Three-letter EDID manufacturer id, e.g. "MSI". */
  mfg: string;
  model: string;
  /** EDID serial (ASCII descriptor), may be empty. */
  serial: string;
}

/** A raw VCP reading: the current value and the monitor's maximum. */
export interface Reading {
  current: number;
  max: number;
}

export interface Backend {
  readonly kind: "libddcutil" | "ddcutil";
  /** For the page and the logs, e.g. "libddcutil 1.4.1". */
  readonly description: string;
  /** Lists DDC-capable monitors. `redetect` rescans the buses instead of using what is cached. */
  detect(redetect: boolean): Promise<MonitorInfo[]>;
  /** Reads brightness (VCP 0x10). */
  read(bus: number): Promise<Reading>;
  /** Writes a raw brightness value (0..max). */
  write(bus: number, raw: number): Promise<void>;
  close(): Promise<void>;
}

/** A failed monitor call. `gone` means the monitor is probably not there any more (re-detect). */
export class BackendError extends Error {
  readonly gone: boolean;
  constructor(message: string, opts: { gone?: boolean } = {}) {
    super(message);
    this.name = "BackendError";
    this.gone = opts.gone ?? false;
  }
}

export const VCP_BRIGHTNESS = 0x10;
