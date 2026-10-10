/**
 * Web composer @mention helpers. These targets and labels mirror the TUI mention
 * registry: only root-direct fleet rows are offered, terminal rows can resume,
 * and unavailable rows remain visible with an explicit status hint. Routing is
 * intentionally agent-side; the browser always sends a leading @mention as a
 * normal prompt so the live registry remains authoritative even when the fleet
 * projection omitted an older terminal row.
 * No DOM, I/O, v-html, or browser-only APIs are used here.
 *
 * @typedef {{ label: string, runId: string, status: "running" | "settled" | "other" }} MentionTarget
 * @typedef {{ kind: "prompt" }} MentionRoute
 */

/** Leading `@label message` — identical regex to the TUI's `parseMention`. */
const MENTION_RE = /^@([^\s]+)[ \t]+([\s\S]*\S)[ \t]*$/;
/** Line-initial, whitespace-free `@partial` token up to the caret ⇒ completion is open. */
const COMPLETION_RE = /^@([^\s]*)$/;
const TERMINAL_STATUSES = new Set(["completed", "failed", "timed_out", "aborted"]);
const MAX_TERMINAL_TARGETS = 8;

/**
 * Parse a COMPLETE leading `@label message`. Registry/fleet resolution is separate.
 * @param {unknown} text
 * @returns {{ label: string, message: string } | undefined}
 */
export function parseMentionText(text) {
  if (typeof text !== "string") return undefined;
  const match = MENTION_RE.exec(text);
  if (!match) return undefined;
  const label = match[1];
  const message = match[2];
  if (!label || !message) return undefined;
  return { label, message };
}

/** @param {unknown} row @returns {"running" | "settled" | "other" | undefined} */
function targetStatus(row) {
  if (row.terminal === true || TERMINAL_STATUSES.has(row.status)) return "settled";
  if (row.status === "running") return "running";
  return "other";
}

/**
 * Fleet rows → visible mention targets. Root-direct rows only; duplicate labels
 * prefer the newest non-terminal row (the lower elapsed time is the newer run).
 * Terminal rows are capped independently at the fleet's eight-row terminal budget.
 * @param {unknown} rows
 * @returns {MentionTarget[]}
 */
export function mentionTargets(rows) {
  if (!Array.isArray(rows)) return [];
  /** @type {Array<MentionTarget & { elapsedMs: number, terminal: boolean }>} */
  const selected = [];
  const byLabel = new Map();
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const r =
      /** @type {{ runId?: unknown, label?: unknown, status?: unknown, terminal?: unknown, parentRunId?: unknown, elapsedMs?: unknown }} */ (
        row
      );
    if (r.parentRunId !== undefined) continue;
    if (typeof r.runId !== "string" || r.runId === "") continue;
    if (typeof r.label !== "string" || r.label === "") continue;
    const status = targetStatus(r);
    if (status === undefined) continue;
    const candidate = {
      label: r.label,
      runId: r.runId,
      status,
      elapsedMs:
        typeof r.elapsedMs === "number" && Number.isFinite(r.elapsedMs) ? r.elapsedMs : Number.POSITIVE_INFINITY,
      terminal: status === "settled",
    };
    const previousIndex = byLabel.get(candidate.label);
    if (previousIndex === undefined) {
      byLabel.set(candidate.label, selected.length);
      selected.push(candidate);
      continue;
    }
    const previous = selected[previousIndex];
    if (previous === undefined) continue;
    if (!candidate.terminal && previous.terminal) {
      selected[previousIndex] = candidate;
    } else if (!candidate.terminal && !previous.terminal && candidate.elapsedMs < previous.elapsedMs) {
      selected[previousIndex] = candidate;
    }
  }
  let terminalCount = 0;
  return selected
    .filter((target) => {
      if (!target.terminal) return true;
      terminalCount += 1;
      return terminalCount <= MAX_TERMINAL_TARGETS;
    })
    .map(({ elapsedMs: _elapsedMs, terminal: _terminal, ...target }) => target);
}

/** Backward-compatible name for callers that used the pre-parity helper. */
export function runningMentionTargets(rows) {
  return mentionTargets(rows);
}

/** Completion filter: case-insensitive PREFIX match on the label (empty query ⇒ all). */
export function filterMentionTargets(targets, query) {
  const q = query.toLowerCase();
  return targets.filter((t) => t.label.toLowerCase().startsWith(q));
}

/** Exact, case-sensitive target resolution, including settled/other rows. */
export function resolveMentionTarget(rows, label) {
  return mentionTargets(rows).find((t) => t.label === label);
}

/** Panel open state: line-initial @ token only. */
export function mentionCompletion(text, caret = text.length) {
  const at = Math.max(0, Math.min(caret, text.length));
  const match = COMPLETION_RE.exec(text.slice(0, at));
  if (!match) return { open: false };
  return { open: true, query: match[1] ?? "" };
}

/** Replace the slice before the caret with `@label `. */
export function applyMentionPick(text, caret, label) {
  const at = Math.max(0, Math.min(caret, text.length));
  const head = `@${label} `;
  return { text: head + text.slice(at), caret: head.length };
}

/** Arrow-key navigation over panel rows, wrapping at both ends. */
export function moveMentionActive(active, delta, count) {
  if (count <= 0) return 0;
  return (((active + delta) % count) + count) % count;
}

/**
 * Kept as a pure compatibility helper for code that used to ask the browser to
 * steer. The actual route is now always the normal prompt command.
 */
export function mentionSendRoute(_text, _rows) {
  return { kind: "prompt" };
}
