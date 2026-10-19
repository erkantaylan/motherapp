/// <reference lib="dom" />
import type { PageElement, PageContext } from "@motherapp/protocol/page";

export default class CustomPage extends HTMLElement implements PageElement {
  ctx?: PageContext;
  connectedCallback(): void {
    const n: number = 1;
    this.textContent = `custom page ${n} for ${this.ctx?.toolId ?? "?"}`;
  }
}
