/**
 * `blocked on dialog (kind, title)` banner text (vue-plan.md v2.1 §3.1, §5.2 — P5b cleanup):
 * spike K8: `ask_user` and built-in selectors both surface as kind `custom` with no title —
 * shown verbatim as `custom`.
 *
 * DOM rendering (`renderBanner`, built on the legacy `render/dom.js`'s `el()`) is deleted here
 * (P5b, §3.1's disposition table: "保留 bannerText；renderBanner P5b 删") — the Vue UI surfaces
 * the same "blocked on a dialog" condition through `NoticeStack.vue`/`NoticeBanner.vue`
 * (§3.2/§5.2 P3) instead of a bespoke DOM node.
 */
import { clip } from "../format";

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
