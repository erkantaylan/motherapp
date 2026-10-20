// Button click logic (confirm → copy → action) and the clipboard fallbacks, without a DOM.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ActionArgs, ButtonWidget, JsonValue } from "@motherapp/protocol";
import { buttonStyle, clickButton, confirmText, copyText, copyToClipboard } from "../src/button.ts";
import type { ButtonDeps } from "../src/button.ts";
import { interpolateWidget } from "../src/template.ts";
import type { TemplateContext } from "../src/template.ts";

function harness(answer: boolean, template?: () => TemplateContext, state: Record<string, JsonValue> = {}) {
  const log: string[] = [];
  const sent: ActionArgs[] = [];
  const deps: ButtonDeps = {
    template,
    get: (p) => state[p],
    confirm: async (text) => {
      log.push(`confirm:${text}`);
      return answer;
    },
    copy: async (text) => {
      log.push(`copy:${text}`);
    },
    send: (args) => {
      log.push("send");
      sent.push(args);
    },
  };
  return { deps, log, sent };
}

const row = (item: Record<string, JsonValue>): (() => TemplateContext) => () => ({ key: "7", path: "items.7", item });

test("confirm: Cancel sends nothing and copies nothing; OK sends the args", async () => {
  const w: ButtonWidget = { type: "button", label: "Kill", action: "kill", args: { id: "7" }, confirm: "Kill '{name}'?", copy: "x" };
  const no = harness(false, row({ name: "web" }));
  assert.equal(await clickButton(w, no.deps), "cancelled");
  assert.deepEqual(no.log, ["confirm:Kill 'web'?"]);
  assert.deepEqual(no.sent, []);
  const yes = harness(true, row({ name: "web" }));
  assert.equal(await clickButton(w, yes.deps), "done");
  assert.deepEqual(yes.log, ["confirm:Kill 'web'?", "copy:x", "send"]);
  assert.deepEqual(yes.sent, [{ id: "7" }]);
});

test("no confirm: no dialog; copy-only buttons send no action", async () => {
  const plain = harness(false);
  await clickButton({ type: "button", label: "Go", action: "go" }, plain.deps);
  assert.deepEqual(plain.log, ["send"]);
  const copyOnly = harness(false, undefined, { "sessions.3.cmd": "tmux attach -t '=a b'" });
  await clickButton({ type: "button", label: "Copy", copy: { bind: "sessions.3.cmd" } }, copyOnly.deps);
  assert.deepEqual(copyOnly.log, ["copy:tmux attach -t '=a b'"]);
});

test("confirm and copy templates are expanded at click time with the row's current item", async () => {
  // As the list renderer does: the widget is interpolated once when the row is created...
  const created = { key: "7", path: "sessions.7", item: { name: "old", note: "" } };
  const w = interpolateWidget(
    { type: "button", label: "Kill", action: "kill", args: { id: "{key}" }, confirm: "Kill session '{name}'?{note}", copy: "{name}@{key}" },
    created,
  ) as ButtonWidget;
  assert.deepEqual(w.args, { id: "7" }, "args are expanded at creation");
  assert.equal(w.confirm, "Kill session '{name}'?{note}", "confirm is left for click time");
  assert.equal(w.copy, "{name}@{key}");
  // ...then the row's item changes (a rename, an attach) before the click.
  let item: Record<string, JsonValue> = { name: "old", note: "" };
  const t = () => ({ key: "7", path: "sessions.7", item });
  item = { name: "it's new", note: " It is attached (2 clients)." };
  assert.equal(confirmText(w, t), "Kill session 'it's new'? It is attached (2 clients).");
  assert.equal(copyText(w, () => undefined, t), "it's new@7");
  // a { bind } copy is expanded at creation (the key is stable) and read at click time
  const b = interpolateWidget({ type: "button", label: "C", copy: { bind: "sessions.{key}.cmd" } }, created) as ButtonWidget;
  assert.deepEqual(b.copy, { bind: "sessions.7.cmd" });
  assert.equal(copyText(b, (p) => (p === "sessions.7.cmd" ? "now" : undefined)), "now");
  assert.equal(copyText(b, () => undefined), "");
  assert.equal(copyText(b, () => 42), "42");
  // outside a list, placeholders have nothing to fill
  assert.equal(confirmText({ type: "button", label: "x", action: "a", confirm: "Sure {name}?" }), "Sure ?");
  assert.equal(confirmText({ type: "button", label: "x", action: "a" }), undefined);
});

test("buttons with confirm look dangerous unless the tool chose a style", () => {
  assert.equal(buttonStyle({ type: "button", label: "x", action: "a", confirm: "?" }), "danger");
  assert.equal(buttonStyle({ type: "button", label: "x", action: "a", confirm: "?", style: "primary" }), "primary");
  assert.equal(buttonStyle({ type: "button", label: "x", action: "a" }), "default");
});

test("copyToClipboard: clipboard API, then execCommand, then the manual dialog", async () => {
  const calls: string[] = [];
  const manual = async (t: string) => void calls.push(`manual:${t}`);
  assert.equal(await copyToClipboard("a", { writeText: async (t) => void calls.push(`api:${t}`), execCopy: () => (calls.push("exec"), true), manual }), "copied");
  assert.deepEqual(calls.splice(0), ["api:a"]);
  // plain-HTTP LAN access: no clipboard API at all
  assert.equal(await copyToClipboard("b", { execCopy: (t) => (calls.push(`exec:${t}`), true), manual }), "copied");
  assert.deepEqual(calls.splice(0), ["exec:b"]);
  // API denied, execCommand refuses
  const denied = async () => {
    throw new Error("NotAllowedError");
  };
  assert.equal(await copyToClipboard("c", { writeText: denied, execCopy: () => false, manual }), "manual");
  assert.deepEqual(calls.splice(0), ["manual:c"]);
  assert.equal(
    await copyToClipboard("d", {
      execCopy: () => {
        throw new Error("no");
      },
      manual,
    }),
    "manual",
  );
});
