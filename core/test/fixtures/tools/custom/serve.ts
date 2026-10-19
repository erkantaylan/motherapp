import { createTool } from "@motherapp/tool-sdk";
await createTool({ id: "custom", title: "Custom fixture", page: "custom", persist: false }).serve();
