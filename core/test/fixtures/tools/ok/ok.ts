// Test fixture tool built on the SDK.
import { createTool } from "@motherapp/tool-sdk";

const tool = createTool({
  id: "ok",
  title: "OK fixture",
  layout: [{ type: "text", bind: "n" }],
  initialState: { n: 0, nested: { a: 1 } },
  persist: false,
});
tool
  .action("inc", () => {
    const n = (tool.get("n") as number) + 1;
    tool.set("n", n);
    tool.log.info("inc", { n });
    return n;
  })
  .action("fail", () => {
    throw new Error("nope");
  })
  .action("stderr", () => {
    process.stderr.write("something went wrong\n");
  })
  .action("exit", () => {
    setTimeout(() => process.exit(1), 10);
  })
  .stream("tick", ({ emit }) => {
    const t = setInterval(() => emit(1), 20);
    return () => clearInterval(t);
  });
// The SDK's view of the core's `watch` edges, for core/test/watch.test.ts.
tool.onWatch((w) => tool.set("watching", w));
await tool.serve();
