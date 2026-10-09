/**
 * Control-plane pure helpers (control-plan v2.1 §7.2/§7.7, package C4 — takes over C0's stub).
 * No DOM, no I/O: every function here runs unchanged under vitest (node) and in the browser.
 *
 * - `newCmdId` — browser idempotency key (§3.4: 16 bytes `crypto.getRandomValues` → base64url;
 *   K18: LAN plaintext has no `crypto.randomUUID`, `getRandomValues` is always available).
 * - `pendingTransition` — the `pendingCtl` state machine (§7.7):
 *   `sending → (ok: observed|unobserved|done) | (failed{retryable}) | (unknown → querying →
 *   done|failed|notExecuted)`, plus `late` (cmd_late), `ctl` (ledger slot merge), `dropped`,
 *   `offline` (agent_down), `dialog_closed` (race lost), `retry`, `discard`. Returns the next
 *   item, the SAME item when the event is a no-op for its state, or `null` (remove the item).
 * - `outcomeFromHttp` / `outcomeFromResponse` / `outcomeFromError` — the single
 *   HTTP/exception → `CmdOutcome` mapping both transports share (§6.2 error-body table), so
 *   token and password mode can never diverge (the 78dd76b regression class).
 *
 * @typedef {{ ok: true, data?: unknown, dup?: boolean }} CmdOutcomeOk
 * @typedef {{ ok: false, error: string, message?: string, retryable: boolean,
 *   retryAfterS?: number, effect?: "none" | "unknown" }} CmdOutcomeErr
 * @typedef {CmdOutcomeOk | CmdOutcomeErr} CmdOutcome
 *
 * @typedef {{ id: string, kind: string, state: string, text?: string, deliver?: string,
 *   runId?: string, dialogId?: string, name?: string, at: number, behavior?: string,
 *   error?: string, message?: string, retryable?: boolean, effect?: string, reason?: string,
 *   offline?: boolean, lateQuery?: boolean }} PendingItem
 *
 * @typedef {{ type: "result", outcome: CmdOutcome }
 *   | { type: "query_start" }
 *   | { type: "query_result", outcome: CmdOutcome }
 *   | { type: "retry" }
 *   | { type: "discard" }
 *   | { type: "dropped" }
 *   | { type: "offline" }
 *   | { type: "late", ok: boolean, code?: string }
 *   | { type: "ctl", entry: any }
 *   | { type: "dialog_closed", cmdId?: string, by?: string }} PendingEvent
 */

/** §3.4: 16 random bytes → 22-char base64url id (matches the hub's `^[A-Za-z0-9_-]{16,64}$`). */
export function newCmdId(getRandomValues = globalThis.crypto?.getRandomValues?.bind(globalThis.crypto)) {
  if (typeof getRandomValues !== "function") return "AAAAAAAAAAAAAAAAAAAAAA";
  return randomBase64Url(getRandomValues, 16);
}

/**
 * Upload ids (2026-10-05, user field report: the 22-char id made on-disk paths unwieldy —
 * `s-<36>/<id22>/<id22>.<ext>`). 6 bytes → 8 chars base64url; 48 bits is plenty for a
 * per-session bucket (birthday-bound ≈ 2^24 uploads) and `begin`'s id-reuse check rejects a
 * genuine collision (the user just retries). Hub-side schema relaxed to `{8,64}` — older
 * 22-char ids stay valid.
 */
export function newUploadId(getRandomValues = globalThis.crypto?.getRandomValues?.bind(globalThis.crypto)) {
  if (typeof getRandomValues !== "function") return "AAAAAAAA";
  return randomBase64Url(getRandomValues, 6);
}

