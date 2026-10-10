/**
 * worktree-graph plan v2 §4.3 (package P5) — the commit-graph state machine, the wtgraph twin
 * of `./useWorktreeDiff.ts` (D5) with one payload slot instead of per-row lists:
 *
 * - `toggle()` — the section's ONLY expansion control. Expanding pulls once (first time / after
 *   a scope change); collapsing aborts the in-flight fetch and KEEPS the data (收起不重拉).
 *   Expansion state is a plain local ref — Q4: never persisted, never remembered.
 * - `onRowsChanged(rows)` — while EXPANDED, a `graphSigOf` change re-pulls after a 3 s debounce
 *   (reset on every further change — the useWorktreeDiff discipline); an ok payload stays
 *   visible under `refreshing` (aria-busy) while re-pulled.
 * - the SCOPE (agentKey|sessionId) changing — session switch, caps lost, transport gone —
 *   clears state, timers and expansion (the graph section hides until re-expanded).
 * - errors keep their `reason` verbatim so the component can map the REUSED codes +
 *   `WtGraphErrorReason` vocabulary to §4.3's per-reason copy; `retryable` follows the same
 *   client-local/429/5xx rule as wtdiff, EXCEPT `log-timeout` (a 504 whose fix is
 *   `git commit-graph write`, not a network flake — but still worth the retry button).
 * - the CHUNK-load failure is NOT this composable's concern: `WorktreePanel.vue`'s loader owns
 *   it (`loadGraph()`), so a failed dynamic import stays retryable (§4.3, K2).
 *
 * No DOM, no i18n — the component renders; this file only decides state. Like its twin, all
 * timers/controllers are cleaned up in `dispose()` (also wired to `onScopeDispose`).
 */
import { onScopeDispose, ref, watch, type Ref } from "vue";
import type { WorktreeRowWire } from "@protocol/messages.js";
import type { WorktreeGraphTransport, WtDiffOutcome } from "../transport/types.js";
import type { WtGraphPayload } from "@protocol/worktree-graph.js";
import { graphSigOf, type GraphScope } from "@logic/gitGraphScope.js";

/** §4.3: the debounced re-pull window while expanded (same 3 s as wtdiff D13). */
export const WTGRAPH_REFRESH_DEBOUNCE_MS = 3_000;

/** §4.3 GraphState — the one payload slot. */
export interface GraphState {
  phase: "idle" | "loading" | "ok" | "error";
  data?: WtGraphPayload;
  error?: { code: string; reason?: string; retryable: boolean };
  /** The `graphSigOf` signature the current data/error was fetched under. */
  sig: string;
  /** An ok payload being re-pulled stays visible under this flag (aria-busy). */
  refreshing?: true;
}

export interface UseWorktreeGraphDeps {
  /** `UseHubHandle.worktreeGraph` — absent (old hub / test fake) ⇒ scope null ⇒ all no-ops. */
  readonly transport?: WorktreeGraphTransport | undefined;
  /** §4.3 scope derivation result (`wtgraphScopeOf`), as a ref so caps/session changes react. */
  readonly scope: Readonly<Ref<GraphScope | null>>;
  /** §4.3: the worktree the graph renders (`pickGraphWt`) — a change while expanded re-pulls
   *  immediately (the graph answers a DIFFERENT worktree; no debounce). */
  readonly wt: Readonly<Ref<string | null>>;
}

export interface UseWorktreeGraphHandle {
  readonly expanded: Ref<boolean>;
  readonly state: Ref<GraphState>;
  toggle(): void;
  refresh(): void;
  onRowsChanged(rows: readonly WorktreeRowWire[]): void;
  dispose(): void;
}

/** Value identity of a scope (`null` ⇒ ""): what the invalidation watch compares. */
function scopeKeyOf(scope: GraphScope | null): string {
  return scope === null ? "" : `${scope.agentKey}\u0000${scope.sessionId}`;
}

function isSessionChanged(outcome: Extract<WtDiffOutcome<unknown>, { ok: false }>): boolean {
  return outcome.error === "E_SESSION_CHANGED";
}

/** §4.3 retryable errors: client-local failures (status 0), 429, everything 5xx — the same
 *  taxonomy as wtdiff; the graph's own 504 log-timeout lands here as a 5xx. */
function retryableError(outcome: Extract<WtDiffOutcome<unknown>, { ok: false }>): boolean {
  return outcome.status === 0 || outcome.status === 429 || outcome.status >= 500;
}

