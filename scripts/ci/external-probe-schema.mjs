/** Closed parent-only H4 evidence. No arbitrary strings survive validation. */
export const EXTERNAL_MARKER = "T51_EXTERNAL_V1 ";
export const EXTERNAL_PUBLIC = "PI_TOOLKIT_T51_EXTERNAL_DIAG";
export const EXTERNAL_PERMIT = "PI_TOOLKIT_T51_EXTERNAL_ONCE";
export const EXTERNAL_SELECTION = "existing-zero-first-v1";
const stages = [
  "starting",
  "sdk-profile",
  "sdk-import",
  "settings",
  "loader-create",
  "loader-reload",
  "extensions",
  "receipt",
  "unknown",
];
const reasons = ["deadline", "child-failed", "spawn-error", "receipt", "output-limit", "success", "unknown"];
const keys = (v, names) =>
  v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).sort().join(",") === [...names].sort().join(",");
const ms = (v) => Number.isInteger(v) && v >= 0 && v <= 30000;
function event(v, asOfMs) {
  if (!keys(v, ["state", "ms", "code", "signal"])) return false;
  if (v.state === "not-seen-as-of") return v.ms === null && v.code === "unknown" && v.signal === "unknown";
  return (
    v.state === "seen" &&
    ms(v.ms) &&
    v.ms <= asOfMs &&
    ["zero", "probe75", "other", "unknown"].includes(v.code) &&
    ["none", "kill", "term", "abort", "other", "unknown"].includes(v.signal)
  );
}
export function validExternal(v) {
  return !!(
    keys(v, ["selection", "product", "asOfMs", "exit", "close", "lastStage", "reason", "truncated"]) &&
    ["existing-zero-first", "not-armed"].includes(v.selection) &&
    ["observed-pass", "observed-fail", "not-run"].includes(v.product) &&
    ms(v.asOfMs) &&
    event(v.exit, v.asOfMs) &&
    event(v.close, v.asOfMs) &&
    stages.includes(v.lastStage) &&
    reasons.includes(v.reason) &&
    typeof v.truncated === "boolean"
  );
}
export const unseenExternal = () => ({ state: "not-seen-as-of", ms: null, code: "unknown", signal: "unknown" });
export function unarmedExternal() {
  return {
    selection: "not-armed",
    product: "not-run",
    asOfMs: 0,
    exit: unseenExternal(),
    close: unseenExternal(),
    lastStage: "unknown",
    reason: "unknown",
    truncated: false,
  };
}
export function canonicalExternal(v) {
  if (!validExternal(v)) throw Error("invalid external evidence");
  // Explicit reconstruction fixes key order and never forwards input prototypes/extra keys.
  const copyEvent = (e) => ({ state: e.state, ms: e.ms, code: e.code, signal: e.signal });
  const text = JSON.stringify({
    selection: v.selection,
    product: v.product,
    asOfMs: v.asOfMs,
    exit: copyEvent(v.exit),
    close: copyEvent(v.close),
    lastStage: v.lastStage,
    reason: v.reason,
    truncated: v.truncated,
  });
  if (Buffer.byteLength(EXTERNAL_MARKER + text + "\n") > 2048) throw Error("oversize external evidence");
  return text;
}
/** One marker per stream. Vitest may copy the SAME canonical line to another
 * stream/report; only those identical copies can be deduplicated. Never concat streams. */
export function extractExternal(streams) {
  const found = [];
  for (const raw of streams) {
    if (typeof raw !== "string" || Buffer.byteLength(raw) > 16 * 1024 * 1024) throw Error("invalid stream");
    const lines = raw.split(/\r?\n/).filter((line) => line.includes(EXTERNAL_MARKER));
    if (lines.length > 1) throw Error("duplicate external evidence");
    if (!lines.length) continue;
    const line = lines[0];
    const text = line.slice(line.indexOf(EXTERNAL_MARKER) + EXTERNAL_MARKER.length);
    if (Buffer.byteLength(text) > 2048) throw Error("oversize external evidence");
    found.push(canonicalExternal(JSON.parse(text)));
  }
  if (!found.length || new Set(found).size !== 1) throw Error("missing/conflicting external evidence");
  return JSON.parse(found[0]);
}
