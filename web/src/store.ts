// Client-side copy of one tool's state, fed by `snapshot` and `state` notifications.
// Subscribers are told when a change touches their path, an ancestor or a descendant.
// DOM-free.
import { StaleSet, applyChange, getPath, pathsOverlap } from "@motherapp/protocol";
import type { JsonValue, StateChange, StateObject } from "@motherapp/protocol";

interface Sub {
  path: string;
  cb: () => void;
}

export class ToolStore {
  private state: StateObject = {};
  private stale = new StaleSet();
  private subs = new Set<Sub>();
  /** True while the tool is not running or the UI is disconnected: everything shows stale. */
  private down = true;

  get(path = ""): JsonValue | undefined {
    return getPath(this.state, path);
  }

  isStale(path: string): boolean {
    return this.down || this.stale.isStale(path);
  }

  get isDown(): boolean {
    return this.down;
  }

  reset(state: StateObject, stale: readonly string[]): void {
    this.state = state;
    this.stale.reset(stale);
    this.notifyAll();
  }

  apply(changes: readonly StateChange[]): void {
    for (const c of changes) {
      applyChange(this.state, c);
      this.stale.apply(c);
    }
    for (const s of [...this.subs]) {
      if (changes.some((c) => pathsOverlap(c.path, s.path))) s.cb();
    }
  }

  setDown(down: boolean): void {
    if (down === this.down) return;
    this.down = down;
    this.notifyAll();
  }

  subscribe(path: string, cb: () => void): () => void {
    const sub: Sub = { path, cb };
    this.subs.add(sub);
    return () => this.subs.delete(sub);
  }

  get subscriberCount(): number {
    return this.subs.size;
  }

  private notifyAll(): void {
    for (const s of [...this.subs]) s.cb();
  }
}
