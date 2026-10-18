/**
 * Tool call view model (vue-plan.md v2.1 §3.1, §5.2 — P5b cleanup): a `ToolView` combining a
 * transcript `toolCall` content block, an optional `toolResult` message, and optional live
 * `tool_execution_*` state into one running/done/error/pending shape.
 *
 * DOM rendering (`renderToolCard`/`pre`, built on the legacy `render/dom.js`'s `el()`) is
 * deleted here (P5b, §3.1's disposition table: "保留 toolView/summarizeArgs/safeJson；
 * renderToolCard/pre P5b 删") — the Vue UI renders the same `ToolView` with `ToolCard.vue`
 * (§3.2/§5.2 P4).
 */
import { clip } from "../format";
import { resultText } from "./state.js";

/**
 * @typedef {{ toolCallId: string, toolName: string, args: unknown,
 *   state: "running" | "done" | "error" | "pending",
 *   partial?: string, result?: string, truncated?: boolean,
 *   durationMs?: number, runningSince?: number,
 *   runRef?: { runId: string, label?: string } }} ToolView
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
 * Subagent-tool result `details` → `{runId,label?}` (append-only optional; the agent side adds
 * it for steer/abort/extend/set_model/get_subagent_result). Anything malformed ⇒ undefined.
 * @param {any} src  toolResult message or live result (`{ details }`)
 * @returns {{ runId: string, label?: string } | undefined}
 */
/** Tools whose result `details` carry the resolved run (`{runId,label}`) for the header. */
export const RUN_REF_TOOLS = new Set([
  "steer_subagent",
  "abort_subagent",
  "extend_subagent_timeout",
  "get_subagent_result",
  "set_model",
]);

/** Header text for a card whose run is known: `label (run_id: r_x)`; no label ⇒ undefined (raw args stay). */
export function runRefHeader(view) {
  const rr = view?.runRef;
  if (!rr || rr.label === undefined) return undefined;
  return `${rr.label} (run_id: ${rr.runId})`;
}

export function runRefOf(src) {
  const d = src?.details;
  if (!d || typeof d !== "object") return undefined;
  const runId = d.runId;
  if (typeof runId !== "string" || runId === "") return undefined;
  const label = typeof d.label === "string" ? d.label.replace(/\s+/g, " ").trim() : "";
  return label === "" ? { runId } : { runId, label: label.length > 48 ? `${label.slice(0, 47)}…` : label };
}

/**
 * Build a ToolView from a transcript toolCall block + optional toolResult
 * message + optional live tool state (from `tool_execution_*`) + the optional
 * toolCallId → durationMs map (tool-duration plan: live `tool_execution_end.durationMs`
 * frames and history `subagent:web-tool-timing` entries merged by the reducer).
 * @param {any} call  `{ id, name, arguments }` content block (may be undefined for orphan results)
 * @param {any} [resultMsg]  toolResult message
 * @param {any} [live]  LiveTool
 * @param {ReadonlyMap<string, number>} [durations]  toolCallId → durationMs (agent clock)
 * @returns {ToolView}
 */
export function toolView(call, resultMsg, live, durations) {
  const toolCallId = String(call?.id ?? resultMsg?.toolCallId ?? live?.toolCallId ?? "");
  const toolName = String(call?.name ?? resultMsg?.toolName ?? live?.toolName ?? "tool");
  const args = call?.arguments ?? live?.args ?? (call?.partialJson ? call.partialJson : undefined);
  /** @type {ToolView} */
  const view = { toolCallId, toolName, args, state: "pending" };
  if (resultMsg) {
    view.state = resultMsg.isError === true ? "error" : "done";
    view.result = resultText(resultMsg);
    if (resultMsg.truncated === true) view.truncated = true;
    const rr = RUN_REF_TOOLS.has(toolName) ? runRefOf(resultMsg) : undefined;
    if (rr) view.runRef = rr;
  } else if (live) {
    if (live.done) {
      view.state = live.isError ? "error" : "done";
      view.result = resultText(live.result);
      const rr = RUN_REF_TOOLS.has(toolName) ? runRefOf(live.result) : undefined;
      if (rr) view.runRef = rr;
    } else {
      view.state = "running";
      // browser-clock receipt: the ticking chip computes elapsed against a local ticker's now
      if (typeof live.seenAt === "number" && Number.isFinite(live.seenAt)) view.runningSince = live.seenAt;
    }
    if (typeof live.partial === "string" && !live.done) view.partial = live.partial;
    if (live.truncated === true) view.truncated = true;
  }
  const dur = durations?.get(toolCallId);
  if (view.state !== "running" && typeof dur === "number" && Number.isFinite(dur) && dur >= 0) view.durationMs = dur;
  if (!view.truncated && /\[truncated\b/i.test(view.result ?? "")) view.truncated = true;
  return view;
}
