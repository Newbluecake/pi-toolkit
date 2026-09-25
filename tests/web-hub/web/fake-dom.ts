/**
 * Tiny fake DOM for render tests (no jsdom in the repo). Implements exactly
 * the subset documented in `src/web-hub/web/render/dom.js`; anything else
 * (innerHTML included) is deliberately absent so misuse throws.
 */

export class FakeNode {
  childNodes: FakeNode[] = [];
  parent: FakeNode | null = null;
  constructor(
    readonly nodeType: number,
    readonly nodeName: string,
    public data = "",
  ) {}

  appendChild(child: FakeNode): FakeNode {
    if (child.nodeType === 11) {
      for (const c of [...child.childNodes]) this.appendChild(c);
      child.childNodes = [];
      return child;
    }
    if (child.parent) child.parent.childNodes = child.parent.childNodes.filter((c) => c !== child);
    child.parent = this;
    this.childNodes.push(child);
    return child;
  }

  replaceChildren(...nodes: FakeNode[]): void {
    for (const c of this.childNodes) c.parent = null;
    this.childNodes = [];
    for (const n of nodes) this.appendChild(n);
  }

  get textContent(): string {
    if (this.nodeType === 3) return this.data;
    return this.childNodes.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    if (this.nodeType === 3) {
      this.data = v;
      return;
    }
    this.replaceChildren(new FakeNode(3, "#text", String(v)));
  }
}

export class FakeElement extends FakeNode {
  attributes = new Map<string, string>();
  listeners = new Map<string, Array<(ev: unknown) => void>>();
  constructor(readonly tagName: string) {
    super(1, tagName.toUpperCase());
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  addEventListener(type: string, fn: (ev: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  dispatch(type: string, ev: unknown = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
  get className(): string {
    return this.attributes.get("class") ?? "";
  }
}

export function fakeDocument() {
  return {
    createElement: (tag: string) => new FakeElement(tag.toLowerCase()),
    createTextNode: (text: string) => new FakeNode(3, "#text", String(text)),
    createDocumentFragment: () => new FakeNode(11, "#document-fragment"),
  };
}

/** Depth-first element list. */
export function allElements(root: FakeNode): FakeElement[] {
  const out: FakeElement[] = [];
  const walk = (n: FakeNode) => {
    if (n instanceof FakeElement) out.push(n);
    for (const c of n.childNodes) walk(c);
  };
  walk(root);
  return out;
}

export function byClass(root: FakeNode, cls: string): FakeElement[] {
  return allElements(root).filter((e) => e.className.split(/\s+/).includes(cls));
}

export function byTag(root: FakeNode, tag: string): FakeElement[] {
  return allElements(root).filter((e) => e.tagName === tag);
}
