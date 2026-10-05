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
 * QueueList model (§7.2/§7.4): local optimistic items first, then the server-side queue mirror
 * (D6 — includes TUI-typed entries). The server mirror is authoritative: an optimistic item
 * whose cmdId already appears as a server entry's `cmdId` is dropped (it left the "已发出未确认"
 * phase), and anything named by `dropped` (status.queueDropped cmdIds) is filtered out — the
 * reducer has already transitioned those optimistic items to `dropped` state for the one-shot
 * notice (§7.3).
 * @param {any[]} [serverQueue] @param {any[]} [optimistic] @param {string[]} [dropped]
 * @returns {any[]}
 */
export function mergeQueue(serverQueue = [], optimistic = [], dropped = []) {
  const droppedSet = new Set(dropped);
  const serverCmdIds = new Set();
  for (const q of serverQueue) {
    if (q && typeof q.cmdId === "string") serverCmdIds.add(q.cmdId);
  }
  const out = [];
  for (const o of optimistic) {
    if (!o || typeof o.id !== "string") continue;
    if (droppedSet.has(o.id) || serverCmdIds.has(o.id)) continue;
    out.push(o);
  }
  for (const q of serverQueue) {
    if (q && typeof q.cmdId === "string" && droppedSet.has(q.cmdId)) continue;
    out.push(q);
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
        if (item.kind === "prompt") {
          // §7.3: prompt ok ⇒ observed/unobserved; everything after that comes from the ctl slot.
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