function randomBase64Url(getRandomValues, byteCount) {
  const bytes = new Uint8Array(byteCount);
  getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * §7.7: composer text → `{name, args}` when it is a slash command, `undefined` otherwise.
 * `//…` is the explicit "send as text" escape (§7.4) and never parses. Splitting only — name
 * charset / policy validation is the agent's job (§4.6: never fall back to plain text there).
 * @param {unknown} text
 * @returns {{ name: string, args: string } | undefined}
 */
export function parseSlash(text) {
  if (typeof text !== "string" || !text.startsWith("/") || text.startsWith("//")) return undefined;
  const m = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
  return m ? { name: m[1], args: m[2] || "" } : undefined;
}

/**
 * Queue list model (§7.2/§7.4): local optimistic items first, then the server-side queue mirror
 * (D6 — includes TUI-typed entries). The server mirror is authoritative: an optimistic item
 * whose cmdId already appears as a server entry's `cmdId` is dropped (it left the "已发出未确认"
 * phase), and anything named by `dropped` (status.queueDropped cmdIds) is filtered out — the
 * reducer has already transitioned those optimistic items to `dropped` state for the one-shot
 * notice (§7.3).
 *
 * steer-recall (web-hub-steer-recall plan §7, P-ui): the 4th/5th parameters add the held block.
 * `held` is the accepted `status.held` snapshot (see `acceptHeld`); its rows render after the
 * server queue as hold rows. Dedup rules: a snapshot row whose cmdId an optimistic item
 * already tracks is dropped (the optimistic item keeps the FULL local text and is transitioned
 * by the ctl slot); a `kind:"recall"` optimistic item NEVER renders as its own row — it joins
 * onto its target instead (`sending` ⇒ the row shows `recalling`, `tooLate` ⇒ the "already
 * delivered" look); `dismissed` (U-MERGE tombstones + local hides) suppresses rows outright.
 * `holdEnabled === false` (no `hold.v1` on agent card or hub — old peers) drops the whole held
 * block, so a no-cap hub renders byte-identically to the pre-feature UI.
 *
 * @param {any[]} [serverQueue] @param {any[]} [optimistic] @param {string[]} [dropped]
 * @param {any[]} [held] @param {{ holdEnabled?: boolean, rowMode?: "recallable" | "unavailable",
 *   dismissed?: ReadonlySet<string> | readonly string[], sessionId?: string }} [opts]
 * @returns {any[]}
 */
export function mergeQueue(serverQueue = [], optimistic = [], dropped = [], held = [], opts = {}) {
  const droppedSet = new Set(dropped);
  const serverCmdIds = new Set();
  for (const q of serverQueue) {
    if (q && typeof q.cmdId === "string") serverCmdIds.add(q.cmdId);
  }
  const o = opts && typeof opts === "object" ? opts : {};
  const holdEnabled = o.holdEnabled !== false;
  const rowMode = o.rowMode === "recallable" ? "recallable" : "unavailable";
  const dismissedSet =
    o.dismissed instanceof Set ? o.dismissed : Array.isArray(o.dismissed) ? new Set(o.dismissed) : undefined;
  const scopeSessionId = typeof o.sessionId === "string" ? o.sessionId : undefined;
  // Pass 1: recall-request items exist only to decorate their target row (never a row).
  const recallStates = new Map();
  for (const opt of optimistic) {
    if (opt && opt.kind === "recall" && typeof opt.target === "string" && typeof opt.state === "string") {
      recallStates.set(opt.target, opt.state);
    }
  }
  /** A hold-family display state joined from a recall item, or the raw state. */
  const joinRecall = (cmdId, raw) => {
    const r = recallStates.get(cmdId);
    if (r === "sending") return "recalling";
    if (r === "tooLate") return "tooLate";
    return raw;
  };
  const out = [];
  const optimisticIds = new Set();
  for (const opt of optimistic) {
    if (!opt || typeof opt.id !== "string") continue;
    optimisticIds.add(opt.id);
    if (opt.kind === "recall") continue; // §7: a recall request never renders as its own row
    if (droppedSet.has(opt.id) || serverCmdIds.has(opt.id)) continue;
    if (opt.kind === "prompt" && HOLD_ROW_STATES.has(opt.state)) {
      // Our own held/returned message: keep the FULL local text, join the recall state, and
      // carry the row mode so QueueList renders the right affordances without re-deriving.
      // Rendered even while `holdEnabled` is false (mode "unavailable", copy-only) — such an
      // item can only exist if the cap disappeared AFTER it was held.
      out.push({
        ...opt,
        state: joinRecall(opt.id, opt.state),
        holdBase: opt.state === "returned" ? "returned" : "held",
        mode: holdEnabled ? rowMode : "unavailable",
      });
      continue;
    }
    out.push(opt);
  }
  for (const q of serverQueue) {
    if (q && typeof q.cmdId === "string" && droppedSet.has(q.cmdId)) continue;
    out.push(q);
  }
  if (holdEnabled && Array.isArray(held)) {
    for (const h of held) {
      if (!h || typeof h !== "object" || typeof h.cmdId !== "string" || h.cmdId === "") continue;
      if (optimisticIds.has(h.cmdId)) continue; // this tab's optimistic item already renders it
      if (dismissedSet !== undefined && dismissedSet.has(h.cmdId)) continue;
      const rawState = h.state === "returned" ? "returned" : "held";
      out.push({
        held: true,
        id: h.cmdId,
        cmdId: h.cmdId,
        text: typeof h.text === "string" ? h.text : "",
        deliver: h.deliver === "followUp" ? "followUp" : "steer",
        state: joinRecall(h.cmdId, rawState),
        holdBase: rawState,
        ...(typeof h.reason === "string" ? { reason: h.reason } : {}),
        sessionId: typeof h.sessionId === "string" ? h.sessionId : "",
        at: typeof h.at === "number" ? h.at : 0,
        mode: h.gone === true || rowMode === "unavailable" ? "unavailable" : "recallable",
        ...(h.gone === true ? { gone: true } : {}),
        ...(scopeSessionId !== undefined && h.sessionId !== scopeSessionId ? { prevSession: true } : {}),
      });
    }
  }
  return out;
}

/**
 * Composer key map (§7.4): IME composition (`isComposing` / keyCode 229) never sends; Enter =
 * send in the current mode on ALL pointers (the textarea advertises `enterkeyhint="send"`, so the
 * soft-keyboard action button must keep that promise — coarse=newline was retired 2026-10-05 on a
 * field report that phone users expect the keyboard send button to send); Alt+Enter = followUp
 * (TUI 同键); Shift+Enter = newline.
 * @param {any} event @param {{ busy?: boolean }} [ctx]
 * @returns {"newline" | "followUp" | "steer" | "prompt"}
 */
export function composerKeyAction(event, { busy = false } = {}) {
  if (event?.isComposing || event?.keyCode === 229) return "newline";
  if (event?.key === "Enter" && event?.altKey) return "followUp";
  if (event?.key === "Enter" && !event?.shiftKey) return busy ? "steer" : "prompt";
  return "newline";
}

/**
 * Slash-palette rows — the ONE matcher `CommandPalette.vue` (render) and `Composer.vue`
 * (keyboard model: Tab completes the highlighted row, aria-activedescendant) share, so the
 * highlighted row can never drift from the rendered list. Tiered match + sort
 * (case-insensitive), the web-hub analogue of the TUI's own slash-command matcher: ①name
 * prefix ②name substring ③description substring, in that priority order; anything matching
 * none of the three is dropped. `Array#sort` is spec-stable, so rows keep their original
 * `commands`-slot relative order within the same tier. `busy` folds each row's policy
 * (`policyBusy` override, `commandPolicyFor`). Capped at 50 rows — the commands slot is ≤400
 * entries, the palette never scrolls forever.
 * @param {unknown[]} [commands] @param {unknown} query @param {boolean} [busy]
 * @returns {{ name: string, description: string, policy: "allow" | "confirm" | "deny", output: "captured" | "terminal" | null }[]}
 */
export function matchCommandRows(commands = [], query, busy = false) {
  const q = typeof query === "string" ? query.toLowerCase() : "";
  const scored = [];
  for (const raw of Array.isArray(commands) ? commands : []) {
    const c = raw;
    if (c === null || typeof c !== "object") continue;
    const name = c.name;
    if (typeof name !== "string" || name === "") continue;
    const description = typeof c.description === "string" ? c.description : "";
    const rank = commandMatchRank(name.toLowerCase(), description.toLowerCase(), q);
    if (rank === -1) continue;
    scored.push({
      rank,
      row: {
        name,
        description,
        policy: commandPolicyFor(commands, name, busy),
        output: c.output === "captured" ? "captured" : c.output === "terminal" ? "terminal" : null,
      },
    });
  }
  scored.sort((a, b) => a.rank - b.rank);
  return scored.slice(0, 50).map((s) => s.row);
}

/** @param {string} name @param {string} description @param {string} q */
function commandMatchRank(name, description, q) {
  if (q === "" || name.startsWith(q)) return 0;
  if (name.includes(q)) return 1;
  if (description.includes(q)) return 2;
  return -1;
}

/**
 * Effective policy of a command from the `commands` slot (§4.6/§7.7): `policyBusy` overrides
 * `policy` while the agent is busy (e.g. /compact); an unknown name is `deny` (composer shows
 * the reason instead of sending — the agent would answer E_UNKNOWN_COMMAND anyway).
 * @param {any[]} [commands] @param {string} name @param {boolean} [busy]
 * @returns {"allow" | "confirm" | "deny"}
 */
export function commandPolicyFor(commands = [], name, busy = false) {
  const found = commands.find((c) => c && c.name === name);
  if (!found) return "deny";
  return busy && found.policyBusy ? found.policyBusy : found.policy;
}

/**
 * §7.2: per-question selections → `DialogAnswerWire[]`. Selections are filtered to labels the
 * question actually offers (defense in depth — the agent re-validates with E_BAD_ANSWER);
 * `other` is trimmed and becomes `null` when empty. Returns `undefined` when the shapes don't
 * line up (caller keeps the form open).
 * @param {any[]} questions @param {any[]} selections — `[{ selected?: string[], other?: string | null }]`
 * @returns {{ selected: string[], other: string | null }[] | undefined}
 */
export function buildDialogAnswers(questions, selections) {
  if (!Array.isArray(questions) || !Array.isArray(selections) || questions.length !== selections.length) {
    return undefined;
  }
  const answers = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const sel = selections[i] && typeof selections[i] === "object" ? selections[i] : {};
    const labels = new Set(
      (Array.isArray(q?.options) ? q.options : [])
        .map((o) => (o && typeof o.label === "string" ? o.label : undefined))
        .filter((x) => x !== undefined),
    );
    const raw = Array.isArray(sel.selected) ? sel.selected : [];
    const selected = [...new Set(raw.filter((s) => typeof s === "string" && labels.has(s)))];
    const other = typeof sel.other === "string" && sel.other.trim() !== "" ? sel.other : null;
    answers.push({ selected, other });
  }
  return answers;
}

