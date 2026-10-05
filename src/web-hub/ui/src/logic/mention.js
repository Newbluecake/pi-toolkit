/**
 * Web composer @mention helpers (web-hub task #11 — `@label` completion + send routing).
 * No DOM, no I/O: every function here runs unchanged under vitest (node) and in the browser.
 *
 * Semantics deliberately mirror the TUI's `src/mention/mention.ts`:
 * - `parseMentionText` is the same leading `@label message` shape as the TUI's `parseMention`,
 *   minus the registry — the web side resolves against the session's LIVE fleet rows.
 * - Only `status === "running"` rows are offered/resolvable: the agent-side steer handler
 *   answers anything else with E_NOT_RUNNING (`src/web-hub/agent/commands.ts`), so listing a
 *   queued/terminal sub-agent would be a guaranteed failure. The TUI additionally RESUMES a
 *   terminal run on @mention; v1 on the web falls back to plain text there instead (task #11's
 *   confirmed scope).
 * - Duplicate labels: first row wins, like the TUI registry's first-registration-wins.
 * - The steered text is the STRIPPED message (no `@label` prefix, no fabric reply-frame wrap):
 *   `frameUserMentionReply` stays TUI-only because it is gated on the fabric setting (off by
 *   default) which the browser cannot see, and the web steer channel (`FleetActions`
 *   precedent) already sends raw text — the child's reply arrives through its normal run
 *   transcript either way.
 *
 * @typedef {{ label: string, runId: string, status: string }} MentionTarget
 * @typedef {{ kind: "prompt" } | { kind: "steer", runId: string, label: string, message: string }} MentionRoute
 */

/** Leading `@label message` — identical regex to the TUI's `parseMention`. */
const MENTION_RE = /^@([^\s]+)[ \t]+([\s\S]*\S)[ \t]*$/;

/** Line-initial, whitespace-free `@partial` token up to the caret ⇒ completion is open. */
const COMPLETION_RE = /^@([^\s]*)$/;

/**
 * Parse a COMPLETE leading `@label message`. Registry/fleet resolution is separate so the
 * caller decides what "known" means (web: running fleet rows).
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

/**
 * Fleet rows → steerable mention targets: `status === "running"` only, non-empty label and
 * runId, first row wins on duplicate labels, input order preserved.
 * @param {unknown} rows — `FleetRowWire[]` off the wire (or anything array-like of unknown)
 * @returns {MentionTarget[]}
 */
export function runningMentionTargets(rows) {
  if (!Array.isArray(rows)) return [];
  /** @type {MentionTarget[]} */
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const r = /** @type {{ runId?: unknown, label?: unknown, status?: unknown }} */ (row);
    if (typeof r.runId !== "string" || r.runId === "") continue;
    if (typeof r.label !== "string" || r.label === "") continue;
    if (r.status !== "running") continue;
    if (seen.has(r.label)) continue;
    seen.add(r.label);
    out.push({ label: r.label, runId: r.runId, status: "running" });
  }
  return out;
}

/**
 * Completion filter: case-insensitive PREFIX match on the label (empty query ⇒ all).
 * @param {readonly MentionTarget[]} targets @param {string} query
 * @returns {MentionTarget[]}
 */
export function filterMentionTargets(targets, query) {
  const q = query.toLowerCase();
  return targets.filter((t) => t.label.toLowerCase().startsWith(q));
}

/**
 * Send-time resolution: exact, case-sensitive label match (the TUI registry's `Map.get`
 * semantics) against the running targets of the given fleet rows.
 * @param {unknown} rows @param {string} label
 * @returns {MentionTarget | undefined}
 */
export function resolveMentionTarget(rows, label) {
  return runningMentionTargets(rows).find((t) => t.label === label);
}

/**
 * Panel open state machine: the completion opens while the caret sits inside a line-initial,
 * whitespace-free `@partial` token (the query is whatever was typed after `@`). Once a space
 * or newline ends the token — or anything precedes the `@` — the panel stays closed. `caret`
 * defaults to the end of the text.
 * @param {string} text @param {number} [caret]
 * @returns {{ open: true, query: string } | { open: false }}
 */
export function mentionCompletion(text, caret = text.length) {
  const at = Math.max(0, Math.min(caret, text.length));
  const match = COMPLETION_RE.exec(text.slice(0, at));
  if (!match) return { open: false };
  return { open: true, query: match[1] ?? "" };
}

/**
 * Apply a panel pick: replace the slice before the caret (the `@partial` token) with
 * `@label ` and keep the rest of the text verbatim. Returns the new text and the caret
 * position right after the inserted trailing space.
 * @param {string} text @param {number} caret @param {string} label
 * @returns {{ text: string, caret: number }}
 */
export function applyMentionPick(text, caret, label) {
  const at = Math.max(0, Math.min(caret, text.length));
  const head = `@${label} `;
  return { text: head + text.slice(at), caret: head.length };
}

/**
 * Arrow-key navigation over the panel rows, wrapping at both ends; an empty list pins 0.
 * @param {number} active @param {number} delta @param {number} count
 * @returns {number}
 */
export function moveMentionActive(active, delta, count) {
  if (count <= 0) return 0;
  return (((active + delta) % count) + count) % count;
}

/**
 * DetailDock's send fork: a complete leading mention resolving to a RUNNING fleet row steers
 * that run (message stripped of the `@label` prefix); anything else — unknown label, terminal
 * run, no message, no mention — stays a plain prompt with the raw text untouched (the
 * terminal's own mention interceptor treats those identically, so web and TUI never diverge).
 * @param {unknown} text @param {unknown} rows — live fleet rows
 * @returns {MentionRoute}
 */
export function mentionSendRoute(text, rows) {
  const parsed = parseMentionText(text);
  if (!parsed) return { kind: "prompt" };
  const target = resolveMentionTarget(rows, parsed.label);
  if (!target) return { kind: "prompt" };
  return { kind: "steer", runId: target.runId, label: parsed.label, message: parsed.message };
}
