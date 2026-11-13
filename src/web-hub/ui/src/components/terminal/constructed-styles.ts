/**
 * xterm 6.0.0-only CSS bridge. The document factory is patched ONLY during synchronous open;
 * it returns hidden non-style placeholders, never empty style nodes (those also violate CSP).
 * Known injection set: DomRenderer dimensions/theme + Viewport scrollbar. Subsequent writes
 * go synchronously to constructed sheets. No xterm private API or node_modules patch.
 */
export function captureTerminalStyles<T>(
  root: HTMLElement,
  version: string,
  open: () => T,
): {
  value: T;
  dispose(): void;
} {
  if (version !== "6.0.0") throw new Error(`Terminal unavailable: unsupported xterm ${version} (requires 6.0.0)`);
  const doc = root.ownerDocument;
  const Sheet = doc.defaultView?.CSSStyleSheet;
  if (!Sheet || !("adoptedStyleSheets" in doc) || !("replaceSync" in Sheet.prototype)) {
    throw new Error("Terminal unavailable: constructed stylesheets are not supported");
  }
  const owner = `pwh-terminal-${crypto.getRandomValues(new Uint32Array(2)).join("-")}`;
  root.classList.add(owner);
  const original = doc.createElement;
  const own = Object.getOwnPropertyDescriptor(doc, "createElement");
  const entries: Array<{ element: HTMLElement; sheet: CSSStyleSheet; kind?: string }> = [];
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    const owned = new Set(entries.map((entry) => entry.sheet));
    doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((sheet) => !owned.has(sheet));
    for (const { element } of entries) element.remove();
    root.classList.remove(owner);
  };
  const classify = (text: string) => {
    if (/^\.xterm-dom-renderer-owner-\d+ \.xterm-rows span \{/.test(text)) return "dimensions";
    if (/^\.xterm-dom-renderer-owner-\d+ \.xterm-rows \{/.test(text)) return "theme";
    if (/^\.xterm \.xterm-scrollable-element > \.scrollbar > \.slider \{/.test(text)) return "scrollbar";
    throw new Error("Terminal unavailable: unknown xterm stylesheet injection");
  };
  Object.defineProperty(doc, "createElement", {
    configurable: true,
    writable: true,
    value(tag: string, options?: ElementCreationOptions) {
      if (tag.toLowerCase() !== "style") return original.call(doc, tag, options);
      const element = original.call(doc, "span") as HTMLElement;
      element.hidden = true;
      const sheet = new Sheet();
      const entry: (typeof entries)[number] = { element, sheet };
      let text = "";
      Object.defineProperty(element, "textContent", {
        configurable: true,
        get: () => text,
        set(value: string | null) {
          if (disposed) return;
          const next = value ?? "";
          const kind = classify(next);
          if ((entry.kind && entry.kind !== kind) || entries.some((e) => e !== entry && e.kind === kind)) {
            throw new Error("Terminal unavailable: changed xterm stylesheet injection set");
          }
          entry.kind = kind;
          element.dataset["terminalStyleBridge"] = kind;
          text = next;
          // xterm's scrollbar selector is global; scope it to this registered root so
          // one terminal's theme cannot recolor another terminal's scrollbar.
          sheet.replaceSync(
            next.replace(/\.xterm \.xterm-scrollable-element/g, `.${owner} .xterm .xterm-scrollable-element`),
          );
        },
      });
      entries.push(entry);
      doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
      return element;
    },
  });
  try {
    const value = open();
    if (entries.length !== 3 || new Set(entries.map((e) => e.kind)).size !== 3 || entries.some((e) => !e.kind)) {
      throw new Error(`Terminal unavailable: xterm stylesheet injection set changed (${entries.length}/3)`);
    }
    return { value, dispose };
  } catch (error) {
    dispose();
    throw error;
  } finally {
    if (own) Object.defineProperty(doc, "createElement", own);
    else Reflect.deleteProperty(doc, "createElement");
  }
}