/**
 * Submit-enabled rule (§7.4 AskUserForm): every question has at least one selected option or a
 * non-empty Other. @param {any[]} questions @param {any} answers
 */
export function dialogComplete(questions, answers) {
  if (!Array.isArray(questions) || !Array.isArray(answers) || questions.length !== answers.length) return false;
  return answers.every(
    (a) =>
      a &&
      ((Array.isArray(a.selected) && a.selected.length > 0) || (typeof a.other === "string" && a.other.trim() !== "")),
  );
}

// ---------------------------------------------------------------------------
// pendingCtl state machine (§7.7)
// ---------------------------------------------------------------------------

/** Terminal-ish states a later merge (ctl slot / queueDropped / late) must not resurrect. */
const CLOSED_STATES = new Set(["failed", "notExecuted", "dropped"]);

/** steer-recall (plan §7): the hold-family row states — a queue row in one of these renders as a
 * hold row (recall/edit/copy affordances) instead of the legacy optimistic/mirror look.
 * `recalling` and `tooLate` are display-only joins (a `kind:"recall"` pending item onto its
 * target), never stored on a pending item. Exported so `QueueList.vue` and tests share one
 * set instead of re-typing it. */
export const HOLD_ROW_STATES = Object.freeze(new Set(["held", "returned", "recalling", "handed", "tooLate"]));

