// `{key}`, `{path}` and `{field}` placeholders in list item templates. DOM-free.
import type { JsonValue, Widget } from "@motherapp/protocol";

export interface TemplateContext {
  key: string;
  path: string;
  item: unknown;
}

const PLACEHOLDER = /\{([A-Za-z0-9_$-]+)\}/g;

export function interpolate(s: string, ctx: TemplateContext): string {
  return s.replace(PLACEHOLDER, (_m, name: string) => {
    if (name === "key") return ctx.key;
    if (name === "path") return ctx.path;
    const item = ctx.item;
    if (typeof item === "object" && item !== null && !Array.isArray(item)) {
      const v = (item as Record<string, unknown>)[name];
      if (v === undefined || v === null) return "";
      return typeof v === "object" ? JSON.stringify(v) : String(v);
    }
    return "";
  });
}

function deep(v: JsonValue, ctx: TemplateContext): JsonValue {
  if (typeof v === "string") return interpolate(v, ctx);
  if (Array.isArray(v)) return v.map((x) => deep(x, ctx));
  if (typeof v === "object" && v !== null) {
    const out: { [k: string]: JsonValue } = {};
    for (const [k, x] of Object.entries(v)) out[k] = deep(x, ctx);
    return out;
  }
  return v;
}

/** Copy of `w` with every string interpolated. A nested list's own item template is left alone. */
export function interpolateWidget(w: Widget, ctx: TemplateContext): Widget {
  if (w.type === "list") {
    const { item, ...rest } = w;
    return { ...(deep(rest as unknown as JsonValue, ctx) as unknown as Omit<typeof w, "item">), item };
  }
  return deep(w as unknown as JsonValue, ctx) as unknown as Widget;
}
