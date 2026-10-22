/**
 * One `ResizeObserver` shared by every observer of the page (a long agent list would otherwise
 * mint one observer per card). `observeResize` returns the unsubscribe function; environments
 * without `ResizeObserver` (happy-dom, old browsers) get a no-op — callers still measure once
 * on mount, so the result merely stops being live.
 */
type Cb = () => void;

let shared: ResizeObserver | null = null;
const callbacks = new Map<Element, Set<Cb>>();

export function observeResize(el: Element, cb: Cb): () => void {
  if (typeof ResizeObserver === "undefined") return () => {};
  shared ??= new ResizeObserver((entries) => {
    for (const e of entries) for (const fn of callbacks.get(e.target) ?? []) fn();
  });
  let set = callbacks.get(el);
  if (set === undefined) {
    set = new Set();
    callbacks.set(el, set);
    shared.observe(el);
  }
  set.add(cb);
  return () => {
    const s = callbacks.get(el);
    if (s === undefined) return;
    s.delete(cb);
    if (s.size === 0) {
      callbacks.delete(el);
      shared?.unobserve(el);
    }
  };
}
