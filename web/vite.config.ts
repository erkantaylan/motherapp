import { defineConfig } from "vite";

// In development the core runs on 7323 (or MOTHERAPP_PORT) and Vite proxies to it.
const core = `http://127.0.0.1:${process.env.MOTHERAPP_PORT ?? "7323"}`;

export default defineConfig({
  server: {
    host: "127.0.0.1",
    proxy: {
      "/ws": { target: core, ws: true },
      "/tools": { target: core },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
  },
});
