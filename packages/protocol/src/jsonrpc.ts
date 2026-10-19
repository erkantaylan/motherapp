// JSON-RPC 2.0 message shapes. Used on both channels: core <-> tool (stdio, one message per
// line) and browser <-> core (WebSocket, one message per frame).

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type RpcId = number | string;

export interface RpcRequest {
  jsonrpc: "2.0";
  id: RpcId;
  method: string;
  params?: unknown;
}

export interface RpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface RpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface RpcSuccess {
  jsonrpc: "2.0";
  id: RpcId;
  result: unknown;
}

export interface RpcFailure {
  jsonrpc: "2.0";
  id: RpcId | null;
  error: RpcErrorObject;
}

export type RpcResponse = RpcSuccess | RpcFailure;
export type RpcMessage = RpcRequest | RpcNotification | RpcResponse;

/** Standard JSON-RPC codes plus the few motherapp adds (-32000..-32099 is the server range). */
export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** An action handler threw. The message is meant for the user (shown on the failed dot). */
  ActionFailed: -32000,
  /** No reply within the timeout. */
  Timeout: -32001,
  /** The tool is not running (crashed, failed, disabled) or exited mid-request. */
  ToolUnavailable: -32002,
  /** No such tool id. */
  UnknownTool: -32003,
} as const;