/** steer-recall U-MERGE: ctl entry states that tombstone a cmdId — once seen locally, the row
 * can never be resurrected by any later `status.held` snapshot. "dispatched 及之后的 handed
 * 态" plus `recalled`/`returned`/`unconfirmed` (v4.2 R-C). Kept broad on purpose: cmdIds that
 * were never held simply never appear in a snapshot, so their tombstones are inert. */
export const HELD_TOMB_CTL_STATES = Object.freeze(
  new Set([
    "dispatched",
    "observed",
    "started",
    "queued",
    "consumed",
    "unconfirmed",
    "ok",
    "late_ok",
    "recalled",
    "returned",
  ]),
);

/** @param {PendingItem} item @param {Record<string, unknown>} patch @returns {PendingItem} */
function patchItem(item, patch) {
  return { ...item, ...patch };
}

/**
 * Map a hub/agent HTTP response (or a queryOnly answer) onto the item. See the file header for
 * the machine; `null` removes the item from `pendingCtl`.
 * @param {PendingItem} item @param {PendingEvent} event
 * @returns {PendingItem | null}
 */
export function pendingTransition(item, event) {
  if (!item || !event || typeof event.type !== "string") return item;
  switch (event.type) {
    case "result": {
      const o = event.outcome;
      if (o && o.ok === true) {
        const data = o.data && typeof o.data === "object" ? o.data : {};
        if (item.kind === "recall") {
          // steer-recall §7/S5: the recall request's own item — never a queue row (`mergeQueue`
          // joins it onto its target). `recalled` ⇒ done; `too_late` ⇒ sticky display state the
          // target row renders as "already delivered" + copy (Q5: never differentiated).
          return data.outcome === "too_late" ? patchItem(item, { state: "tooLate" }) : null;
        }
        if (item.kind === "prompt") {
          // §7.3: prompt ok ⇒ observed/unobserved; everything after that comes from the ctl slot.
          // steer-recall §7: `delivery:"held"` ⇒ the agent buffered it (recallable). "held 不倒退"
          // — once held/handed/tooLate, a later ok result never regresses it (a dup or queryOnly
          // replay re-answers the ORIGINAL delivery; anything else is stale). Y8.1: a degraded
          // native delivery answers observed/unobserved here and never creates a held row.
          if (data.delivery === "held") {
            return patchItem(item, {
              state: "held",
              ...(typeof data.behavior === "string" ? { behavior: data.behavior } : {}),
            });
          }
          if (item.state === "held" || item.state === "handed" || item.state === "tooLate") return item;
          return patchItem(item, {
            state: data.delivery === "observed" ? "observed" : "unobserved",
            ...(typeof data.behavior === "string" ? { behavior: data.behavior } : {}),
          });
        }
        if (item.kind === "command") {
          // §4.6: sync/timeout completions are final (the promise already carried the output);
          // async/unknown are terminated later by cmd_late.
          return data.completion === "async" || data.completion === "unknown"
            ? patchItem(item, { state: "running" })
            : null;
        }
        return null; // every other op: ok ⇒ remove (§7.3)
      }
      const err = o && o.ok === false ? o : { error: "E_NETWORK", retryable: true, effect: "unknown" };
      if (err.effect === "unknown") {
        // D7: possibly executed — never auto re-execute; the queryOnly flow decides (§3.4/§3.5).
        return patchItem(item, {
          state: "unknown",
          error: err.error,
          retryable: err.retryable !== false,
          effect: "unknown",
          ...(typeof err.message === "string" ? { message: err.message } : {}),
        });
      }
      return patchItem(item, {
        state: "failed",
        error: err.error,
        retryable: err.retryable === true,
        effect: "none",
        ...(typeof err.message === "string" ? { message: err.message } : {}),
      });
    }
    case "retry":
      // ctl_retry (§7.3): a failed item goes back to sending with the SAME id. `unknown` items
      // are never re-executed (queryOnly only), `notExecuted` needs a fresh user action (new id).
      return item.state === "failed"
        ? patchItem(item, {
            state: "sending",
            error: undefined,
            message: undefined,
            retryable: undefined,
            effect: undefined,
            reason: undefined,
            offline: undefined,
            lateQuery: undefined,
          })
        : item;
    case "query_start":
      return item.state === "unknown" || item.state === "querying"
        ? patchItem(item, { state: "querying", offline: undefined, lateQuery: undefined })
        : item;
    case "query_result": {
      if (item.state !== "querying" && item.state !== "unknown") return item;
      const o = event.outcome;
      if (o && o.ok === true) {
        const q = o.data && typeof o.data === "object" ? o.data : {};
        if (q.state === "ok") return null; // done (dup semantics — exactly one execution, §4.5)
        if (q.state === "failed") {
          const r = q.result && typeof q.result === "object" ? q.result : {};
          return patchItem(item, {
            state: "failed",
            error: typeof r.code === "string" ? r.code : "E_FAILED",
            retryable: false,
            effect: "none",
            ...(typeof r.message === "string" ? { message: r.message } : {}),
          });
        }
        return patchItem(item, { state: "unknown" }); // still running agent-side (or odd payload)
      }
      const err = o && o.ok === false ? o : { error: "E_NETWORK", retryable: true };
      if (err.error === "E_UNKNOWN_ID") {
        // §3.4's assertion: the agent process never received this id ⇒ definitely not executed.
        return patchItem(item, { state: "notExecuted", error: "E_UNKNOWN_ID", retryable: false });
      }
      if (err.retryable === true) return patchItem(item, { state: "unknown" });
      return patchItem(item, {
        state: "failed",
        error: err.error,
        retryable: false,
        ...(typeof err.message === "string" ? { message: err.message } : {}),
      });
    }
    case "discard":
      return null;
    case "dropped":
      // status.queueDropped hit (§7.3): the queued message went back to the terminal editor or
      // was discarded — a one-shot visible state, cleared by ctl_discard.
      return CLOSED_STATES.has(item.state) ? item : patchItem(item, { state: "dropped" });
    case "offline":
      // agent_down (§3.5): in-flight items become "结果未知，agent 已离线" — querying resumes
      // automatically once the agent is live again (useHub's effect).
      return item.state === "sending" || item.state === "unknown" || item.state === "querying"
        ? patchItem(item, { state: "unknown", offline: true })
        : item;
    case "late": {
      if (CLOSED_STATES.has(item.state)) return item;
      if (event.ok) {
        // v2.1 §7.7: a pending COMMAND item fetches the full result (with output) via one
        // queryOnly — SSE cmd_late never carries output (§6.6).
        if (item.kind === "command") return patchItem(item, { state: "querying", lateQuery: true });
        return null;
      }
      return patchItem(item, {
        state: "failed",
        error: typeof event.code === "string" ? event.code : "E_LATE",
        retryable: false,
        effect: "none",
      });
    }
    case "ctl": {
      if (CLOSED_STATES.has(item.state)) return item;
      const e = event.entry && typeof event.entry === "object" ? event.entry : {};
      // steer-recall §7: a stale ctl entry (updatedAt earlier than the last applied one) is
      // dropped — an out-of-order/truncated slot must not roll a held row back.
      if (typeof e.updatedAt === "number" && typeof item.ctlAt === "number" && e.updatedAt < item.ctlAt) {
        return item;
      }
      const ctlAtPatch = typeof e.updatedAt === "number" ? { ctlAt: e.updatedAt } : {};
      // steer-recall §5.4/§7 hold-family transitions: a held/returned item leaves the buffer by
      // recall (row gone), by being handed to pi (⇒ "handed" — dispatched and every later
      // pre-consumption state), or by a return-reason update.
      if (e.state === "recalled") return null;
      if (item.state === "held" || item.state === "returned") {
        if (e.state === "returned") {
          return patchItem(item, {
            state: "returned",
            ...(typeof e.reason === "string" ? { reason: e.reason } : {}),
            ...ctlAtPatch,
          });
        }
        if (
          item.state === "held" &&
          (e.state === "dispatched" || e.state === "observed" || e.state === "started" || e.state === "queued")
        ) {
          return patchItem(item, { state: "handed", ...ctlAtPatch });
        }
      }
      switch (e.state) {
        case "observed":
          return patchItem(item, {
            state: "observed",
            ...(typeof e.behavior === "string" ? { behavior: e.behavior } : {}),
          });
        case "started":
        case "queued":
        case "running":
          return patchItem(item, { state: e.state });
        case "consumed":
        case "ok":
        case "late_ok":
          return null;
        case "dropped":
          return patchItem(item, { state: "dropped" });
        case "unconfirmed":
          return patchItem(item, {
            state: "unconfirmed",
            ...(typeof e.reason === "string" ? { reason: e.reason } : {}),
          });
        case "failed":
        case "late_failed":
          return patchItem(item, {
            state: "failed",
            error: typeof e.code === "string" ? e.code : "E_FAILED",
            retryable: false,
            effect: "none",
          });
        default:
          return item; // "dispatched" / unknown states: no-op
      }
    }
    case "dialog_closed": {
      if (item.kind !== "dialog_answer" && item.kind !== "dialog_cancel") return item;
      if (CLOSED_STATES.has(item.state)) return item;
      // §3.5: closed[].cmdId === this request's id ⇒ this tab's answer won the race.
      if (event.by === "web" && event.cmdId === item.id) return null;
      return patchItem(item, {
        state: "failed",
        error: "E_DIALOG_CLOSED",
        retryable: false,
        effect: "none",
        ...(typeof event.by === "string" ? { message: event.by } : {}),
      });
    }
    default:
      return item;
  }
}

