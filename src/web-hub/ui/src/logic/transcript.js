/**
 * Conversation stream item helpers (vue-plan.md v2.1 §3.1/§3.2, §5.2 — P5b cleanup): plain text
 * extraction and render-key computation for transcript items.
 *
 * DOM rendering (`renderTranscript`/`renderItem`/`renderAssistant`/`separator`/`customBlock`/
 * `pre`, built on the legacy `render/dom.js`'s `el()`, plus the private `indexTools` helper they
 * depended on) is deleted here (P5b, §3.1's disposition table: "保留 messageText/itemRenderKey
 * （导出 indexTools）；renderTranscript/renderItem 等 P5b 删") — the Vue UI renders the same
 * items with `Transcript.vue`/`entries.ts` (§3.2/§5.2 P4), whose own `tool-index.ts` was a
 * pre-P5b TS port of the private `indexTools` this file used to keep unexported; `indexTools`
 * is exported here instead of duplicated now that the DOM-only callers that used to keep it
 * private are gone.
 */
import { safeJson } from "./tools.js";
import { resultText } from "./state.js";

/** Plain text of a message's content (string or text blocks). @param {any} m */
export function messageText(m) {
  if (!m || typeof m !== "object") return "";
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) return resultText(m);
  for (const k of ["summary", "command", "output", "text"]) if (typeof m[k] === "string") return m[k];
  return m.content === undefined ? "" : safeJson(m.content, true);
}

/**
 * @param {import("./state.js").AgentState} a
 */
export function indexTools(a) {
  /** @type {Map<string, any>} */
  const results = new Map();
  /** @type {Set<string>} */
  const called = new Set();
  const scan = (/** @type {any} */ m) => {
    if (!m || !Array.isArray(m.content)) return;
    for (const b of m.content)
      if (b && b.type === "toolCall" && typeof b.id === "string" && b.id !== "") called.add(b.id);
  };
  for (const it of a.items) {
    const m = it.message;
    if (!m) continue;
    if (m.role === "toolResult" && typeof m.toolCallId === "string") results.set(m.toolCallId, m);
    else if (m.role === "assistant") scan(m);
  }
  if (a.streaming) scan(a.streaming);
  /** @type {Map<string, any>} */
  const live = new Map();
  for (const t of a.tools) live.set(t.toolCallId, t);
  return { results, called, live };
}

/**
 * Render key: changes whenever the item's DOM would change.
 * @param {import("./state.js").Item} it
 * @param {{ results: Map<string, any>, live: Map<string, any> }} idx
 */
export function itemRenderKey(it, idx) {
  const m = it.message;
  if (!m || m.role !== "assistant" || !Array.isArray(m.content)) return it.id;
  const sig = [];
  for (const b of m.content) {
    if (!b || b.type !== "toolCall") continue;
    const id = String(b.id ?? "");
    if (idx.results.has(id)) sig.push(`${id}=r`);
    else {
      const t = idx.live.get(id);
      sig.push(t ? `${id}=${t.done ? "d" : "l"}${String(t.partial ?? "").length}` : `${id}=p`);
    }
  }
  return sig.length ? `${it.id}|${sig.join(",")}` : it.id;
}
