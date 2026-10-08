/**
 * worktree-diff plan v3.1 §4.5 (package D5): the worktree-diff state machine — one list per
 * expanded worktree row plus a single file-dialog slot.
 *
 * Interrupt rules, all folding into per-target AbortControllers + seq-free identity guards:
 * - a NEW pull for the same wt aborts the previous one (the loser's settle is dropped by
 *   comparing the stored controller, so an aborted fetch's `E_ABORT` outcome never lands);
 * - COLLAPSING a row aborts its in-flight list pull but KEEPS the data (收起不重拉 — a
 *   re-expand never refetches, §4.1);
 * - the dialog: `openFile` supersedes the in-flight `file` fetch, `closeDialog` aborts it;
 * - the SCOPE (agentKey|sessionId) changing — session switch, agent deselected, caps lost —
 *   clears everything: lists, expansion state, timers, the dialog.
 *
 * Refresh (§4.5/D13): `onRowsChanged` recomputes every row's `rowSig`; an EXPANDED row whose
 * sig differs from the sig its list data was fetched under re-pulls after a 3 s debounce
 * (reset on every further change); the OPEN DIALOG's row changing sig only raises the
 * 「工作区已变化」`stale` banner — the dialog NEVER auto-refreshes while being read.
 *
 * 409 `E_STALE_CTX` (§4.5, plan #1): a `file` answer 409 (reason `base`|`entry`) auto re-pulls
 * the wt's list; if the same `(path, orig)` is still a requestable entry there, the `file`
 * fetch retries EXACTLY ONCE with the new base (`staleRetried` guard — never loops); anything
 * else settles the dialog into the 不可查看 state (`unviewable`). `refreshDialog` is the manual
 * path and deliberately re-arms the one-shot retry (重拉清单 ⇒ 同上分支).
 *
 * `mode` is the split/unified dialog preference: session-memory only (D16 — no persistence;
 * the source-scan localStorage allowlist would reject it anyway).
 */
import { onScopeDispose, reactive, ref, watch, type Ref } from "vue";
import { rowSig } from "@logic/wtdiff.js";
import {
  isWtRequestableEntry,
  parseUnifiedPatch,
  type ParsedPatch,
  type WtDiffFileEntry,
  type WtDiffFileList,
  type WtDiffFilePayload,
} from "@protocol/worktree-diff.js";
import type { WorktreeRowWire } from "@protocol/messages.js";
import type { WorktreeDiffTransport, WtDiffOutcome, WtDiffScope } from "../transport/types.js";

/** §4.5: expanded-row list refresh debounce (签名变化 3 s 去抖重拉). */
export const WTDIFF_REFRESH_DEBOUNCE_MS = 3_000;

/** §4.5 ListState — one per expanded worktree row, keyed by the row's `path`. */
export interface ListState {
  phase: "idle" | "loading" | "ok" | "error";
  data?: WtDiffFileList;
  error?: { code: string; reason?: string; retryable: boolean };
  /** The `rowSig` the current `data`/`error` was fetched under (equality vs the live row's
   * sig drives the debounced refresh). */
  sig: string;
  /** An ok list being re-pulled keeps its entries visible under this flag. */
  refreshing?: true;
}

/** §4.5 DialogState — the single open-file slot. */
export type DialogState =
  | { phase: "closed" }
  | {
      phase: "loading" | "ok" | "error";
      wt: string;
      entry: WtDiffFileEntry;
      base: string;
      /** Rides the `file` request when the source list was pulled with `untracked:"no"` —
       * it participates in the hub's changeset key (§4.6), so omitting it would 409. */
      untracked?: "no";
      payload?: WtDiffFilePayload;
      parsed?: ParsedPatch;
      error?: { code: string; reason?: string };
      /** The dialog's row sig changed after open (banner only — never auto-refreshed). */
      stale: boolean;
      /** §4.5's terminal 不可查看 state: the 409-stale re-pull no longer finds the entry. */
      unviewable?: true;
    };

