/**
 * Minimal, XSS-safe DOM builder shared by the render modules (plan §包 E 安全).
 *
 * Every render module restricts itself to this DOM subset — which is also all
 * the tests' fake document implements:
 *   doc.createElement / createTextNode / createDocumentFragment,
 *   node.appendChild / setAttribute / replaceChildren / addEventListener,
 *   node.textContent = string.
 * Text only ever enters the DOM via createTextNode / textContent. Attribute
 * names are whitelisted so no event-handler or style attribute can be set.
 */

const ALLOWED_ATTRS = new Set([
  "class",
  "href",
  "title",
  "rel",
  "target",
  "hidden",
  "open",
  "role",
  "tabindex",
  "aria-label",
  "aria-live",
  "aria-current",
  "data-key",
  "data-state",
  "data-depth",
]);

/**
 * @param {Document} doc
 * @param {string} tag
 * @param {Record<string, string | boolean | undefined> | null} [attrs]
 * @param {Array<Node | string | null | undefined | false> | Node | string | null} [children]
 * @returns {HTMLElement}
 */
export function el(doc, tag, attrs, children) {
  const node = doc.createElement(tag);
  if (attrs) {
    for (const name of Object.keys(attrs)) {
      const v = attrs[name];
      if (v === undefined || v === false) continue;
      if (!ALLOWED_ATTRS.has(name)) throw new Error(`attribute not allowed: ${name}`);
      node.setAttribute(name, v === true ? "" : String(v));
    }
  }
  appendAll(doc, node, children);
  return node;
}

/**
 * @param {Document} doc
 * @param {Node} parent
 * @param {Array<Node | string | null | undefined | false> | Node | string | null | undefined} children
 */
export function appendAll(doc, parent, children) {
  if (children === null || children === undefined) return;
  const list = Array.isArray(children) ? children : [children];
  for (const c of list) {
    if (c === null || c === undefined || c === false) continue;
    parent.appendChild(typeof c === "string" ? doc.createTextNode(c) : c);
  }
}

/** Human cost: `$0.0123` / `$1.23`, `—` when unknown. @param {unknown} n */
export function formatUsd(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  if (n === 0) return "$0";
  return n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

/** Compact duration: `42s`, `3m05s`, `1h02m`. @param {unknown} ms */
export function formatDuration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** Truncate a display string to `max` chars with an ellipsis. @param {string} s @param {number} max */
export function clip(s, max) {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}