export function useWorktreeGraph(deps: UseWorktreeGraphDeps): UseWorktreeGraphHandle {
  const expanded = ref(false);
  const state = ref<GraphState>({ phase: "idle", sig: "" });

  /** Latest `graphSigOf` sample, updated by every `onRowsChanged` call. */
  let liveSig = "";
  let ctl: AbortController | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;

  function abortInFlight(): void {
    if (ctl !== null) {
      ctl.abort();
      ctl = null;
    }
  }

  function clearTimer(): void {
    if (refreshTimer !== null) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
  }

  /**
   * The single pull path. Expanding / manual refresh / the debounced re-pull all land here;
   * `onRowsChanged`'s debounce calls it only while expanded with a scope. An ok payload stays
   * visible (refreshing) while re-pulled; anything else shows loading.
   */
  function pull(): void {
    const sc = deps.scope.value;
    const transport = deps.transport;
    const wt = deps.wt.value;
    if (sc === null || transport === undefined || wt === null || wt === "") return;
    abortInFlight();
    clearTimer();
    const sigAtStart = liveSig;
    const ac = new AbortController();
    ctl = ac;
    const prev = state.value;
    state.value =
      prev.phase === "ok" && prev.data !== undefined
        ? { ...prev, refreshing: true }
        : { phase: "loading", sig: sigAtStart };
    void transport
      .graph({ agentKey: sc.agentKey, sessionId: sc.sessionId, wt }, { signal: ac.signal })
      .then((outcome) => {
        if (ctl !== ac) return; // superseded by a newer pull / collapse / clear
        ctl = null;
        if (outcome.ok) {
          state.value = { phase: "ok", data: outcome.value, sig: sigAtStart };
          return;
        }
        if (isSessionChanged(outcome)) {
          // a mismatched-session answer means the scope is about to flip — surface it as a
          // plain error so the panel survives even when the scope ref lags one frame
          state.value = { phase: "error", sig: sigAtStart, error: { code: outcome.error, retryable: false } };
          return;
        }
        state.value = {
          phase: "error",
          sig: sigAtStart,
          error: {
            code: outcome.error,
            ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
            retryable: retryableError(outcome),
          },
        };
      });
  }

  function scheduleRefresh(): void {
    clearTimer(); // 去抖: every further sig change restarts the window
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      if (expanded.value && deps.scope.value !== null) pull();
    }, WTGRAPH_REFRESH_DEBOUNCE_MS);
  }

  function toggle(): void {
    if (expanded.value) {
      // 收起: abort in-flight, keep the data — a re-expand never refetches
      expanded.value = false;
      clearTimer();
      abortInFlight();
      return;
    }
    expanded.value = true;
    // 展开拉一次 — only the FIRST expansion (or after a scope clear) pulls
    if (state.value.phase === "idle" || state.value.phase === "error") pull();
    else if (state.value.sig !== liveSig) pull();
  }

  function refresh(): void {
    if (deps.scope.value === null) return;
    pull();
  }

  function onRowsChanged(rows: readonly WorktreeRowWire[]): void {
    const sig = graphSigOf(rows);
    liveSig = sig;
    // §4.3: only an EXPANDED graph with existing state re-pulls (debounced) when the sig moved.
    const st = state.value;
    if (expanded.value && (st.phase === "ok" || st.phase === "error") && st.sig !== sig) scheduleRefresh();
  }

  // Scope invalidation (the useWorktreeDiff posture): ANY scope change — gone OR merely
  // different (session switch) — aborts in-flight, clears timers and resets to idle+collapsed
  // so the section starts over; keyed by VALUE, not identity (the panel's scope is a computed
  // that rebuilds a fresh object on every recompute).
  const stopScopeWatch = watch(
    () => scopeKeyOf(deps.scope.value),
    (next, prev) => {
      if (next === prev) return;
      clearTimer();
      abortInFlight();
      state.value = { phase: "idle", sig: "" };
      expanded.value = false;
    },
  );

  // §4.3「scope 或 wt 变化 ⇒ abort」: the picked worktree flipping (current row moved, the
  // old one dropped) re-pulls immediately when expanded — the stale graph would answer a
  // different worktree, so a debounce would only prolong the wrongness. A null wt (nothing
  // graphable) collapses the section the same way a scope change does.
  const stopWtWatch = watch(
    () => deps.wt.value,
    (next, prev) => {
      if (next === prev) return;
      clearTimer();
      abortInFlight();
      if (!expanded.value || next === null) {
        state.value = { phase: "idle", sig: "" };
        return;
      }
      pull();
    },
  );

  let disposed = false;
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    stopScopeWatch();
    stopWtWatch();
    clearTimer();
    abortInFlight();
  }
  onScopeDispose(dispose, true); // failSilently: safe outside a component/effect scope

  return { expanded, state, toggle, refresh, onRowsChanged, dispose };
}