export interface UseWorktreeDiffDeps {
  /** `UseHubHandle.worktreeDiff` — absent (old hub / test fake) ⇒ scope is null ⇒ all no-ops. */
  readonly transport?: WorktreeDiffTransport | undefined;
  /** §4.1 scope derivation result (`wtdiffScopeOf`), as a ref so caps/session changes react. */
  readonly scope: Readonly<Ref<WtDiffScope | null>>;
}

export interface UseWorktreeDiffHandle {
  readonly lists: Map<string, ListState>;
  readonly dialog: Ref<DialogState>;
  readonly mode: Ref<"split" | "unified">;
  readonly expanded: Set<string>;
  isExpanded(wt: string): boolean;
  toggleRow(row: WorktreeRowWire): void;
  refreshList(wt: string): void;
  openFile(wt: string, entry: WtDiffFileEntry): void;
  refreshDialog(): void;
  closeDialog(): void;
  setMode(mode: "split" | "unified"): void;
  onRowsChanged(rows: readonly WorktreeRowWire[]): void;
  dispose(): void;
}

/** Value identity of a scope (`null` ⇒ ""): what the invalidation watch compares. */
function scopeKeyOf(scope: WtDiffScope | null): string {
  return scope === null ? "" : `${scope.agentKey}\u0000${scope.sessionId}`;
}

/** `E_SESSION_CHANGED` closes the dialog outright (the panel is about to re-render anyway). */
function isSessionChanged(outcome: Extract<WtDiffOutcome<unknown>, { ok: false }>): boolean {
  return outcome.error === "E_SESSION_CHANGED";
}

function isStaleCtx(outcome: Extract<WtDiffOutcome<unknown>, { ok: false }>): boolean {
  return outcome.status === 409 && outcome.error === "E_STALE_CTX";
}

/** Retryable list errors: client-local failures (status 0), 429 and everything 5xx. */
function retryableError(outcome: Extract<WtDiffOutcome<unknown>, { ok: false }>): boolean {
  return outcome.status === 0 || outcome.status === 429 || outcome.status >= 500;
}

/** Find the live counterpart of a dialog entry in a freshly pulled list (path+orig exact). */
function findEntry(list: WtDiffFileList, entry: WtDiffFileEntry): WtDiffFileEntry | undefined {
  return list.entries.find((e) => e.path === entry.path && e.orig === entry.orig);
}

/** §1.5 error matrix → `diff.*` i18n KEY (never the text — locale lives in the component).
 * Shared by the file list and the dialog so both surfaces speak the same taxonomy; unknown
 * code/reason pairs degrade to `errGeneric`, which interpolates the raw code for diagnosis. */
export function wtdErrorKey(code: string, reason?: string): string {
  if (code === "E_WTDIFF_DENIED") {
    if (reason === "not-repo") return "diff.errNotRepo";
    if (reason === "not-worktree") return "diff.errNotWorktree";
    return "diff.errDenied";
  }
  if (code === "E_WTDIFF_UNSUPPORTED") {
    if (reason === "unborn") return "diff.errUnborn";
    if (reason === "symlink") return "diff.errSymlink";
    if (reason === "git-unavailable") return "diff.errGitUnavailable";
    if (reason === "git-too-old") return "diff.errGitTooOld";
    if (reason === "filter-config") return "diff.errFilterConfig";
    return "diff.errGeneric";
  }
  if (code === "E_STALE_CTX") return "diff.errStaleCtx";
  if (code === "E_SESSION_CHANGED") return "diff.errSession";
  if (code === "E_DEADLINE") return "diff.errDeadline";
  if (code === "E_RATE") return "diff.errRate";
  if (code === "E_BUSY") return "diff.errBusy";
  return "diff.errGeneric";
}