// ---------------------------------------------------------------------------
// HTTP → CmdOutcome (§6.2 error-body table; shared by both transports, §7.2)
// ---------------------------------------------------------------------------

/**
 * @param {number} status @param {unknown} body — parsed JSON (may be undefined)
 * @param {number} [retryAfterS] — parsed Retry-After header, seconds
 * @returns {CmdOutcome}
 */
export function outcomeFromHttp(status, body, retryAfterS) {
  const b = body && typeof body === "object" ? body : {};
  if (status >= 200 && status < 300) {
    // §6.2: 200 {ok:true, id, dup?, data} — a 2xx with ok:false in the body is still a failure.
    if (b.ok === false) {
      return errOutcome(
        typeof b.code === "string" ? b.code : typeof b.error === "string" ? b.error : "E_BAD_REQUEST",
        b,
        retryAfterS,
      );
    }
    return { ok: true, data: b.data, dup: b.dup === true };
  }
  const error =
    typeof b.error === "string"
      ? b.error
      : status === 401
        ? "E_AUTH"
        : status === 403
          ? "E_CSRF"
          : status === 404
            ? "E_NOT_FOUND"
            : status === 429
              ? "E_RATE"
              : status === 408 || status === 504
                ? "E_DEADLINE"
                : `HTTP ${status}`;
  return errOutcome(error, b, retryAfterS, status);
}

