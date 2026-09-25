/**
 * Conversation stream (right column, plan §包 E): user / assistant (markdown,
 * collapsed thinking, tool cards) / custom / compaction separators, plus the
 * in-flight streaming message and live tool calls. Finalized items are cached
 * by a render key so streaming deltas only rebuild the tail.
 */
import { clip, el, formatUsd } from "./dom.js";
import { renderMarkdown } from "./markdown.js";
import { renderToolCard, safeJson, toolView } from "./tools.js";
import { resultText } from "../state.js";

/** Plain text of a message's content (string or text blocks). @param {any} m */
export function messageText(m) {
  if (!m || typeof m !== "object") return "";
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) return resultText(m);
  for (const k of ["summary", "command", "output", "text"]) if (typeof m[k] === "string") return m[k];
  return m.content === undefined ? "" : safeJson(m.content, true);
}

/**
 * @param {import("../state.js").AgentState} a
 */
function indexTools(a) {
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
 * @param {import("../state.js").Item} it
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

/**
 * @param {Document} doc
 * @param {import("../state.js").AgentState} a
 * @param {Map<string, Node>} [cache] reused across renders; pruned to the keys used this time
 * @returns {Node[]}
 */
export function renderTranscript(doc, a, cache) {
  const idx = indexTools(a);
  /** @type {Node[]} */
  const out = [];
  /** @type {Set<string>} */
  const used = new Set();
  if (a.history === "loaded" && a.hasMore) {
    out.push(el(doc, "div", { class: "tx-more" }, a.paging ? "loading older…" : "scroll up for older messages"));
  }
  for (const it of a.items) {
    const rk = itemRenderKey(it, idx);
    used.add(rk);
    let node = cache?.get(rk);
    if (!node) {
      const built = renderItem(doc, it, idx);
      if (!built) continue;
      node = built;
      cache?.set(rk, node);
    }
    out.push(node);
  }
  if (a.streaming) {
    const s = renderAssistant(doc, a.streaming, idx, true);
    out.push(s);
  }
  for (const t of a.tools) {
    if (idx.called.has(t.toolCallId) || idx.results.has(t.toolCallId)) continue;
    out.push(el(doc, "div", { class: "msg msg-tool" }, [renderToolCard(doc, toolView(undefined, undefined, t))]));
  }
  if (a.history === "waiting") out.push(el(doc, "div", { class: "tx-status" }, "loading history…"));
  if (a.history === "error") {
    out.push(el(doc, "div", { class: "tx-status tx-error" }, `history unavailable: ${a.historyError ?? "error"}`));
  }
  if (cache) for (const k of [...cache.keys()]) if (!used.has(k)) cache.delete(k);
  return out;
}

/**
 * @param {Document} doc
 * @param {import("../state.js").Item} it
 * @param {ReturnType<typeof indexTools>} idx
 * @returns {Node | null}
 */
function renderItem(doc, it, idx) {
  const trunc = it.truncated ? el(doc, "span", { class: "badge badge-trunc" }, "truncated") : null;
  switch (it.kind) {
    case "compaction":
      return separator(doc, "compacted", it.entry?.summary, trunc);
    case "branch_summary":
      return separator(doc, "branch summary", it.entry?.summary, trunc);
    case "model_change": {
      const e = it.entry ?? {};
      const model = [e.provider, e.modelId].filter((x) => typeof x === "string" && x !== "").join("/");
      return el(doc, "div", { class: "tx-marker" }, `model → ${model || "?"}`);
    }
    case "custom": {
      const e = it.entry ?? {};
      const text =
        typeof e.content === "string" ? e.content : resultText({ content: e.content }) || safeJson(e.content, true);
      return customBlock(doc, String(e.customType ?? "custom"), text, trunc);
    }
    default:
      break;
  }
  const m = it.message;
  if (!m) return null;
  switch (m.role) {
    case "assistant": {
      const node = renderAssistant(doc, m, idx, false);
      if (trunc) node.appendChild(trunc);
      return node;
    }
    case "user":
      return el(doc, "div", { class: "msg msg-user" }, [
        el(doc, "div", { class: "msg-role" }, "user"),
        pre(doc, "msg-text", messageText(m)),
        trunc,
      ]);
    case "toolResult":
      if (idx.called.has(String(m.toolCallId ?? ""))) return null; // shown inside its tool card
      return el(doc, "div", { class: "msg msg-tool" }, [renderToolCard(doc, toolView(undefined, m, undefined))]);
    case "custom":
      if (m.display === false) return null;
      return customBlock(doc, String(m.customType ?? "custom"), messageText(m), trunc);
    default:
      return el(doc, "div", { class: `msg msg-other` }, [
        el(doc, "div", { class: "msg-role" }, String(m.role)),
        pre(doc, "msg-text", clip(messageText(m), 20_000)),
        trunc,
      ]);
  }
}

/**
 * @param {Document} doc
 * @param {any} m
 * @param {ReturnType<typeof indexTools>} idx
 * @param {boolean} streaming
 * @returns {HTMLElement}
 */
function renderAssistant(doc, m, idx, streaming) {
  const body = el(doc, "div", { class: "msg-body" });
  const blocks =
    typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? m.content : [];
  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text" && typeof b.text === "string") {
      body.appendChild(el(doc, "div", { class: "md" }, [renderMarkdown(b.text, doc)]));
    } else if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking !== "") {
      body.appendChild(
        el(doc, "details", { class: "thinking" }, [
          el(doc, "summary", null, "thinking"),
          pre(doc, "thinking-text", b.thinking),
        ]),
      );
    } else if (b.type === "toolCall") {
      const id = String(b.id ?? "");
      body.appendChild(renderToolCard(doc, toolView(b, idx.results.get(id), idx.live.get(id))));
    } else if (b.type === "image") {
      body.appendChild(el(doc, "div", { class: "tx-marker" }, "[image]"));
    }
  }
  const cost = m.usage?.cost?.total;
  const meta = [
    typeof m.model === "string" ? m.model : "",
    typeof cost === "number" ? formatUsd(cost) : "",
    streaming ? "streaming…" : "",
  ]
    .filter((x) => x !== "")
    .join(" · ");
  const errorText = m.stopReason === "error" && typeof m.errorMessage === "string" ? m.errorMessage : "";
  return el(doc, "div", { class: `msg msg-assistant${streaming ? " streaming" : ""}` }, [
    el(doc, "div", { class: "msg-role" }, "assistant"),
    body,
    errorText ? el(doc, "div", { class: "tx-error" }, errorText) : null,
    meta ? el(doc, "div", { class: "msg-meta" }, meta) : null,
  ]);
}

/** @param {Document} doc @param {string} label @param {unknown} summary @param {Node | null} trunc */
function separator(doc, label, summary, trunc) {
  const text = typeof summary === "string" ? summary : "";
  return el(doc, "details", { class: "tx-sep" }, [
    el(doc, "summary", null, [`── ${label} ──`, trunc]),
    text ? el(doc, "div", { class: "md" }, [renderMarkdown(text, doc)]) : null,
  ]);
}

/** @param {Document} doc @param {string} type @param {string} text @param {Node | null} trunc */
function customBlock(doc, type, text, trunc) {
  return el(doc, "div", { class: "msg msg-custom" }, [
    el(doc, "div", { class: "msg-role" }, clip(type, 80)),
    pre(doc, "msg-text", clip(text, 20_000)),
    trunc,
  ]);
}

/** @param {Document} doc @param {string} cls @param {string} text */
function pre(doc, cls, text) {
  const node = el(doc, "div", { class: cls });
  node.textContent = text;
  return node;
}
