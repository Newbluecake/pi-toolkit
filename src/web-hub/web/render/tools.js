/**
 * Tool cards (plan §包 E): a collapsed `<details>` per tool call showing
 * name + one-line args summary, expanding to args / partial output / result.
 * Truncated payloads (agent-side 64 KiB cap) carry a visible marker.
 */
import { clip, el } from "./dom.js";
import { resultText } from "../state.js";

/**
 * @typedef {{ toolCallId: string, toolName: string, args: unknown,
 *   state: "running" | "done" | "error" | "pending",
 *   partial?: string, result?: string, truncated?: boolean }} ToolView
 */

const SUMMARY_KEYS = ["command", "path", "file_path", "pattern", "query", "url", "description", "prompt"];

/** One-line args summary: well-known key first, else compact JSON. @param {unknown} args */
export function summarizeArgs(args) {
  if (args === undefined || args === null) return "";
  if (typeof args === "string") return clip(args.replace(/\s+/g, " "), 120);
  if (typeof args !== "object") return clip(String(args), 120);
  const rec = /** @type {Record<string, unknown>} */ (args);
  for (const k of SUMMARY_KEYS) {
    const v = rec[k];
    if (typeof v === "string" && v !== "") return clip(v.replace(/\s+/g, " "), 120);
  }
  return clip(safeJson(args, false).replace(/\s+/g, " "), 120);
}

/** @param {unknown} v @param {boolean} pretty */
export function safeJson(v, pretty) {
  try {
    const s = JSON.stringify(v, null, pretty ? 2 : undefined);
    return typeof s === "string" ? s : String(v);
  } catch {
    return "[unserializable]";
  }
}

/**
 * Build a ToolView from a transcript toolCall block + optional toolResult
 * message + optional live tool state (from `tool_execution_*`).
 * @param {any} call  `{ id, name, arguments }` content block (may be undefined for orphan results)
 * @param {any} [resultMsg]  toolResult message
 * @param {any} [live]  LiveTool
 * @returns {ToolView}
 */
export function toolView(call, resultMsg, live) {
  const toolCallId = String(call?.id ?? resultMsg?.toolCallId ?? live?.toolCallId ?? "");
  const toolName = String(call?.name ?? resultMsg?.toolName ?? live?.toolName ?? "tool");
  const args = call?.arguments ?? live?.args ?? (call?.partialJson ? call.partialJson : undefined);
  /** @type {ToolView} */
  const view = { toolCallId, toolName, args, state: "pending" };
  if (resultMsg) {
    view.state = resultMsg.isError === true ? "error" : "done";
    view.result = resultText(resultMsg);
    if (resultMsg.truncated === true) view.truncated = true;
  } else if (live) {
    if (live.done) {
      view.state = live.isError ? "error" : "done";
      view.result = resultText(live.result);
    } else view.state = "running";
    if (typeof live.partial === "string" && !live.done) view.partial = live.partial;
    if (live.truncated === true) view.truncated = true;
  }
  if (!view.truncated && /\[truncated\b/i.test(view.result ?? "")) view.truncated = true;
  return view;
}

const STATE_MARK = { running: "▸", done: "✓", error: "✗", pending: "·" };

/**
 * @param {Document} doc
 * @param {ToolView} v
 * @returns {HTMLElement}
 */
export function renderToolCard(doc, v) {
  const summary = el(doc, "summary", { class: "tool-sum" }, [
    el(doc, "span", { class: `tool-mark tool-${v.state}` }, STATE_MARK[v.state]),
    el(doc, "span", { class: "tool-name" }, v.toolName),
    el(doc, "span", { class: "tool-args" }, summarizeArgs(v.args)),
    v.truncated ? el(doc, "span", { class: "badge badge-trunc", title: "payload truncated" }, "truncated") : null,
  ]);
  const body = el(doc, "div", { class: "tool-body" });
  if (v.args !== undefined)
    body.appendChild(pre(doc, "tool-in", typeof v.args === "string" ? v.args : safeJson(v.args, true)));
  if (v.partial !== undefined && v.partial !== "") body.appendChild(pre(doc, "tool-partial", v.partial));
  if (v.result !== undefined)
    body.appendChild(pre(doc, v.state === "error" ? "tool-out tool-err" : "tool-out", v.result));
  return el(doc, "details", { class: `tool tool-${v.state}`, "data-key": v.toolCallId }, [summary, body]);
}

/** @param {Document} doc @param {string} cls @param {string} text */
function pre(doc, cls, text) {
  const node = el(doc, "pre", { class: cls });
  node.textContent = text;
  return node;
}