/** @param {string} error @param {any} b @param {number} [retryAfterS] @param {number} [status] */
function errOutcome(error, b, retryAfterS, status) {
  const retryable =
    typeof b.retryable === "boolean" ? b.retryable : status === 429 || (typeof status === "number" && status >= 500);
  const out = { ok: false, error, retryable, effect: b.effect === "unknown" ? "unknown" : "none" };
  if (typeof b.message === "string") out.message = b.message;
  const ra =
    typeof retryAfterS === "number" && retryAfterS >= 0
      ? retryAfterS
      : typeof b.retryAfterS === "number" && b.retryAfterS >= 0
        ? b.retryAfterS
        : undefined;
  if (ra !== undefined) out.retryAfterS = ra;
  return out;
}

/**
 * Convenience for the clients: parse body + Retry-After off a fetch response.
 * @param {{ status: number, headers?: { get(name: string): string | null }, json(): Promise<any> }} r
 * @returns {Promise<CmdOutcome>}
 */
export async function outcomeFromResponse(r) {
  /** @type {unknown} */
  let body;
  try {
    body = await r.json();
  } catch {
    body = undefined;
  }
  const raw = typeof r.headers?.get === "function" ? r.headers.get("Retry-After") : null;
  const n = raw === null || raw === undefined ? NaN : Number(raw);
  return outcomeFromHttp(r.status, body, Number.isFinite(n) && n >= 0 ? n : undefined);
}

