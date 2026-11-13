/** Ref-counted, root-scoped CSSOM adaptation. No change outside registered terminal subtrees. */
const KEY = Symbol.for("pi-subagent:terminal-style-attributes:v1");
interface AdapterState {
  original: typeof Element.prototype.setAttribute;
  descriptor: PropertyDescriptor;
  roots: Map<HTMLElement, number>;
  wrapper: typeof Element.prototype.setAttribute;
}

export function installTerminalStyleAttributes(root: HTMLElement): () => void {
  const proto = root.ownerDocument.defaultView?.Element.prototype;
  if (!proto) throw new Error("Terminal unavailable: no Element prototype");
  const holder = proto as typeof proto & { [KEY]?: AdapterState };
  let state = holder[KEY];
  if (!state) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, "setAttribute");
    if (!descriptor || typeof descriptor.value !== "function")
      throw new Error("Terminal unavailable: DOM attribute adapter unsupported");
    const original = proto.setAttribute;
    const roots = new Map<HTMLElement, number>();
    const wrapper: typeof original = function (this: Element, name, value) {
      if (name === "style" && "style" in this && [...roots.keys()].some((registered) => registered.contains(this))) {
        (this as HTMLElement).style.cssText = value;
        return;
      }
      original.call(this, name, value);
    };
    state = { original, descriptor, roots, wrapper };
    Object.defineProperty(proto, "setAttribute", { ...descriptor, value: wrapper });
    Object.defineProperty(holder, KEY, { configurable: true, value: state });
  }
  if (!state.roots.has(root) && state.roots.size >= 32)
    throw new Error("Terminal unavailable: CSSOM adapter root capacity reached");
  state.roots.set(root, (state.roots.get(root) ?? 0) + 1);
  const owned = state;
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const refs = owned.roots.get(root) ?? 0;
    if (refs > 1) owned.roots.set(root, refs - 1);
    else owned.roots.delete(root);
    if (!owned.roots.size) {
      if (proto.setAttribute === owned.wrapper) Object.defineProperty(proto, "setAttribute", owned.descriptor);
      Reflect.deleteProperty(holder, KEY);
    }
  };
}
