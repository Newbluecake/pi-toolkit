/**
 * wtgraph.files.v1 — the commit-graph row expansion state (one open row at a time).
 *
 * - `toggle(h)` opens a row (closing any other) or closes the open one. Opening fetches the
 *   commit's file list once; a re-open of a row whose list already loaded never refetches
 *   (commit content is immutable). Closing / switching rows aborts the in-flight fetch.
 * - `retry(h)` refetches (the error state's button).
 * - `onCommitsChanged(oids)` — the graph re-pulled: an open row whose commit left the window
 *   closes; an open row stuck on 409 `E_STALE_CTX` (the hub no longer had the oid in a served
 *   window — hub restart / window moved) refetches now that the graph was served again.
 * - the SCOPE (agentKey|sessionId) or the picked worktree changing clears everything.
 *
 * `enabled` is false unless the hub declared the cap AND the transport offers the call — the
 * component then keeps rows inert (pre-feature behaviour). No DOM, no i18n.
 */
import { computed, onScopeDispose, ref, shallowRef, watch, type ComputedRef, type Ref } from "vue";
import type { WorktreeGraphTransport, WtDiffOutcome } from "../transport/types.js";
import type { WtGraphCommitFiles } from "@protocol/worktree-graph.js";
import type { GraphScope } from "@logic/gitGraphScope.js";

/** Client-side memo bound (loaded lists kept for instant re-open). */
export const COMMIT_FILES_MEMO_MAX = 50;

export interface CommitFilesState {
  phase: "loading" | "ok" | "error";
  data?: WtGraphCommitFiles;
  error?: { code: string; reason?: string; retryable: boolean };
}

export interface UseCommitFilesDeps {
  readonly transport?: WorktreeGraphTransport | undefined;
  readonly scope: Readonly<Ref<GraphScope | null>>;
  readonly wt: Readonly<Ref<string | null>>;
}

export interface UseCommitFilesHandle {
  readonly enabled: ComputedRef<boolean>;
  /** The open row's commit oid (null = none). */
  readonly open: Ref<string | null>;
  /** Per-commit state (immutable map — replaced on every change). */
  readonly states: Ref<ReadonlyMap<string, CommitFilesState>>;
  toggle(h: string): void;
  retry(h: string): void;
  onCommitsChanged(oids: readonly string[]): void;
  dispose(): void;
}

function retryable(o: Extract<WtDiffOutcome<unknown>, { ok: false }>): boolean {
  return o.status === 0 || o.status === 429 || o.status === 409 || o.status >= 500;
}

export function useCommitFiles(deps: UseCommitFilesDeps): UseCommitFilesHandle {
  const open = ref<string | null>(null);
  const states = shallowRef<ReadonlyMap<string, CommitFilesState>>(new Map());
  let ctl: AbortController | null = null;
  let inflightH: string | null = null;

  const enabled = computed(() => deps.scope.value?.files === true && typeof deps.transport?.commitFiles === "function");

  function setState(h: string, s: CommitFilesState | undefined): void {
    const next = new Map(states.value);
    next.delete(h); // re-insert ⇒ newest last (memo LRU order)
    if (s !== undefined) next.set(h, s);
    while (next.size > COMMIT_FILES_MEMO_MAX) {
      const oldest = next.keys().next().value;
      if (oldest === undefined || oldest === open.value) break;
      next.delete(oldest);
    }
    states.value = next;
  }

  function abortInFlight(): void {
    if (ctl !== null) {
      ctl.abort();
      ctl = null;
    }
    // an aborted loading row must not stay "loading" forever
    if (inflightH !== null && states.value.get(inflightH)?.phase === "loading") setState(inflightH, undefined);
    inflightH = null;
  }

  function fetchFiles(h: string): void {
    const sc = deps.scope.value;
    const wt = deps.wt.value;
    const transport = deps.transport;
    if (!enabled.value || sc === null || wt === null || wt === "" || transport?.commitFiles === undefined) return;
    abortInFlight();
    const ac = new AbortController();
    ctl = ac;
    inflightH = h;
    setState(h, { phase: "loading" });
    void transport
      .commitFiles({ agentKey: sc.agentKey, sessionId: sc.sessionId, wt, h }, { signal: ac.signal })
      .then((outcome) => {
        if (ctl !== ac) return; // superseded / aborted
        ctl = null;
        inflightH = null;
        if (outcome.ok) {
          setState(h, { phase: "ok", data: outcome.value });
          return;
        }
        setState(h, {
          phase: "error",
          error: {
            code: outcome.error,
            ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
            retryable: retryable(outcome),
          },
        });
      });
  }

  function toggle(h: string): void {
    if (!enabled.value) return;
    if (open.value === h) {
      open.value = null;
      abortInFlight();
      return;
    }
    abortInFlight();
    open.value = h;
    if (states.value.get(h)?.phase !== "ok") fetchFiles(h);
  }

  function retry(h: string): void {
    if (open.value !== h) return;
    fetchFiles(h);
  }

  function onCommitsChanged(oids: readonly string[]): void {
    const h = open.value;
    if (h === null) return;
    if (!oids.includes(h)) {
      open.value = null;
      abortInFlight();
      return;
    }
    const st = states.value.get(h);
    if (st?.phase === "error" && st.error?.code === "E_STALE_CTX") fetchFiles(h);
  }

  function clearAll(): void {
    abortInFlight();
    open.value = null;
    states.value = new Map();
  }

  const stopScope = watch(
    () => {
      const sc = deps.scope.value;
      return sc === null ? "" : `${sc.agentKey}\u0000${sc.sessionId}\u0000${sc.files === true ? 1 : 0}`;
    },
    (next, prev) => {
      if (next !== prev) clearAll();
    },
  );
  const stopWt = watch(
    () => deps.wt.value,
    (next, prev) => {
      if (next !== prev) clearAll();
    },
  );

  let disposed = false;
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    stopScope();
    stopWt();
    abortInFlight();
  }
  onScopeDispose(dispose, true);

  return { enabled, open, states, toggle, retry, onCommitsChanged, dispose };
}