/**
 * Fetch-level failure (§3.3/§3.4): a timeout is `E_DEADLINE{effect:"unknown"}` (the request may
 * already be with the agent); any other network error is also `effect:"unknown"` — the browser
 * cannot tell whether the bytes reached the hub, and mislabeling it `none` would license a
 * duplicate execution on retry. Never auto re-execute either way: the queryOnly flow decides.
 * @param {unknown} err @returns {CmdOutcome}
 */
export function outcomeFromError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg === "E_DEADLINE") return { ok: false, error: "E_DEADLINE", retryable: true, effect: "unknown" };
  return { ok: false, error: "E_NETWORK", message: msg, retryable: true, effect: "unknown" };
}

// ---------------------------------------------------------------------------
// steer-recall hold rows (web-hub-steer-recall plan §7 / v4.3 Y2 — P-ui)
// ---------------------------------------------------------------------------

/**
 * §7: is the hold surface available at all? The agent card must advertise `hold` (S3 — the
 * agent's hello caps include `hold.v1`, i.e. steerRecall on AND a new build) AND the hub must
 * advertise `hold.v1` (an old hub cannot route `POST /api/cmd {op:"recall"}` — requiredCaps
 * rejects it with 409). Strictly false when the hub caps are unknown: the affordance only
 * appears once the `hub` frame named the cap.
 * @param {any} card @param {readonly unknown[] | undefined} [hubCaps]
 * @returns {boolean}
 */
export function holdAvailable(card, hubCaps) {
  if (!card || card.hold !== true) return false;
  return Array.isArray(hubCaps) && hubCaps.includes("hold.v1");
}

/**
 * §7 row-mode table: a held row is `recallable` only while EVERY input holds — browser SSE
 * live, card live, hold available on both sides, and (v4.3 Y2) the accepted held snapshot's
 * scope still current (its `heldEpoch` equals the card's CURRENT epoch — after an agent
 * restart//reload the old rows are copy-only until a new-scope snapshot or a terminal ctl
 * entry arrives). Anything else ⇒ `unavailable` (copy only — never recallable: an edit-resend
 * from a stale scope could double-deliver).
 * @param {{ hubLive?: boolean, cardLive?: boolean, holdAvailable?: boolean, scopeOk?: boolean }} opts
 * @returns {"recallable" | "unavailable"}
 */
export function heldRowMode(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  return o.hubLive === true && o.cardLive === true && o.holdAvailable === true && o.scopeOk !== false
    ? "recallable"
    : "unavailable";
}

/**
 * U-MERGE / Y2: the single merge point for a `status.held` snapshot. Returns the accepted
 * `{rows, rev, epoch}`, or `undefined` when the snapshot must be IGNORED (the caller keeps the
 * previous rows):
 *  - `status.held` absent and nothing stored ⇒ nothing to do;
 *  - malformed (`held` without a numeric `heldRev` / string `heldEpoch`) ⇒ keep previous;
 *  - Y2 scope mismatch (`heldEpoch` ≠ the CURRENT card epoch — epochs are random, NEVER
 *    compared, just rejected) ⇒ keep previous; the old rows stay and render copy-only until a
 *    new-scope snapshot or a terminal arrives;
 *  - same scope with a smaller `heldRev` (a stale replay) ⇒ keep previous.
 *
 * When `status.held` is absent but rows were stored, the snapshot is a CLEAR: `{rows: [], …}`
 * comes back with the previous rev/epoch RETAINED (the agent's buffer rev is monotonic per
 * process — keeping it prevents a late in-flight frame from resurrecting cleared rows).
 *
 * Same-scope accepts are a UNION, not a replace (plan §7/U-KEEP: a row disappears only via a
 * tombstone or user action): snapshot rows are added/updated; a stored row the snapshot no
 * longer names is KEPT with `gone: true` — Y2's ctl-truncation ruling renders it copy-only
 * ("已离开暂存区", never shown recallable). A scope change (new epoch) replaces wholesale —
 * old-scope rows never carry over, tombstones still apply.
 *
 * @param {{ rows: any[], rev?: number, epoch?: string } | undefined} prev — the previously
 *   accepted snapshot (rows + their scope bookkeeping).
 * @param {any} status — the incoming StatusInfo.
 * @param {{ epoch?: string, sessionId?: string } | undefined} [scope] — the CURRENT card epoch
 *   + session id (Y2 gate; `undefined` disables the gate for unit tests).
 * @param {ReadonlySet<string> | undefined} [tombs] — U-MERGE tombstones.
 * @returns {{ rows: any[], rev?: number, epoch?: string } | undefined}
 */
