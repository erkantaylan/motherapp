import { defineConfig } from "vite";

// In development the core runs on 7323 (or MOTHERAPP_PORT) and Vite proxies to it.
const core = `http://127.0.0.1:${process.env.MOTHERAPP_PORT ?? "7323"}`;

// Minimal PostCSS node shapes, so this file needs no postcss types.
interface CssNode {
  type: string;
  parent?: CssNode;
  name?: string;
  params?: string;
}
interface CssDecl extends CssNode {
  prop: string;
  value: string;
}
interface CssAtRule extends CssNode {
  params: string;
}
interface CssRoot {
  walkDecls(cb: (d: CssDecl) => void): void;
  walkAtRules(name: string, cb: (r: CssAtRule) => void): void;
}

const inCustomLayer = (node: CssNode): boolean => {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === "atrule" && p.name === "layer" && p.params?.trim() === "custom") return true;
  }
  return false;
};

/**
 * Bootstrap 6's Sass writes its custom properties unprefixed; its dist CSS adds `--bs-` with
 * PostCSS. Do the same here, so Bootstrap's `--fg`/`--bg` utility properties (registered with
 * `inherits: false`) can't clash with the shell's theme variables of the same name. Our own
 * rules live in `@layer custom` and are left alone (web/src/styles.scss).
 */
const bsPrefix = {
  postcssPlugin: "motherapp-bs-prefix",
  Once(root: CssRoot) {
    const name = (s: string) => s.replace(/^--(?!bs-)/, "--bs-");
    const refs = (s: string) => s.replace(/var\(\s*--(?!bs-)/g, "var(--bs-");
    root.walkAtRules("property", (r) => {
      if (!inCustomLayer(r)) r.params = name(r.params.trim());
    });
    root.walkDecls((d) => {
      if (inCustomLayer(d)) return;
      d.prop = name(d.prop);
      if (d.value.includes("var(")) d.value = refs(d.value);
    });
  },
};

export default defineConfig({
  css: {
    postcss: { plugins: [bsPrefix] },
    preprocessorOptions: {
      scss: { loadPaths: ["../node_modules"] },
    },
  },
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
    // Bootstrap 6 needs light-dark(), oklch() and color-mix(). With an older CSS target the
    // minifier rewrites every light-dark() into a polyfill, which doubles the CSS.
    cssTarget: ["chrome123", "edge123", "firefox120", "safari17.5"],
  },
});
