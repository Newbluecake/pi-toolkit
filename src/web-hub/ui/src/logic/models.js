/**
 * Model-switcher pure helpers (web-model-switch plan v2 §5, package M3a). No DOM, no I/O:
 * every function here runs unchanged under vitest (node) and in the browser. The wire shape
 * itself (`SessionModelsWire` / `ModelOptionWire`) is FROZEN in `protocol/messages.ts` (M1) —
 * this module only NARROWS whatever the browser actually received (never trusting the hub to
 * have validated it, §5.5) and hosts the switch-tracking state machine (§5.2) so the
 * component and the tests share one definition.
 *
 * - `modelsOf(session)` — defensive narrow of `session.models`: any field whose type doesn't
 *   match drops just that entry/degrades that field; a missing/non-object `models` is `null`
 *   (§5.4 state ④, old agent). Unknown keys are ignored; an unknown `status` renders as "ok"
 *   (§7.1 forward-compat).
 * - `shortModelLabel(id)` — chip label: trailing `-YYYYMMDD` stripped.
 * - `filterModels` / `groupByProvider` — search + `all` tab grouping (provider first-seen order).
 * - `switchErrorKey(code)` — §5.2's code → i18n leaf mapping (generic carries the raw code).
 * - `trackSwitch(track, input)` — the §5.2 convergence machine: exactly one tracked cmdId;
 *   results for OTHER ids never affect it. Pure: the component feeds `{pendingCtl, ctl,
 *   session, now}` and renders the returned state.
 *
 * @typedef {{ provider: string, id: string, name?: string, ctx?: number,
 *   reasoning?: true, scoped?: true }} ModelOption
 * @typedef {{ status: string, items: ModelOption[], total: number, omitted?: number,
 *   invalid?: number, scoped?: true, levels?: string[],
 *   policy: { model: string, thinking: string }, shadowed?: { model?: true, thinking?: true },
 *   sampledAt: number }} ModelsView
 * @typedef {{ id: string, sessionId: string, target: { provider: string, id: string },
 *   startedAt: number }} SwitchTrack
 * @typedef {{ kind: "idle" } | { kind: "pending" } | { kind: "unknown" }
 *   | { kind: "error", code: string, message?: string }} SwitchState
 */

/** §5.2: no convergence evidence within this window ⇒ `unknown` (chip shows `?`, resend barred). */
export const SWITCH_TIMEOUT_MS = 20_000;

/**
 * §6 clamp settle window (M3b): after a sync-ok `/thinking <level>`, the session frame that
 * proves the final level may arrive BEFORE or AFTER the cmd_result (agent sends
 * `thinking_level_select` and the cmd result independently — the two orders must converge to
 * the same UI). The chip waits this long for a `session.thinkingLevel` change, then judges
 * with the then-current level (a never-arriving frame means the level was already final —
 * pi skips the event when the clamped value equals the previous one, which IS a clamp).
 */
export const CLAMP_SETTLE_MS = 4_000;

/**
 * Defensive narrow of `session.models` (§5.5). `null` when the field is absent, null, or not
 * an object — the §5.4 state ④ "old agent" case. Everything else degrades field-by-field:
 * malformed items are dropped, malformed scalars fall back, and `policy` (required on the
 * wire) degrades to allow/allow so a partially-broken frame never bricks the chip.
 * @param {unknown} session @returns {ModelsView | null}
 */