export function acceptHeld(prev, status, scope, tombs) {
  const st = status !== null && typeof status === "object" ? status : {};
  const held = Array.isArray(st.held) ? st.held : undefined;
  const hadPrev = prev !== undefined && prev.rows !== undefined && prev.rows.length > 0;
  const tombSet = tombs instanceof Set ? tombs : undefined;
  if (held === undefined) {
    if (!hadPrev) return undefined;
    // Drained / feature off — clear the rows, keep rev+epoch for monotonicity.
    return { rows: [], rev: prev.rev, epoch: prev.epoch };
  }
  const rev = st.heldRev;
  const epoch = st.heldEpoch;
  if (typeof rev !== "number" || typeof epoch !== "string") return undefined; // malformed
  if (scope !== undefined && typeof scope.epoch === "string" && epoch !== scope.epoch) {
    return undefined; // Y2: wrong scope — dropped WITHOUT comparing revs
  }
  if (
    prev !== undefined &&
    prev.epoch === epoch &&
    typeof prev.rev === "number" &&
    typeof rev === "number" &&
    rev < prev.rev
  ) {
    return undefined; // stale same-scope replay
  }
  const valid = [];
  for (const row of held) {
    if (row === null || typeof row !== "object") continue;
    if (typeof row.cmdId !== "string" || row.cmdId === "") continue;
    if (row.state !== "held" && row.state !== "returned") continue;
    if (typeof row.text !== "string") continue;
    // Held rows are always the CURRENT session's (returned rows may carry an older session —
    // rendered with a "previous session" marker); unknown scope fields pass (compat window).
    if (
      row.state === "held" &&
      scope !== undefined &&
      typeof scope.sessionId === "string" &&
      row.sessionId !== scope.sessionId
    ) {
      continue;
    }
    if (tombSet !== undefined && tombSet.has(row.cmdId)) continue; // U-MERGE: never resurrect
    valid.push(row);
  }
  if (prev === undefined || prev.epoch !== epoch) {
    return { rows: valid, rev, epoch }; // new scope — wholesale replace
  }
  // Same scope — union: add/update; rows the snapshot dropped stay as `gone` (copy-only).
  const fresh = new Map();
  for (const r of valid) fresh.set(r.cmdId, r);
  const rows = [];
  for (const old of prev.rows !== undefined ? prev.rows : []) {
    if (tombSet !== undefined && tombSet.has(old.cmdId)) continue;
    const next = fresh.get(old.cmdId);
    if (next !== undefined) {
      rows.push(next);
      fresh.delete(old.cmdId);
    } else {
      rows.push({ ...old, gone: true });
    }
  }
  for (const r of fresh.values()) rows.push(r);
  return { rows, rev, epoch };
}

/**
 * §7 re-edit flow: join a recalled body AHEAD of the current composer draft, dropping blank
 * parts (an empty draft never grows a stray blank line — same shape as pi TUI's
 * `restoreQueuedMessagesToEditor`).
 * @param {unknown} recalled @param {unknown} draft
 * @returns {string}
 */
export function mergeRecalledDraft(recalled, draft) {
  const parts = [recalled, draft]
    .filter((s) => typeof s === "string" && s.trim() !== "")
    .map((s) => /** @type {string} */ (s));
  return parts.join("\n\n");
}

/** Mirror of the protocol's `RECALL_TEXT_MAX_BYTES` (48 KiB) — hand-copied rather than imported
 * so the browser bundle never pulls `protocol/messages.ts`'s typebox runtime along. */
const RECALL_TEXT_MAX_BYTES = 48 * 1024;

/**
 * §5.8/R4 re-validation of a recall result body before it reaches the composer: non-empty
 * string within the 48 KiB byte cap (the hub already enforces it; the UI re-checks so a
 * hand-crafted peer can't push an unbounded inject into the draft).
 * @param {unknown} text
 * @returns {boolean}
 */
export function validRecallText(text) {
  if (typeof text !== "string" || text.length === 0) return false;
  let bytes = text.length * 2; // UTF-16 pessimistic — never under-counts
  if (typeof TextEncoder === "function") {
    try {
      bytes = new TextEncoder().encode(text).length;
    } catch {
      /* keep the pessimistic estimate */
    }
  }
  return bytes <= RECALL_TEXT_MAX_BYTES;
}
