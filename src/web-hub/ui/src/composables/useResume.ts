/**
 * Resume state machine (web-resume plan v2 §2.6, package P3) — LAZY: this module is imported
 * ONLY by `ResumeDialog.vue`, which itself rides `defineAsyncComponent` in `AgentDetail.vue`,
 * so none of it costs first-screen bytes (see logic/resume.ts's header for the split).
 *
 * §2.6's machine: `idle → loading(attempt) → ready{gen, rows, next} → picking → switching →
 * closed | error`, realised as two orthogonal axes (the list axis `phase`, the pick axis
 * `pick`) because D4 keeps the LIST browsable while a pick is impossible — collapsing them
 * into one union would have to drop the rows every time a pick fails.
 *
 * - list reads go through the NON-optimistic `queryCommand` (never a queue row); a
 *   `resume:scanning` E_DEADLINE retries ≤4× after 1 s with fresh ids (§2.4);
 * - search debounces 300 ms behind a request-generation counter — a stale reply is dropped,
 *   and `reset:true` REPLACES the rows (gen/q change, §2.4 paging);
 * - a pick is an optimistic `runCommand("resume", "__pick …")` under a SELF-MINTED id so the
 *   pendingCtl watcher can follow it: `E_CONFIRM_REQUIRED resume:active-elsewhere` swaps in
 *   the inline D5 confirm (§7 D5-a; resent with `confirm` under a NEW id), ok-async enters
 *   `switching`, resolved by `agent.session.sessionId === id` (close), a DIFFERENT id
 *   (「已切换到其他会话」, close after a beat so the notice is readable), the ctl item turning
 *   `failed`/`late_failed` (one `query` for code/message, §2.6) or 10 s
 *   (「未确认切换，请查看终端」 — back to ready, rows stay usable);
 * - `resume:stale-list` reloads the list (§2.5 step 4).
 *
 * All timers are injectable (fake-clock tests) and cleared on `dispose()`.
 */
import { ref, shallowRef, watch, type Ref, type ShallowRef } from "vue";
import { newCmdId } from "@logic/control.js";
import { registerResumeExtra } from "../i18n/resume-extra.js";
import type { CmdOutcome } from "../types.js";
import type { ResumeScope, ResumeSessionRowWire, ResumeSessionsWire } from "../logic/resume.js";

/** §2.4: `resume:scanning` retries after the first failure (fresh id each round). */
export const RESUME_LIST_RETRIES = 4;
export const RESUME_RETRY_DELAY_MS = 1_000;
/** §2.6: search debounce. */
export const RESUME_SEARCH_DEBOUNCE_MS = 300;
/** §2.6: unconfirmed-switch watchdog. */
export const RESUME_SWITCH_TIMEOUT_MS = 10_000;
/** How long the 「已切换到其他会话」 notice stays readable before the dialog closes. */
export const RESUME_ELSEWHERE_CLOSE_MS = 1_200;
/** §2.4: `q` cap — the request builder truncates, the input's maxlength matches. */
export const RESUME_Q_MAX = 128;