export function modelsOf(session) {
  if (!session || typeof session !== "object") return null;
  const raw = /** @type {Record<string, unknown>} */ (session).models;
  if (raw === undefined || raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const src = /** @type {Record<string, unknown>} */ (raw);
  const items = [];
  if (Array.isArray(src.items)) {
    for (const it of src.items) {
      if (!it || typeof it !== "object" || Array.isArray(it)) continue;
      const o = /** @type {Record<string, unknown>} */ (it);
      if (typeof o.provider !== "string" || o.provider === "") continue;
      if (typeof o.id !== "string" || o.id === "") continue;
      /** @type {ModelOption} */
      const item = { provider: o.provider, id: o.id };
      if (typeof o.name === "string" && o.name !== "") item.name = o.name;
      if (typeof o.ctx === "number" && Number.isFinite(o.ctx) && o.ctx >= 0) item.ctx = o.ctx;
      if (o.reasoning === true) item.reasoning = true;
      if (o.scoped === true) item.scoped = true;
      items.push(item);
    }
  }
  const policySrc =
    src.policy && typeof src.policy === "object" && !Array.isArray(src.policy)
      ? /** @type {Record<string, unknown>} */ (src.policy)
      : {};
  /** @type {ModelsView} */
  const out = {
    status: typeof src.status === "string" && src.status !== "" ? src.status : "ok",
    items,
    total: typeof src.total === "number" && Number.isFinite(src.total) && src.total >= 0 ? src.total : items.length,
    policy: {
      model: typeof policySrc.model === "string" ? policySrc.model : "allow",
      thinking: typeof policySrc.thinking === "string" ? policySrc.thinking : "allow",
    },
    sampledAt: typeof src.sampledAt === "number" && Number.isFinite(src.sampledAt) ? src.sampledAt : 0,
  };
  if (typeof src.omitted === "number" && Number.isFinite(src.omitted) && src.omitted > 0) out.omitted = src.omitted;
  if (typeof src.invalid === "number" && Number.isFinite(src.invalid) && src.invalid > 0) out.invalid = src.invalid;
  if (src.scoped === true) out.scoped = true;
  if (Array.isArray(src.levels)) {
    const levels = src.levels.filter((l) => typeof l === "string" && l !== "");
    if (levels.length > 0) out.levels = levels;
  }
  if (src.shadowed && typeof src.shadowed === "object" && !Array.isArray(src.shadowed)) {
    const sh = /** @type {Record<string, unknown>} */ (src.shadowed);
    /** @type {{ model?: true, thinking?: true }} */
    const shadowed = {};
    if (sh.model === true) shadowed.model = true;
    if (sh.thinking === true) shadowed.thinking = true;
    if (shadowed.model === true || shadowed.thinking === true) out.shadowed = shadowed;
  }
  return out;
}

/**
 * The session's current model ref (`session.model`), `null` when absent/malformed. The models
 * list deliberately does NOT carry "which is current" (plan D3) — the UI derives it here.
 * @param {unknown} session @returns {{ provider: string, id: string } | null}
 */
export function currentModelOf(session) {
  if (!session || typeof session !== "object") return null;
  const m = /** @type {Record<string, unknown>} */ (session).model;
  if (!m || typeof m !== "object" || Array.isArray(m)) return null;
  const o = /** @type {Record<string, unknown>} */ (m);
  if (typeof o.provider !== "string" || o.provider === "") return null;
  if (typeof o.id !== "string" || o.id === "") return null;
  return { provider: o.provider, id: o.id };
}

/** Chip label: `claude-opus-4-5-20250929` → `claude-opus-4-5` (trailing `-YYYYMMDD` only). */
export function shortModelLabel(id) {
  if (typeof id !== "string") return "";
  return id.replace(/-\d{8}$/, "");
}

/**
 * Search (§5.1): case-insensitive substring over provider, id, and name.
 * @param {readonly ModelOption[]} items @param {unknown} query @returns {ModelOption[]}
 */
export function filterModels(items, query) {
  const q = (typeof query === "string" ? query : "").trim().toLowerCase();
  if (q === "") return [...items];
  return items.filter(
    (m) =>
      m.provider.toLowerCase().includes(q) ||
      m.id.toLowerCase().includes(q) ||
      (typeof m.name === "string" && m.name.toLowerCase().includes(q)),
  );
}

/**
 * `all` tab grouping (§5.1): provider groups in first-seen (registry) order, items keep their
 * input order within a group — the sticky group header renders the provider name.
 * @param {readonly ModelOption[]} items @returns {{ provider: string, items: ModelOption[] }[]}
 */
export function groupByProvider(items) {
  /** @type {{ provider: string, items: ModelOption[] }[]} */
  const groups = [];
  const byProvider = new Map();
  for (const m of items) {
    let g = byProvider.get(m.provider);
    if (g === undefined) {
      g = { provider: m.provider, items: [] };
      byProvider.set(m.provider, g);
      groups.push(g);
    }
    g.items.push(m);
  }
  return groups;
}

/**
 * §5.2's error-code → i18n leaf mapping (`control.*` namespace). Only the code is consulted
 * (#7: `cmd_late` carries no message); a bridge-provided message is an optional add-on the
 * component shows separately. `"E_INVALID_REF"` is UI-local (modelCommandArg refused to build
 * the argument — never sent).
 * @param {unknown} code @returns {"modelErrRejected" | "modelErrUnknown" | "modelErrDenied"
 *   | "modelErrSession" | "modelErrInvalidRef" | "modelErrGeneric"}
 */
export function switchErrorKey(code) {
  switch (code) {
    case "E_SUBAGENT_REJECTED":
      return "modelErrRejected";
    case "E_BAD_REQUEST":
      return "modelErrUnknown";
    case "E_COMMAND_DENIED":
      return "modelErrDenied";
    case "E_SESSION_CHANGED":
      return "modelErrSession";
    case "E_INVALID_REF":
      return "modelErrInvalidRef";
    default:
      return "modelErrGeneric";
  }
}

/**
 * The §5.2 convergence machine (exactly one tracked cmdId; other ids' late results are
 * ignored by construction — every lookup below matches `track.id` only). Evaluation order:
 * session switch ⇒ drop; definitive evidence (session.model already at target, ledger
 * terminal, local item terminal) ⇒ converge; only then the 20 s timeout ⇒ `unknown`.
 *
 * Local pendingCtl reading (mirrors §5.2's table): `failed` ⇒ error(item.error);
 * `notExecuted` (E_UNKNOWN_ID — provably never ran) ⇒ idle, free to retry; `unknown`/
 * `querying` ⇒ unknown; item GONE ⇒ settled ok (cmd_late ok removes it, §7.7) ⇒ idle.
 *
 * @param {SwitchTrack} track
 * @param {{ pendingCtl?: unknown, ctl?: unknown, session?: unknown, now: number }} input
 * @returns {SwitchState}
 */
export function trackSwitch(track, input) {
  const session = input.session && typeof input.session === "object" ? input.session : null;
  const sessionId =
    session && typeof (/** @type {Record<string, unknown>} */ (session).sessionId) === "string"
      ? /** @type {Record<string, unknown>} */ (session).sessionId
      : null;
  if (sessionId === null || sessionId !== track.sessionId) return { kind: "idle" };

  const current = currentModelOf(session);
  if (current !== null && current.provider === track.target.provider && current.id === track.target.id) {
    return { kind: "idle" };
  }

  if (Array.isArray(input.ctl)) {
    for (const e of input.ctl) {
      if (!e || typeof e !== "object") continue;
      const o = /** @type {Record<string, unknown>} */ (e);
      if (o.cmdId !== track.id) continue;
      if (o.state === "ok" || o.state === "late_ok") return { kind: "idle" };
      if (o.state === "failed" || o.state === "late_failed") {
        return { kind: "error", code: typeof o.code === "string" && o.code !== "" ? o.code : "E_FAILED" };
      }
    }
  }

  const timedOut =
    typeof input.now === "number" && Number.isFinite(input.now) && input.now - track.startedAt > SWITCH_TIMEOUT_MS;

  if (Array.isArray(input.pendingCtl)) {
    const item = input.pendingCtl.find(
      (it) => it && typeof it === "object" && /** @type {Record<string, unknown>} */ (it).id === track.id,
    );
    if (item !== undefined) {
      const o = /** @type {Record<string, unknown>} */ (item);
      if (o.state === "failed") {
        const code = typeof o.error === "string" && o.error !== "" ? o.error : "E_FAILED";
        return typeof o.message === "string" && o.message !== ""
          ? { kind: "error", code, message: o.message }
          : { kind: "error", code };
      }
      if (o.state === "notExecuted") return { kind: "idle" };
      if (o.state === "unknown" || o.state === "querying") return { kind: "unknown" };
      return timedOut ? { kind: "unknown" } : { kind: "pending" };
    }
    // Item gone from the optimistic list ⇒ settled ok (the cmd_late-ok path removes it).
    return { kind: "idle" };
  }

  return timedOut ? { kind: "unknown" } : { kind: "pending" };
}

/**
 * The session's current thinking level (`session.thinkingLevel`), `null` when absent or not
 * a string — the chip renders "off" for that (§5.1).
 * @param {unknown} session @returns {string | null}
 */
export function thinkingLevelOf(session) {
  if (!session || typeof session !== "object") return null;
  const v = /** @type {Record<string, unknown>} */ (session).thinkingLevel;
  return typeof v === "string" && v !== "" ? v : null;
}

/**
 * §5.4/§6 thinking-chip gate (M3b), driven off the narrowed `ModelsView`:
 * - `"old-agent"` — `session.models` absent entirely (state ④): read-only chip showing
 *   `session.thinkingLevel` when there is one, nothing otherwise;
 * - `"no-levels"` — models present but `levels` not delivered (pi-ai probe unavailable, #2):
 *   read-only, never derive a list locally;
 * - `"unsupported"` — `levels` delivered with ≤1 entry (`["off"]`, non-reasoning model):
 *   read-only;
 * - `"pick"` — a real list to choose from.
 * @param {ModelsView | null} models
 * @returns {"old-agent" | "no-levels" | "unsupported" | "pick"}
 */
export function thinkingGate(models) {
  if (models === null) return "old-agent";
  if (!Array.isArray(models.levels) || models.levels.length === 0) return "no-levels";
  if (models.levels.length === 1) return "unsupported";
  return "pick";
}

/**
 * §5.2 error-code → i18n leaf mapping for the thinking chip (`control.*` namespace, M3b).
 * `/thinking` is sync (bridge `:236-246`), so the async-only codes never surface here;
 * `E_BAD_REQUEST` = the level name itself was rejected.
 * @param {unknown} code
 * @returns {"thinkingErrBadLevel" | "thinkingErrDenied" | "thinkingErrSession" | "thinkingErrGeneric"}
 */
export function thinkingErrorKey(code) {
  switch (code) {
    case "E_BAD_REQUEST":
      return "thinkingErrBadLevel";
    case "E_COMMAND_DENIED":
      return "thinkingErrDenied";
    case "E_SESSION_CHANGED":
      return "thinkingErrSession";
    default:
      return "thinkingErrGeneric";
  }
}

/**
 * Context-window badge (§5.1 row: `200k`). `null` when ctx is absent/non-positive.
 * @param {unknown} ctx @returns {string | null}
 */
export function ctxBadge(ctx) {
  if (typeof ctx !== "number" || !Number.isFinite(ctx) || ctx <= 0) return null;
  if (ctx >= 1_000_000) {
    const m = ctx / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (ctx >= 1_000) return `${Math.round(ctx / 1_000)}k`;
  return String(ctx);
}

/**
 * Compact snapshot age for the panel footer's `snapshot {t}` (English token, both languages).
 * @param {unknown} now @param {unknown} sampledAt @returns {string}
 */
export function snapshotAge(now, sampledAt) {
  if (typeof now !== "number" || typeof sampledAt !== "number" || !Number.isFinite(now) || sampledAt <= 0) return "?";
  const s = Math.max(0, Math.round((now - sampledAt) / 1000));
  if (s < 5) return "now";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
