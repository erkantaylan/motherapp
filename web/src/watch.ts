// Which tool this tab is watching (DOM-free, so it is testable without a browser). A tab
// watches a tool while it shows that tool's page AND is visible (Page Visibility API). The
// core counts watchers per tool and tells the tool when to poll ("poll only while watched",
// docs/extension-contract.md § 3). main.ts feeds it the route and visibility events.

export type VisibilityState = "visible" | "hidden" | string;

export class WatchTracker {
  private route: string | null = null;
  private visible: boolean;
  /** What the core was last told on the current connection. */
  private sent: string | null = null;
  private send: (tool: string | null) => void;

  constructor(send: (tool: string | null) => void, visibility: VisibilityState = "visible") {
    this.send = send;
    this.visible = visibility === "visible";
  }

  /** The tool whose page is shown, or null (Logs, Settings, nothing yet). */
  setRoute(tool: string | null): void {
    this.route = tool;
    this.sync();
  }

  /** `visibilitychange` / `pageshow`: pass `document.visibilityState`. */
  setVisibility(state: VisibilityState): void {
    this.visible = state === "visible";
    this.sync();
  }

  /** `pagehide` (the tab is being unloaded or put into the back/forward cache). */
  hide(): void {
    this.visible = false;
    this.sync();
  }

  /** After a (re)connect the core knows nothing about this tab: tell it again. */
  connected(): void {
    this.sent = null;
    this.sync();
  }

  /** The tool this tab watches right now, or null. */
  get current(): string | null {
    return this.visible ? this.route : null;
  }

  private sync(): void {
    const want = this.current;
    if (want === this.sent) return;
    this.sent = want;
    this.send(want);
  }
}