// ---------------------------------------------------------------------------
// wire validation (§2.4 FROZEN shapes) + live-elsewhere (§7 D5-a)
// ---------------------------------------------------------------------------

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Structural validation of `data.sessions` (§2.4) — anything off ⇒ `null`, never a throw. */
export function validateSessionsWire(data: unknown): ResumeSessionsWire | null {
  if (data === null || typeof data !== "object") return null;
  const w = data as Record<string, unknown>;
  if (w["v"] !== 1) return null;
  if (w["scope"] !== "recent" && w["scope"] !== "all") return null;
  if (w["windowHours"] !== 48) return null;
  if (typeof w["gen"] !== "string" || w["gen"] === "") return null;
  if (!isFiniteNumber(w["total"])) return null;
  if (!Array.isArray(w["rows"])) return null;
  for (const raw of w["rows"]) {
    if (raw === null || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    if (typeof r["id"] !== "string" || r["id"] === "") return null;
    if (typeof r["title"] !== "string") return null;
    if (r["titleSource"] !== "name" && r["titleSource"] !== "first" && r["titleSource"] !== "none") return null;
    if (!isFiniteNumber(r["modifiedMs"])) return null;
    if (r["current"] !== undefined && r["current"] !== true) return null;
    if (r["forked"] !== undefined && r["forked"] !== true) return null;
  }
  if (w["q"] !== undefined && typeof w["q"] !== "string") return null;
  if (w["next"] !== undefined && (typeof w["next"] !== "string" || w["next"] === "")) return null;
  for (const flag of ["reset", "partial", "truncated"] as const) {
    if (w[flag] !== undefined && w[flag] !== true) return null;
  }
  if (w["ambiguous"] !== undefined && !isFiniteNumber(w["ambiguous"])) return null;
  if (w["provenance"] !== "complete" && w["provenance"] !== "partial" && w["provenance"] !== "capacity") return null;
  if (!isFiniteNumber(w["builtAt"])) return null;
  return w as unknown as ResumeSessionsWire;
}

/** Loose agent shape `knownLiveElsewhere` reads (tests pass plain objects). */
export interface LiveAgentLike {
  readonly key: string;
  readonly down?: boolean;
  readonly session?: { sessionId?: unknown } | undefined;
}

/** §2.6/§7 D5-a: is `id` the live session of ANOTHER card? (UI half of D5 — second click.) */
export function knownLiveElsewhere(
  id: string,
  agents: ReadonlyMap<string, LiveAgentLike> | undefined | null,
  selfKey: string,
): boolean {
  if (id === "" || agents === undefined || agents === null) return false;
  for (const a of agents.values()) {
    if (a === null || a.key === selfKey || a.down === true) continue;
    if (a.session?.sessionId === id) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

export type ResumeRowView = ResumeSessionRowWire & { readonly liveElsewhere: boolean };

export interface ResumeListMeta {
  readonly scope: ResumeScope;
  readonly q: string;
  readonly gen: string;
  readonly total: number;
  readonly next?: string;
  readonly partial?: true;
  readonly truncated?: true;
  readonly ambiguous?: number;
  readonly provenance: "complete" | "partial" | "capacity";
  readonly builtAt: number;
}

export type ResumePhase = "idle" | "loading" | "ready" | "error";

export type ResumePick =
  | { readonly state: "confirm"; readonly row: ResumeRowView; readonly server: boolean }
  | { readonly state: "picking"; readonly row: ResumeRowView }
  | { readonly state: "switching"; readonly row: ResumeRowView };

export interface ResumeNotice {
  readonly key: string;
  readonly params?: Readonly<Record<string, string | number>>;
}

type Timer = ReturnType<typeof setTimeout>;

export interface ResumeDeps {
  readonly agentKey: () => string;
  /** `queryCommand` off the control handle (optional — missing ⇒ E_UNSUPPORTED error state). */
  readonly queryCommand: ((agentKey: string, name: string, args: string) => Promise<CmdOutcome>) | undefined;
  readonly runCommand: (
    agentKey: string,
    name: string,
    args: string,
    opts?: { confirm?: true; id?: string },
  ) => Promise<CmdOutcome>;
  readonly query: (agentKey: string, id: string) => Promise<CmdOutcome>;
  /** The live agent view (sessionId + pendingCtl reads). */
  readonly agent: () => { session?: { sessionId?: unknown } | undefined; pendingCtl?: unknown } | undefined;
  /** All cards, for `knownLiveElsewhere`. */
  readonly agents?: () => ReadonlyMap<string, LiveAgentLike> | undefined;
  readonly busy: () => boolean;
  /** §2.6: the composable asks the host to close the dialog (switch settled). */
  readonly requestClose?: () => void;
  readonly now?: () => number;
  readonly setTimeout?: (fn: () => void, ms: number) => Timer;
  readonly clearTimeout?: (t: Timer) => void;
}

export interface ResumeHandle {
  readonly phase: Readonly<Ref<ResumePhase>>;
  readonly pick: Readonly<Ref<ResumePick | null>>;
  readonly rows: Readonly<ShallowRef<readonly ResumeRowView[]>>;
  readonly meta: Readonly<ShallowRef<ResumeListMeta | null>>;
  readonly error: Readonly<Ref<{ code: string; message?: string } | null>>;
  readonly notice: Readonly<Ref<ResumeNotice | null>>;
  readonly scope: Readonly<Ref<ResumeScope>>;
  readonly qRaw: Readonly<Ref<string>>;
  readonly loadingMore: Readonly<Ref<boolean>>;
  /** The locally-armed live-elsewhere row id (D5 UI half — the row renders its hint). */
  readonly armedId: Readonly<Ref<string | null>>;
  open(initial: ResumeScope): void;
  setSearch(q: string): void;
  commitSearch(): void;
  setScope(scope: ResumeScope): void;
  loadMore(): void;
  retry(): void;
  pickRow(row: ResumeRowView): void;
  confirmPick(): void;
  cancelPick(): void;
  dismissNotice(): void;
  dispose(): void;
}

function sessionIdOf(agent: ReturnType<ResumeDeps["agent"]> | undefined): string | undefined {
  const sid = agent?.session?.sessionId;
  return typeof sid === "string" ? sid : undefined;
}

export function createResume(deps: ResumeDeps): ResumeHandle {
  registerResumeExtra(); // lazy i18n half — before any t() the dialog renders
  const now = deps.now ?? Date.now;
  const setT = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = deps.clearTimeout ?? (clearTimeout as (t: Timer) => void);

  const phase = ref<ResumePhase>("idle");
  const pick = ref<ResumePick | null>(null);
  const rows = shallowRef<readonly ResumeRowView[]>([]);
  const meta = shallowRef<ResumeListMeta | null>(null);
  const error = ref<{ code: string; message?: string } | null>(null);
  const notice = ref<ResumeNotice | null>(null);
  const scope = ref<ResumeScope>("recent");
  const qRaw = ref("");
  const loadingMore = ref(false);
  const armedId = ref<string | null>(null);

  let seq = 0; // request generation — a stale reply can never overwrite a newer one
  let attempt = 0; // resume:scanning retries within the CURRENT logical load
  let pickCmdId: string | null = null;
  let disposed = false;
  const timers = new Set<Timer>();

  function schedule(fn: () => void, ms: number): Timer {
    const t = setT(() => {
      timers.delete(t);
      if (!disposed) fn();
    }, ms);
    timers.add(t);
    return t;
  }
  function dropTimer(t: Timer): void {
    timers.delete(t);
    clearT(t);
  }

  function decorate(list: readonly ResumeSessionRowWire[]): readonly ResumeRowView[] {
    const agents = deps.agents?.();
    return list.map((r) => ({ ...r, liveElsewhere: knownLiveElsewhere(r.id, agents, deps.agentKey()) }));
  }

  function applyWire(wire: ResumeSessionsWire, appended: boolean): void {
    const incoming = decorate(wire.rows);
    if (!appended || wire.reset === true) {
      rows.value = incoming;
    } else {
      const seen = new Set(rows.value.map((r) => r.id));
      rows.value = [...rows.value, ...incoming.filter((r) => !seen.has(r.id))];
    }
    scope.value = wire.scope;
    qRaw.value = wire.q ?? "";
    meta.value = {
      scope: wire.scope,
      q: wire.q ?? "",
      gen: wire.gen,
      total: wire.total,
      ...(wire.next !== undefined ? { next: wire.next } : {}),
      ...(wire.partial !== undefined ? { partial: wire.partial } : {}),
      ...(wire.truncated !== undefined ? { truncated: wire.truncated } : {}),
      ...(wire.ambiguous !== undefined ? { ambiguous: wire.ambiguous } : {}),
      provenance: wire.provenance,
      builtAt: wire.builtAt,
    };
    error.value = null;
    phase.value = "ready";
    loadingMore.value = false;
  }

  function failList(code: string | undefined, message: string | undefined): void {
    loadingMore.value = false;
    phase.value = "error";
    error.value = { code: code ?? "E_FAILED", ...(message !== undefined ? { message } : {}) };
  }

  /** One wire round; `appended` pages keep the current rows while loading. */
  async function fetchPage(q: string, cursor: string | undefined): Promise<void> {
    const mySeq = seq;
    attempt += 1;
    if (cursor === undefined) phase.value = "loading";
    else loadingMore.value = true;
    const qc = q === "" ? undefined : q.slice(0, RESUME_Q_MAX);
    const args =
      "__list " +
      JSON.stringify({
        scope: scope.value,
        ...(qc !== undefined ? { q: qc } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
      });
    let out: CmdOutcome;
    try {
      if (deps.queryCommand === undefined) {
        failList("E_UNSUPPORTED", undefined);
        return;
      }
      out = await deps.queryCommand(deps.agentKey(), "resume", args);
    } catch {
      out = { ok: false, error: "E_NETWORK", retryable: true, effect: "unknown" };
    }
    if (disposed || mySeq !== seq) return; // superseded
    if (out.ok) {
      const data = out.data as { sessions?: unknown } | undefined;
      const wire = validateSessionsWire(data?.sessions);
      if (wire === null) {
        failList("E_PROTOCOL", undefined);
        return;
      }
      applyWire(wire, cursor !== undefined);
      return;
    }
    // §2.4: E_DEADLINE resume:scanning is effect-none — retry with a NEW id (the next call
    // mints one), ≤ RESUME_LIST_RETRIES rounds, 1 s apart.
    if (out.message === "resume:scanning" && attempt <= RESUME_LIST_RETRIES) {
      schedule(() => {
        if (!disposed && mySeq === seq) void fetchPage(q, cursor);
      }, RESUME_RETRY_DELAY_MS);
      return;
    }
    failList(out.error, out.message);
  }

  function begin(q: string): void {
    seq += 1; // supersede everything in flight
    attempt = 0;
    armedId.value = null;
    void fetchPage(q, undefined);
  }

  // --- public surface -------------------------------------------------------

  let debounce: Timer | null = null;

  function open(initial: ResumeScope): void {
    scope.value = initial;
    qRaw.value = "";
    notice.value = null;
    begin("");
  }

  function setSearch(q: string): void {
    qRaw.value = q;
    if (debounce !== null) dropTimer(debounce);
    debounce = schedule(() => {
      debounce = null;
      begin(qRaw.value.trim());
    }, RESUME_SEARCH_DEBOUNCE_MS);
  }

  function commitSearch(): void {
    if (debounce !== null) dropTimer(debounce);
    debounce = null;
    begin(qRaw.value.trim());
  }

  function setScope(s: ResumeScope): void {
    if (s === scope.value && phase.value !== "error") return;
    scope.value = s;
    begin(qRaw.value.trim());
  }

  function loadMore(): void {
    const m = meta.value;
    if (m?.next === undefined || loadingMore.value || phase.value !== "ready") return;
    seq += 1;
    attempt = 0;
    void fetchPage(m.q, m.next);
  }

  function retry(): void {
    begin(qRaw.value.trim());
  }

  function dismissNotice(): void {
    notice.value = null;
  }

  // --- pick (§2.5/§2.6) -----------------------------------------------------

  let switchTimer: Timer | null = null;
  let closeSoonTimer: Timer | null = null;

  function clearSwitchTimers(): void {
    if (switchTimer !== null) {
      dropTimer(switchTimer);
      switchTimer = null;
    }
    if (closeSoonTimer !== null) {
      dropTimer(closeSoonTimer);
      closeSoonTimer = null;
    }
  }

  function finishPick(): void {
    clearSwitchTimers();
    pick.value = null;
    pickCmdId = null;
  }

  function enterSwitching(row: ResumeRowView): void {
    pick.value = { state: "switching", row };
    clearSwitchTimers();
    switchTimer = schedule(() => {
      // §2.6: 10 s without a sessionId flip — honest "check the terminal", rows stay usable.
      if (pick.value?.state === "switching") {
        finishPick();
        notice.value = { key: "resume.unconfirmedTimeout" };
      }
    }, RESUME_SWITCH_TIMEOUT_MS);
  }

  async function sendPick(row: ResumeRowView, confirmed: boolean): Promise<void> {
    const id = newCmdId();
    pickCmdId = id;
    pick.value = { state: "picking", row };
    const gen = meta.value?.gen ?? "";
    const args = "__pick " + JSON.stringify({ id: row.id, gen });
    let out: CmdOutcome;
    try {
      out = await deps.runCommand(deps.agentKey(), "resume", args, {
        ...(confirmed ? { confirm: true as const } : {}),
        id,
      });
    } catch {
      out = { ok: false, error: "E_NETWORK", retryable: true, effect: "unknown" };
    }
    if (disposed) return;
    if (out.ok) {
      // §2.5 step 7: ok async (the normal path). A sync ok means the switch already
      // happened — the sessionId watcher below settles both identically.
      enterSwitching(row);
      return;
    }
    if (out.error === "E_CONFIRM_REQUIRED" && out.message === "resume:active-elsewhere") {
      // §7 D5-a server half: inline confirm, then a NEW id with confirm:true.
      pick.value = { state: "confirm", row, server: true };
      pickCmdId = null;
      return;
    }
    finishPick();
    if (out.error === "E_NOT_FOUND" || out.message === "resume:stale-list") {
      notice.value = { key: "resume.staleList" };
      begin(qRaw.value.trim());
      return;
    }
    notice.value = { key: "resume.pickFailed", params: { code: out.message ?? out.error ?? "E_FAILED" } };
  }

  function pickRow(row: ResumeRowView): void {
    if (deps.busy()) return; // D4 — the UI also disables the rows; double guard
    const localD5 = row.liveElsewhere && armedId.value !== row.id;
    armedId.value = null;
    if (localD5) {
      armedId.value = row.id; // second click proceeds (§2.6 "needs a local second click")
      notice.value = null;
      return;
    }
    void sendPick(row, false);
  }

  function confirmPick(): void {
    const p = pick.value;
    if (p === null || p.state !== "confirm") return;
    void sendPick(p.row, true);
  }

  function cancelPick(): void {
    if (pick.value?.state === "confirm") pick.value = null;
  }

  // --- resolution watchers (sessionId + the optimistic ctl item) ------------

  const stopSessionWatch = watch(
    () => sessionIdOf(deps.agent()),
    (sid, prev) => {
      const p = pick.value;
      if (p === null || p.state !== "switching") return;
      if (sid === p.row.id) {
        finishPick();
        deps.requestClose?.();
        return;
      }
      if (sid !== undefined && sid !== prev) {
        // Someone (terminal / another tab) switched this process elsewhere first.
        notice.value = { key: "resume.switchedElsewhere" };
        finishPick();
        closeSoonTimer = schedule(() => {
          closeSoonTimer = null;
          deps.requestClose?.();
        }, RESUME_ELSEWHERE_CLOSE_MS);
      }
    },
  );

  const stopPendingWatch = watch(
    () => deps.agent()?.pendingCtl,
    (pending) => {
      const p = pick.value;
      const id = pickCmdId;
      if (p === null || id === null || !Array.isArray(pending)) return;
      const item = (pending as readonly Record<string, unknown>[]).find((it) => it !== null && it["id"] === id);
      if (item === undefined) return; // gone ⇒ cmd_late ok — the sessionId watcher finishes it
      const state = item["state"];
      if (state !== "failed" && state !== "notExecuted") return;
      const code = typeof item["error"] === "string" ? item["error"] : "E_FAILED";
      if (p.state === "picking") {
        // The HTTP result never surfaced here (dropped/reloaded) — settle from the item.
        finishPick();
        notice.value = { key: "resume.pickFailed", params: { code } };
        return;
      }
      // switching + late_failed: §2.6 — exactly ONE query for the code/message.
      pickCmdId = null;
      clearSwitchTimers();
      void deps
        .query(deps.agentKey(), id)
        .catch(() => undefined)
        .then((out) => {
          if (disposed) return;
          pick.value = null;
          if (out !== undefined && !out.ok) {
            if (out.error === "E_NOT_FOUND" || out.message === "resume:stale-list") {
              notice.value = { key: "resume.staleList" };
              begin(qRaw.value.trim());
              return;
            }
            notice.value = { key: "resume.pickFailed", params: { code: out.message ?? out.error ?? "E_FAILED" } };
            return;
          }
          notice.value = { key: "resume.pickFailed", params: { code } };
        });
    },
  );

  function dispose(): void {
    disposed = true;
    seq += 1;
    if (debounce !== null) dropTimer(debounce);
    debounce = null;
    clearSwitchTimers();
    for (const t of timers) clearT(t);
    timers.clear();
    stopSessionWatch();
    stopPendingWatch();
    phase.value = "idle";
    pick.value = null;
  }

  return {
    phase,
    pick,
    rows,
    meta,
    error,
    notice,
    scope,
    qRaw,
    loadingMore,
    armedId,
    open,
    setSearch,
    commitSearch,
    setScope,
    loadMore,
    retry,
    pickRow,
    confirmPick,
    cancelPick,
    dismissNotice,
    dispose,
  };
}
