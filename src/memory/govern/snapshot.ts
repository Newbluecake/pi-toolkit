// #36 arch r5 §5.3 原则③ — deterministic state-snapshot detection (pi-free,
// pure). A "state snapshot" block records a transient project state (run id,
// quota reading, progress, current commit) instead of a durable conclusion;
// such blocks go stale silently. Detection is a fixed regex set — no model
// call. On hit (agent block, no expires/until) the write still succeeds; the
// tool echoes the strong `state snapshot:` advice line, and after 7 days the
// sweep (P5a) turns it into a `snapshot` review suggestion.
//
// User rules are exempt from every snapshot prompt (arch §5.3 用户令豁免) —
// the caller checks authority; this module only answers "does the body read
// like a state snapshot?".

const RUN_ID_RE = /\br_[A-Za-z0-9]{6,}\b/;
const HEAD_RE = /(?:\bHEAD\s*|@\s*)[0-9a-f]{7,40}\b/;
/** 8–40 hex digits in the SAME SENTENCE as a "right now" word. */
const HEX_RE = /\b[0-9a-f]{8,40}\b/;
const CURRENT_WORDS = ["当前", "现在", "目前"];

/** Quota vocabulary within 30 code points of the percentage. */
const QUOTA_WORDS: readonly string[] = ["quota", "额度", "5h", "7d", "week", "窗口"];
const QUOTA_WINDOW_CP = 30;
const PROGRESS_RE = /进度|已完成\s*\d+\s*\/\s*\d+|进行中|修复中|待办|暂停|已关|目前|当前(?!会话)|还没|尚未/;

/** Split into sentences (crude: 。！？；.!?; and newlines) for the hex+word
 *  proximity rule. Deterministic, no locale machinery. */
function sentences(text: string): string[] {
  return text.split(/[\n。！？；!?;]+/).filter((s) => s !== "");
}

function hexWithCurrentWord(text: string): boolean {
  for (const sentence of sentences(text)) {
    if (!CURRENT_WORDS.some((w) => sentence.includes(w))) continue;
    if (HEX_RE.test(sentence)) return true;
  }
  return false;
}

function quotaReading(text: string): boolean {
  for (const m of text.matchAll(/\d+(?:\.\d+)?%/g)) {
    const at = m.index ?? 0;
    const from = Math.max(0, at - QUOTA_WINDOW_CP);
    const to = Math.min(text.length, at + m[0].length + QUOTA_WINDOW_CP);
    const window = text.slice(from, to).toLowerCase();
    if (QUOTA_WORDS.some((w) => window.includes(w.toLowerCase()))) return true;
  }
  return false;
}

/** The four §5.3 pattern kinds, in table order. Exported so tests (and the
 *  tool's echo line, which names what matched) can assert them exactly. */
export function stateSnapshotKinds(body: string): readonly string[] {
  const kinds: string[] = [];
  if (RUN_ID_RE.test(body)) kinds.push("run id");
  if (HEAD_RE.test(body) || hexWithCurrentWord(body)) kinds.push("commit");
  if (quotaReading(body)) kinds.push("quota reading");
  if (PROGRESS_RE.test(body)) kinds.push("progress");
  return kinds;
}

/** True when any §5.3 pattern matches. Pure; never throws. */
export function looksLikeStateSnapshot(body: string): boolean {
  return stateSnapshotKinds(body).length > 0;
}
