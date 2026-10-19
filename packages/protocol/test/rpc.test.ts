import { test } from "node:test";
import assert from "node:assert/strict";
import { ErrorCode, LineDecoder, RpcError, RpcPeer } from "@motherapp/protocol";
import type { RpcMessage } from "@motherapp/protocol";

test("LineDecoder: partial lines are buffered until the newline arrives", () => {
  const d = new LineDecoder();
  assert.deepEqual(d.push('{"a":'), []);
  assert.deepEqual(d.push("1}"), []);
  assert.deepEqual(d.push('\n{"b"'), ['{"a":1}']);
  assert.deepEqual(d.push(":2}\n"), ['{"b":2}']);
  assert.deepEqual(d.flush(), []);
});

test("LineDecoder: several messages in one chunk, CRLF and blank lines", () => {
  const d = new LineDecoder();
  assert.deepEqual(d.push('{"a":1}\n{"b":2}\r\n\n{"c":3}\n{"d"'), ['{"a":1}', '{"b":2}', '{"c":3}']);
  assert.deepEqual(d.flush(), ['{"d"']);
  assert.deepEqual(d.flush(), []);
});

/** Two peers wired back to back through line-encoded strings split at random points. */
function pair(serverHandler: (m: string, p: unknown) => unknown) {
  const notes: [string, unknown][] = [];
  let toServer = "";
  let toClient = "";
  const sd = new LineDecoder();
  const cd = new LineDecoder();
  const server: RpcPeer = new RpcPeer({
    send: (m) => (toClient += JSON.stringify(m) + "\n"),
    onRequest: (m, p) => serverHandler(m, p),
  });
  const client: RpcPeer = new RpcPeer({
    send: (m) => (toServer += JSON.stringify(m) + "\n"),
    onNotification: (m, p) => notes.push([m, p]),
  });
  const pump = async () => {
    for (let i = 0; i < 20; i++) {
      // deliver in 3-byte chunks to exercise framing
      while (toServer) {
        const c = toServer.slice(0, 3);
        toServer = toServer.slice(3);
        for (const l of sd.push(c)) server.receiveLine(l);
      }
      while (toClient) {
        const c = toClient.slice(0, 3);
        toClient = toClient.slice(3);
        for (const l of cd.push(c)) client.receiveLine(l);
      }
      await new Promise((r) => setImmediate(r));
    }
  };
  return { server, client, notes, pump };
}

test("RpcPeer: request/response, errors and notifications", async () => {
  const { server, client, notes, pump } = pair(async (m, p) => {
    if (m === "add") return (p as number[]).reduce((a, b) => a + b, 0);
    if (m === "fail") throw new RpcError(ErrorCode.ActionFailed, "broken", { why: 1 });
    if (m === "plain") throw new Error("plain error");
    if (m === "void") return undefined;
    throw new RpcError(ErrorCode.MethodNotFound, "nope");
  });
  const sum = client.request("add", [1, 2, 3]);
  const fail = assert.rejects(client.request("fail"), (e: RpcError) => e.code === ErrorCode.ActionFailed && e.message === "broken" && (e.data as { why: number }).why === 1);
  const plain = assert.rejects(client.request("plain"), (e: RpcError) => e.code === ErrorCode.ActionFailed && e.message === "plain error");
  const v = client.request("void");
  server.notify("hello", { x: 1 });
  await pump();
  assert.equal(await sum, 6);
  await fail;
  await plain;
  assert.equal(await v, null);
  assert.deepEqual(notes, [["hello", { x: 1 }]]);
});

test("RpcPeer: missing handler answers MethodNotFound", async () => {
  const sent: RpcMessage[] = [];
  const peer = new RpcPeer({ send: (m) => sent.push(m) });
  peer.receive({ jsonrpc: "2.0", id: 7, method: "x" });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent, [{ jsonrpc: "2.0", id: 7, error: { code: ErrorCode.MethodNotFound, message: "method not found: x" } }]);
});

test("RpcPeer: invalid input is reported, not thrown", () => {
  const bad: string[] = [];
  const peer = new RpcPeer({ send: () => {}, onInvalid: (raw, reason) => bad.push(`${reason}: ${raw}`) });
  peer.receiveLine("not json");
  peer.receiveLine('{"hello":1}');
  assert.equal(bad.length, 2);
  assert.match(bad[0]!, /not JSON/);
  assert.match(bad[1]!, /not a JSON-RPC/);
});

test("RpcPeer: timeouts use the injected timer and close() rejects pending requests", async () => {
  const timers: (() => void)[] = [];
  const peer = new RpcPeer({
    send: () => {},
    timeoutMs: 1000,
    setTimer: (fn) => timers.push(fn),
    clearTimer: () => {},
  });
  const a = peer.request("slow");
  const startedB = peer.start("other");
  const bRejected = assert.rejects(startedB.result, (e: RpcError) => e.code === ErrorCode.ToolUnavailable);
  assert.equal(typeof startedB.id, "number");
  assert.equal(peer.pendingCount, 2);
  timers[0]!();
  await assert.rejects(a, (e: RpcError) => e.code === ErrorCode.Timeout);
  peer.close({ code: ErrorCode.ToolUnavailable, message: "gone" });
  await bRejected;
  await assert.rejects(peer.request("late"), (e: RpcError) => e.message === "gone");
});

test("RpcPeer: unknown response ids are ignored", () => {
  const peer = new RpcPeer({ send: () => {} });
  peer.receive({ jsonrpc: "2.0", id: 999, result: 1 });
  assert.equal(peer.pendingCount, 0);
});
