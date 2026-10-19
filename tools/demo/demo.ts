// DEMO TOOL — exists only to exercise the extension contract end to end (declarative page,
// actions that can fail, stale values, a keyed list, a stream, logs). Not a real feature;
// disabled by default (manifest `defaultEnabled: false`), enable it on the Settings page.
//
//   node tools/demo/demo.ts serve    serve mode (started by the core)
//   node tools/demo/demo.ts status   print the persisted state
import { createTool, readPersistedState, RpcError } from "@motherapp/tool-sdk";
import type { JsonObject, Widget } from "@motherapp/tool-sdk";

const layout: Widget[] = [
  { type: "text", text: "Demo tool: exercises every widget. Not a real feature.", style: "muted" },
  { type: "text", text: "Counter", style: "heading" },
  { type: "text", bind: "count" },
  { type: "button", label: "Increment", action: "increment", style: "primary" },
  { type: "button", label: "Flaky increment (fails half the time)", action: "flaky" },
  { type: "button", label: "Slow job (progress)", action: "slow" },
  { type: "text", text: "Controls", style: "heading" },
  { type: "toggle", label: "Enabled", bind: "enabled", action: "setEnabled" },
  { type: "slider", label: "Level (slow device, starts stale)", bind: "level", action: "setLevel", min: 0, max: 100, step: 1, unit: "%" },
  {
    type: "radio",
    label: "Mode",
    bind: "mode",
    action: "setMode",
    options: [
      { value: "a", label: "Alpha" },
      { value: "b", label: "Beta" },
      { value: "c", label: "Gamma" },
    ],
  },
  { type: "meter", label: "Sine wave (stream)", stream: "wave", manual: true },
  { type: "text", text: "Items (keyed list, updated in place)", style: "heading" },
  { type: "button", label: "Add item", action: "addItem" },
  {
    type: "list",
    bind: "items",
    sort: "order",
    empty: "No items.",
    item: {
      label: "{name}",
      sublabel: "id {key}",
      widgets: [
        { type: "radio", bind: "selected", value: "{key}", action: "select", args: { id: "{key}" } },
        { type: "slider", bind: "items.{key}.value", action: "setItemValue", args: { id: "{key}" }, min: 0, max: 10, step: 1 },
        { type: "meter", stream: "item/{key}" },
        { type: "button", label: "Remove", action: "removeItem", args: { id: "{key}" }, style: "danger" },
      ],
    },
  },
];

const tool = createTool({
  id: "demo",
  title: "Demo",
  icon: "🧪",
  layout,
  initialState: { count: 0, enabled: false, level: 50, mode: "a", items: {}, selected: "", nextId: 1 },
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (v: unknown, name: string): number => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new RpcError(-32602, `${name} must be a number`);
  return v;
};
const str = (v: unknown, name: string): string => {
  if (typeof v !== "string") throw new RpcError(-32602, `${name} must be a string`);
  return v;
};

tool
  .action("increment", () => {
    const count = (tool.get("count") as number) + 1;
    tool.set("count", count);
    tool.log.info("incremented", { count });
    return { count };
  })
  .action("flaky", () => {
    if (Math.random() < 0.5) {
      tool.log.warn("flaky increment failed");
      throw new Error("Random failure (this is the demo of the failed dot)");
    }
    const count = (tool.get("count") as number) + 1;
    tool.set("count", count);
    return { count };
  })
  .action("slow", async (_args, ctx) => {
    for (let i = 1; i <= 5; i++) {
      await sleep(300);
      ctx.progress(`step ${i} of 5`, i / 5);
    }
    return "done";
  })
  .action("setEnabled", (args) => {
    if (typeof args.value !== "boolean") throw new RpcError(-32602, "value must be a boolean");
    tool.set("enabled", args.value);
  })
  .action("setLevel", async (args) => {
    const value = Math.round(num(args.value, "value"));
    await sleep(300); // pretend to be ddcutil
    tool.set("level", Math.max(0, Math.min(100, value)));
  })
  .action("setMode", (args) => {
    const value = str(args.value, "value");
    if (!["a", "b", "c"].includes(value)) throw new RpcError(-32602, `unknown mode ${value}`);
    tool.set("mode", value);
  })
  .action("addItem", () => {
    const id = String(tool.get("nextId"));
    tool.set("nextId", Number(id) + 1);
    const item: JsonObject = { name: `Item ${id}`, value: 5, order: Number(id) };
    tool.set(`items.${id}`, item);
    tool.log.info("item added", { id });
    return { id };
  })
  .action("removeItem", (args) => {
    const id = str(args.id, "id");
    if (tool.get(`items.${id}`) === undefined) throw new RpcError(-32000, `no item ${id}`);
    tool.delete(`items.${id}`);
    if (tool.get("selected") === id) tool.set("selected", "");
  })
  .action("select", (args) => {
    tool.set("selected", str(args.id, "id"));
  })
  .action("setItemValue", (args) => {
    const id = str(args.id, "id");
    if (tool.get(`items.${id}`) === undefined) throw new RpcError(-32000, `no item ${id}`);
    tool.set(`items.${id}.value`, num(args.value, "value"));
  })
  .stream("wave", ({ emit }) => {
    const t0 = Date.now();
    const timer = setInterval(() => emit((Math.sin((Date.now() - t0) / 300) + 1) / 2), 50);
    return () => clearInterval(timer);
  })
  .stream("item", ({ emit, param }) => {
    const timer = setInterval(() => {
      const v = tool.get(`items.${param}.value`);
      emit(typeof v === "number" ? (v / 10) * (0.7 + Math.random() * 0.3) : 0);
    }, 100);
    return () => clearInterval(timer);
  });

const cmd = process.argv[2];
if (cmd === "serve") {
  // Everything except "level" is owned by this process, so persisted values are the truth.
  for (const key of ["count", "enabled", "mode", "items", "selected", "nextId"]) tool.markFresh(key);
  // "level" pretends to live on a slow device: show the persisted value as stale, re-read it.
  if (!tool.isStale("level")) tool.markStale("level");
  setTimeout(() => tool.set("level", tool.get("level") as number), 1500);
  const serving = tool.serve();
  tool.log.info("demo tool serving"); // after serve(): logs go over the channel, not stderr
  await serving;
} else if (cmd === "status") {
  console.log(JSON.stringify(readPersistedState("demo") ?? {}, null, 2));
} else {
  console.error("usage: demo.ts serve | status");
  process.exit(2);
}
