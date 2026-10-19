// WebSocket client to the core with automatic reconnect. Open streams are re-opened and
// `open` listeners run again after a reconnect.
import { ErrorCode, RpcError, RpcPeer } from "@motherapp/protocol";
import type { UiNotifications, UiRequests } from "@motherapp/protocol";

type NotificationHandler = <K extends keyof UiNotifications>(method: K, params: UiNotifications[K]) => void;

export class Connection {
  connected = false;
  private ws: WebSocket | undefined;
  private peer: RpcPeer | undefined;
  private url: string;
  private retryMs = 500;
  private onNotify: NotificationHandler;
  private openListeners = new Set<() => void>();
  private stateListeners = new Set<(connected: boolean) => void>();

  constructor(url: string, onNotify: NotificationHandler) {
    this.url = url;
    this.onNotify = onNotify;
  }

  connect(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    const peer = new RpcPeer({
      send: (msg) => ws.send(JSON.stringify(msg)),
      onNotification: (method, params) => this.onNotify(method as keyof UiNotifications, params as never),
      timeoutMs: 0,
    });
    ws.onopen = () => {
      this.peer = peer;
      this.connected = true;
      this.retryMs = 500;
      for (const l of this.stateListeners) l(true);
      for (const l of this.openListeners) l();
    };
    ws.onmessage = (ev) => peer.receiveLine(String(ev.data));
    ws.onclose = () => {
      peer.close({ code: ErrorCode.ToolUnavailable, message: "disconnected from motherapp" });
      const was = this.connected;
      this.connected = false;
      this.peer = undefined;
      if (was) for (const l of this.stateListeners) l(false);
      setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 5000);
    };
  }

  request<K extends keyof UiRequests>(method: K, params: UiRequests[K]["params"]): Promise<UiRequests[K]["result"]> {
    if (!this.peer) return Promise.reject(new RpcError(ErrorCode.ToolUnavailable, "disconnected from motherapp"));
    return this.peer.request(method, params) as Promise<UiRequests[K]["result"]>;
  }

  /** Starts a request and returns its id (to match `progress` notifications). */
  start<K extends keyof UiRequests>(method: K, params: UiRequests[K]["params"]): { id: number | string; result: Promise<UiRequests[K]["result"]> } {
    if (!this.peer) {
      return { id: -1, result: Promise.reject(new RpcError(ErrorCode.ToolUnavailable, "disconnected from motherapp")) };
    }
    const s = this.peer.start(method, params);
    return { id: s.id, result: s.result as Promise<UiRequests[K]["result"]> };
  }

  /** Runs now if connected, and after every reconnect. */
  onOpen(l: () => void): () => void {
    this.openListeners.add(l);
    if (this.connected) l();
    return () => this.openListeners.delete(l);
  }

  onState(l: (connected: boolean) => void): () => void {
    this.stateListeners.add(l);
    return () => this.stateListeners.delete(l);
  }
}
