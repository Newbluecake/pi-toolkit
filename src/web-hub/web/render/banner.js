/**
 * `blocked on dialog (kind, title)` banner (plan §包 E; spike K8: ask_user and
 * built-in selectors both surface as kind `custom` with no title — shown
 * verbatim as `custom`).
 */
import { clip, el } from "./dom.js";

/**
 * @param {unknown} prompts  AgentCard["prompts"]
 * @returns {string | null}
 */
export function bannerText(prompts) {
  if (!Array.isArray(prompts) || prompts.length === 0) return null;
  const valid = prompts.filter((p) => p && typeof p.kind === "string");
  if (valid.length === 0) return null;
  // most recent (innermost) dialog is the one actually blocking
  const top = valid.reduce((a, b) => ((b.since ?? 0) >= (a.since ?? 0) ? b : a));
  const title = typeof top.title === "string" && top.title.trim() !== "" ? `, ${clip(top.title.trim(), 120)}` : "";
  const more = valid.length > 1 ? ` +${valid.length - 1}` : "";
  return `blocked on dialog (${top.kind}${title})${more}`;
}

/**
 * @param {Document} doc
 * @param {unknown} prompts
 * @returns {HTMLElement | null}
 */
export function renderBanner(doc, prompts) {
  const text = bannerText(prompts);
  if (text === null) return null;
  return el(doc, "div", { class: "banner banner-dialog", role: "status", "aria-live": "polite" }, text);
}