export function useWorktreeDiff(deps: UseWorktreeDiffDeps): UseWorktreeDiffHandle {
  const lists = reactive(new Map<string, ListState>());
  const dialog = ref<DialogState>({ phase: "closed" }) as Ref<DialogState>;
  const mode = ref<"split" | "unified">("split");
  const expanded = reactive(new Set<string>());

  /** Latest `rowSig` per wt, updated by every `onRowsChanged`/`toggleRow`. */
  const liveSigs = new Map<string, string>();
  /** The list's untracked mode per wt (§4.6: a `file` request must match its list's mode).
   * The v1 UI always pulls `all`; the map exists so a future degraded mode rides correctly. */
  const listModes = new Map<string, "all" | "no">();

  const listCtl = new Map<string, AbortController>();
  const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let dialogCtl: AbortController | null = null;
  /** Bumped by every dialog-affecting action (open/refresh/close/clear); a settle whose seq is
   * stale drops — replacing the object-identity guard, which a banner-only `stale` flip from
   * `onRowsChanged` (a fresh copy) would otherwise wrongly invalidate. */
  let dialogSeq = 0;
  /** §4.5 恰好一次: the 409 auto-retry arms once per dialog open / manual refresh. */
  let staleRetried = false;
  /** The row sig the dialog's content was loaded under (`stale` = live sig differs). */
  let dialogSig = "";

  function abortList(wt: string): void {
    const ctl = listCtl.get(wt);
    if (ctl !== undefined) {
      ctl.abort();
      listCtl.delete(wt);
    }
  }

  function abortDialog(): void {
    dialogSeq++;
    if (dialogCtl !== null) {
      dialogCtl.abort();
      dialogCtl = null;
    }
  }

  function clearTimer(wt: string): void {
    const t = refreshTimers.get(wt);
    if (t !== undefined) {
      clearTimeout(t);
      refreshTimers.delete(wt);
    }
  }

  /**
   * The single list pull path. Public actions fire-and-forget it; the 409-stale dialog flow
   * AWAITS it (the re-pull's result decides the retry-vs-unviewable branch). Returns the
   * pulled list, or null when there is no scope / the pull was superseded or failed.
   */
  function pullList(wt: string): Promise<WtDiffFileList | null> {
    const sc = deps.scope.value;
    const transport = deps.transport;
    if (sc === null || transport === undefined || wt === "") return Promise.resolve(null);
    const sigAtStart = liveSigs.get(wt) ?? "";
    const prev = lists.get(wt);
    abortList(wt);
    clearTimer(wt);
    const ac = new AbortController();
    listCtl.set(wt, ac);
    // An ok list stays visible (with `refreshing`) while re-pulled; anything else shows loading.
    lists.set(
      wt,
      prev !== undefined && prev.phase === "ok" && prev.data !== undefined
        ? { ...prev, refreshing: true }
        : { phase: "loading", sig: sigAtStart },
    );
    return transport
      .files(
        {
          agentKey: sc.agentKey,
          sessionId: sc.sessionId,
          wt,
          ...(listModes.get(wt) === "no" ? { untracked: "no" as const } : {}),
        },
        { signal: ac.signal },
      )
      .then((outcome) => {
        if (listCtl.get(wt) !== ac) return null; // superseded by a newer pull / collapse / clear
        listCtl.delete(wt);
        if (!outcome.ok) {
          if (isSessionChanged(outcome)) {
            // A mismatched-session answer means the UI's scope is about to flip; surface it as
            // a plain error so the panel survives even when the scope ref lags one frame.
            lists.set(wt, { phase: "error", sig: sigAtStart, error: { code: outcome.error, retryable: false } });
            return null;
          }
          lists.set(wt, {
            phase: "error",
            sig: sigAtStart,
            error: {
              code: outcome.error,
              ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
              retryable: retryableError(outcome),
            },
          });
          return null;
        }
        lists.set(wt, { phase: "ok", data: outcome.value, sig: sigAtStart });
        return outcome.value;
      });
  }

  function scheduleRefresh(wt: string): void {
    clearTimer(wt); // 去抖: every further sig change restarts the window
    const timer = setTimeout(() => {
      refreshTimers.delete(wt);
      if (expanded.has(wt) && deps.scope.value !== null) void pullList(wt);
    }, WTDIFF_REFRESH_DEBOUNCE_MS);
    refreshTimers.set(wt, timer);
  }

  function isExpanded(wt: string): boolean {
    return expanded.has(wt);
  }

  function toggleRow(row: WorktreeRowWire): void {
    const wt = typeof row.path === "string" ? row.path : "";
    if (wt === "" || deps.scope.value === null) return;
    liveSigs.set(wt, rowSig(row));
    if (expanded.has(wt)) {
      // 收起: abort the in-flight pull, KEEP the data — a re-expand never refetches.
      expanded.delete(wt);
      clearTimer(wt);
      abortList(wt);
      return;
    }
    expanded.add(wt);
    // 展开拉一次 — only the FIRST expansion (or after a scope clear) pulls.
    if (!lists.has(wt)) void pullList(wt);
  }

  function refreshList(wt: string): void {
    if (deps.scope.value === null || wt === "") return;
    void pullList(wt);
  }

  /**
   * The dialog's `file` fetch + settle. `d` is the dialog state to install on success; the
   * 409 branch may replace it with a re-pulled base (exactly once, `staleRetried`).
   */
  function fetchDialog(d: Extract<DialogState, { phase: "loading" | "ok" | "error" }>): void {
    const sc = deps.scope.value;
    const transport = deps.transport;
    if (sc === null || transport === undefined) return;
    abortDialog();
    // The content about to load corresponds to the row state NOW; a sig move during the
    // fetch re-raises the banner on settle (compare live vs sigAtStart below).
    const sigAtStart = liveSigs.get(d.wt) ?? "";
    const mySeq = dialogSeq;
    const ac = new AbortController();
    dialogCtl = ac;
    void transport
      .file(
        {
          agentKey: sc.agentKey,
          sessionId: sc.sessionId,
          wt: d.wt,
          base: d.base,
          path: d.entry.path,
          ...(d.entry.orig !== undefined ? { orig: d.entry.orig } : {}),
          ...(d.untracked === "no" ? { untracked: "no" as const } : {}),
        },
        { signal: ac.signal },
      )
      .then((outcome) => {
        if (mySeq !== dialogSeq || dialogCtl !== ac) return; // superseded / closed / cleared
        dialogCtl = null;
        if (outcome.ok) {
          const liveSig = liveSigs.get(d.wt) ?? sigAtStart;
          dialogSig = sigAtStart;
          dialog.value = {
            ...d,
            phase: "ok",
            payload: outcome.value,
            parsed: parseUnifiedPatch(outcome.value.patch),
            stale: liveSig !== sigAtStart,
          };
          return;
        }
        if (isSessionChanged(outcome)) {
          dialog.value = { phase: "closed" };
          return;
        }
        if (isStaleCtx(outcome)) {
          if (staleRetried) {
            // the one retry already happened — settle as 不可查看 (§4.5 恰好一次, no loops)
            dialog.value = { ...d, phase: "error", stale: false, unviewable: true };
            return;
          }
          staleRetried = true;
          void settleAfterStale(d);
          return;
        }
        dialog.value = {
          ...d,
          phase: "error",
          error: { code: outcome.error, ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}) },
        };
      });
  }

  /** Un-narrowed read of the dialog ref (a function boundary defeats TS's flow narrowing of
   * `dialog.value` after our own assignments — the await window can replace the state). */
  function currentDialog(): DialogState {
    return dialog.value;
  }

  /**
   * §4.5's stale branch, shared by the 409 auto path and the manual `refreshDialog`:
   * re-pull the wt's list, then either re-load the `file` with the fresh base (entry still
   * there and requestable) or settle the dialog as 不可查看.
   */
  async function settleAfterStale(d: Extract<DialogState, { phase: "loading" | "ok" | "error" }>): Promise<void> {
    // seq 守卫（D5 验收 P1）：await 窗口内 openFile/closeDialog/新一次 stale 都会经 abortDialog
    // 推进 dialogSeq——少了它，同 wt 打开另一文件会被这里的旧条目重试覆盖（违反 openFile 的
    // supersede 契约）。注意本函数自己写 dialog.value 不 bump seq，守卫必须放在 await 之后。
    const mySeq = dialogSeq;
    dialog.value = { ...d, phase: "loading", stale: false };
    const list = await pullList(d.wt);
    if (mySeq !== dialogSeq) return; // superseded during the list re-pull
    const cur = currentDialog();
    if (cur.phase === "closed" || cur.wt !== d.wt) return; // replaced meanwhile
    if (list !== null) {
      const entry = findEntry(list, d.entry);
      if (entry !== undefined && isWtRequestableEntry(entry)) {
        const next = {
          ...d,
          phase: "loading" as const,
          entry,
          base: list.base,
          ...(listModes.get(d.wt) === "no" ? { untracked: "no" as const } : {}),
          stale: false,
        };
        dialog.value = next;
        fetchDialog(next);
        return;
      }
    }
    dialog.value = { ...d, phase: "error", stale: false, unviewable: true };
  }

  function openFile(wt: string, entry: WtDiffFileEntry): void {
    const sc = deps.scope.value;
    if (sc === null || deps.transport === undefined || wt === "") return;
    const list = lists.get(wt);
    const base = list?.data?.base;
    if (list?.phase !== "ok" || base === undefined || !isWtRequestableEntry(entry)) return;
    staleRetried = false;
    dialogSig = liveSigs.get(wt) ?? "";
    const d = {
      phase: "loading" as const,
      wt,
      entry,
      base,
      ...(listModes.get(wt) === "no" ? { untracked: "no" as const } : {}),
      stale: false,
    };
    dialog.value = d;
    fetchDialog(d);
  }

  function refreshDialog(): void {
    const d = dialog.value;
    if (d.phase === "closed" || deps.scope.value === null) return;
    staleRetried = false; // a manual refresh re-arms the one-shot 409 retry
    void settleAfterStale({ ...d, phase: "loading", stale: false });
  }

  function closeDialog(): void {
    abortDialog();
    if (dialog.value.phase !== "closed") dialog.value = { phase: "closed" };
  }

  function setMode(next: "split" | "unified"): void {
    mode.value = next;
  }

  function onRowsChanged(rows: readonly WorktreeRowWire[]): void {
    for (const row of rows) {
      if (row === null || typeof row !== "object") continue;
      const wt = typeof row.path === "string" ? row.path : "";
      if (wt === "") continue;
      const sig = rowSig(row);
      liveSigs.set(wt, sig);
      const st = lists.get(wt);
      // D13: only EXPANDED rows with existing state re-pull (debounced) when the sig moved.
      if (st !== undefined && expanded.has(wt) && st.sig !== sig) scheduleRefresh(wt);
    }
    // D13: the dialog NEVER auto-refreshes — a sig move on its own row only raises the banner.
    const d = dialog.value;
    if (d.phase !== "closed") {
      const sig = liveSigs.get(d.wt);
      if (sig !== undefined && sig !== dialogSig && !d.stale) {
        dialog.value = { ...d, stale: true };
      }
    }
  }

  // Scope invalidation (§4.5「scope 变 null 全清」, and — preview's same posture — ANY scope
  // change: a session switch invalidates every list base even though a scope still exists).
  // Keyed by VALUE, not identity: the panel's `scope` is a computed that builds a fresh
  // `{ agentKey, sessionId }` object on every recompute (each status/session frame — e.g. just
  // sending a message), and an identity watch wiped every expanded list on each of them.
  const stopScopeWatch = watch(
    () => scopeKeyOf(deps.scope.value),
    (next, prev) => {
      if (next === prev) return;
      for (const ctl of listCtl.values()) ctl.abort();
      listCtl.clear();
      for (const t of refreshTimers.values()) clearTimeout(t);
      refreshTimers.clear();
      lists.clear();
      expanded.clear();
      liveSigs.clear();
      closeDialog();
    },
  );

  let disposed = false;
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    stopScopeWatch();
    for (const ctl of listCtl.values()) ctl.abort();
    listCtl.clear();
    for (const t of refreshTimers.values()) clearTimeout(t);
    refreshTimers.clear();
    abortDialog();
  }
  onScopeDispose(dispose, true); // failSilently: safe outside a component/effect scope

  return {
    lists,
    dialog,
    mode,
    expanded,
    isExpanded,
    toggleRow,
    refreshList,
    openFile,
    refreshDialog,
    closeDialog,
    setMode,
    onRowsChanged,
    dispose,
  };
}
