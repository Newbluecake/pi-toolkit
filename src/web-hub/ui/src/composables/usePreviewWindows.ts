/**
 * web-hub-preview-windows plan r2 §4.3/§3.3/§3.4 (W1): the App-level WINDOW MANAGER — one
 * shared scope/probe/history budget, one `createPreviewMachine` per open window, and the
 * §4.3 FROZEN face (`PreviewWindowsFace`) W2/W3 build against. DOM-free by contract: the
 * manager never touches focus/DOM itself — it emits `focusRequest`/`limitNotice`
 * `{id, seq}` pairs and the host (W2's PreviewHost) lands them after nextTick.
 *
 * State model (§4.1):
 * - `windows`: creation order — the keyed v-for renders this and NEVER reorders (z-order
 *   rides `--pw-z`, so an iframe is never remounted);
 * - `order`: activation order, last = active = highest z; `focusWindow` only reorders;
 * - every machine gets `onSessionChanged(k)` = "closeAll iff k is the CURRENT scope key"
 *   (§4.4 — a late E_SESSION_CHANGED from an old scope never closes the new scope's
 *   windows), and the shared history budget port (§4.5);
 * - the manager-level scope watcher (session switch / cwd drift / deselected / caps lost)
 *   and the phone's list-route deselect both funnel into `closeAll()` (user 拍板 2).
 *
 * Routing (§3.1–§3.4, all entry points funnel through `openWindow`):
 * - known dir → navigate IN PLACE inside the initiating window (takes priority over dedup);
 * - known file → new window; unknown → SPECULATIVE window whose first settle folds back
 *   into the origin window iff it turns out to be a dir AND the origin did not page away
 *   (navEpoch) and still exists (§3.3);
 * - dedup by the windows' CURRENT view path (loading/error phases included — a slow request
 *   double-click produces exactly one request) → focus + focusRequest;
 * - at `PREVIEW_WINDOW_MAX` (6) the target (initiating window, else the active one)
 *   navigates in place and `limitNotice` fires (cleared by that window's next
 *   navigate/back/openFrom, by the count dropping below the cap, or after 8 s).
 *
 * The root handle (§4.3): `view` mirrors the ACTIVE window (closed with no windows),
 * `open` appends a window, `close` = closeAll (the privacy relock path), `retry` forwards
 * to the active window — and it deliberately does NOT expose navigate/back/up, so
 * `asDirHandle(root) === null` and the host MUST go through `asWindowsHandle`.
 */
import { computed, onScopeDispose, ref, shallowRef, watch, type Ref, type ShallowRef } from "vue";
import { scopeKeyOf } from "@logic/preview.js";
import { PreviewHistoryBudget, historyBudgetFor } from "@logic/previewHistoryBudget.js";
import { routeOf, type PreviewRoute } from "@logic/previewWindowRoute.js";
import {
  createPreviewMachine,
  previewScopeRef,
  type PreviewDirPhase,
  type PreviewMachine,
  type PreviewNavRef,
  type UsePreviewOptions,
} from "./usePreview.js";
import { usePreviewProbe, type PreviewProbeHandle } from "./usePreviewProbe.js";
import type { PreviewHandle, PreviewPathScope, PreviewView } from "../types.js";

/** §3.4/用户拍板 4: the desktop window cap — the 7th open navigates in place with a notice. */
export const PREVIEW_WINDOW_MAX = 6;

/** §3.4: how long a `limitNotice` survives without any of the other clear conditions. */
const LIMIT_NOTICE_TTL_MS = 8000;

export interface PreviewWindow {
  readonly id: number;
  readonly handle: PreviewMachine;
}

export type OpenWindowResult = "opened" | "focused" | "navigated" | "in-place" | "ignored";

/** §4.3 (FROZEN — W2/W3 build against this; do not deviate). */
export interface PreviewWindowsFace {
  /** Creation order = DOM order; never reordered (z rides `--pw-z`). */
  readonly windows: Readonly<ShallowRef<readonly PreviewWindow[]>>;
  /** Activation order, last = active = highest z. */
  readonly order: Readonly<Ref<readonly number[]>>;
  readonly activeId: Readonly<Ref<number | null>>;
  readonly focusRequest: Readonly<Ref<{ readonly id: number; readonly seq: number } | null>>;
  readonly limitNotice: Readonly<Ref<{ readonly id: number; readonly seq: number } | null>>;
  /** Open `ref` as seen from window `fromId` (null = from the conversation). `kindOf` comes
   * from the shared probe; `opts.route` overrides the §3.2 table (dir-row clicks pass it). */
  openWindow(ref: PreviewNavRef, fromId: number | null, opts?: { route?: PreviewRoute }): OpenWindowResult;
  /** Unknown id ⇒ no-op. Disposes the machine, removes exactly this node (keyed v-for),
   * drops its budget entries, stops its watchers. */
  closeWindow(id: number): void;
  /** Only reorders `order`; `moveFocus` additionally emits a fresh `focusRequest`. */
  focusWindow(id: number, opts?: { moveFocus?: boolean }): void;
  closeAll(): void;
}

export type PreviewWindowsHandle = PreviewHandle & PreviewWindowsFace;

/** One managed window's manager-side bookkeeping (machine + §3.3/§3.4 metadata). */
interface WindowMeta {
  readonly id: number;
  readonly handle: PreviewMachine;
  /** §3.3: the window this one was speculatively opened from (null = root/normal open). */
  readonly originId: number | null;
  /** §3.3: fold back on the FIRST settle iff it is a dir (one-shot). */
  pendingFold: boolean;
  /** §3.3: the origin's navEpoch at speculative-open time — a mismatch means it paged away. */
  readonly originEpoch: number;
  /** The navEpoch this window's current limitNotice was armed at (§3.4 clear rule ①). */
  noticeEpoch: number | null;
  readonly stopWatchers: Array<() => void>;
}

/** Recover the §4.3 windows face from an injected `PreviewHandle` (duck-typed, same
 * convention as `asDirHandle`): a plain single-window handle or a component fake gets
 * `null` and the W2 host renders nothing. */
export function asWindowsHandle(h: PreviewHandle): PreviewWindowsHandle | null {
  const w = h as Partial<PreviewWindowsHandle>;
  return typeof w.openWindow === "function" &&
    typeof w.closeWindow === "function" &&
    typeof w.focusWindow === "function" &&
    typeof w.closeAll === "function" &&
    w.windows !== undefined &&
    w.order !== undefined &&
    w.activeId !== undefined
    ? (h as PreviewWindowsHandle)
    : null;
}

export function usePreviewWindows(opts: UsePreviewOptions): PreviewHandle {
  // §4.1: the globally-shared trio — scope derivation, probe, history budget.
  const scope = previewScopeRef(opts);
  const probeHandle: PreviewProbeHandle | undefined =
    opts.preview !== undefined && opts.preview.probe !== undefined
      ? usePreviewProbe({ probe: opts.preview.probe, scope })
      : undefined;
  const history = new PreviewHistoryBudget(opts.historyBudgetBytes ?? historyBudgetFor(opts.coarse.value));

  const windows = shallowRef<readonly PreviewWindow[]>([]);
  const order = ref<readonly number[]>([]);
  const activeId = computed(() => {
    const o = order.value;
    return o.length === 0 ? null : o[o.length - 1]!;
  });
  const focusRequest = ref<{ readonly id: number; readonly seq: number } | null>(null);
  const limitNotice = ref<{ readonly id: number; readonly seq: number } | null>(null);
  let focusSeq = 0;
  let noticeSeq = 0;
  let nextWindowId = 1; // source-scan bans randomUUID — ids are closure-scoped counters
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  const metas = new Map<number, WindowMeta>();

  /** §4.4 manager layer: only a key matching the CURRENT scope closes everything. */
  function onSessionChanged(key: string): void {
    if (key === scopeKeyOf(scope.value)) closeAll();
  }

  function windowOf(id: number | null): WindowMeta | null {
    return id === null ? null : (metas.get(id) ?? null);
  }

  function focusWindow(id: number, fopts?: { moveFocus?: boolean }): void {
    if (!metas.has(id)) return;
    order.value = [...order.value.filter((x) => x !== id), id];
    if (fopts?.moveFocus === true) focusRequest.value = { id, seq: ++focusSeq };
  }

  /** §3.4 clear rule ① (the openFrom half — navigate/back ride the navEpoch watcher). */
  function clearNoticeFor(id: number): void {
    if (limitNotice.value !== null && limitNotice.value.id === id) limitNotice.value = null;
  }

  function armLimitNotice(id: number): void {
    const seq = ++noticeSeq;
    limitNotice.value = { id, seq };
    const meta = metas.get(id);
    if (meta !== undefined) meta.noticeEpoch = meta.handle.navEpoch.value;
    if (noticeTimer !== null) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      noticeTimer = null;
      if (limitNotice.value !== null && limitNotice.value.seq === seq) limitNotice.value = null;
    }, LIMIT_NOTICE_TTL_MS);
  }

  function closeWindow(id: number): void {
    const meta = metas.get(id);
    if (meta === undefined) return;
    for (const stop of meta.stopWatchers) stop();
    meta.handle.dispose();
    metas.delete(id);
    windows.value = windows.value.filter((w) => w.id !== id);
    order.value = order.value.filter((x) => x !== id);
    history.dropWindow(id);
    if (limitNotice.value !== null && windows.value.length < PREVIEW_WINDOW_MAX) {
      limitNotice.value = null;
      // disarm the 8 s TTL timer too: closing the noticed window (or any window at the cap)
      // removes the notice, and the timer must not dangle until the TTL (closeAll already
      // did this — rework nit #3).
      if (noticeTimer !== null) {
        clearTimeout(noticeTimer);
        noticeTimer = null;
      }
    }
  }

  function closeAll(): void {
    for (const meta of metas.values()) {
      for (const stop of meta.stopWatchers) stop();
      meta.handle.dispose(); // dispose ⇒ clearVisit ⇒ budget.dropWindow(this id)
    }
    metas.clear();
    windows.value = [];
    order.value = [];
    if (noticeTimer !== null) {
      clearTimeout(noticeTimer);
      noticeTimer = null;
    }
    limitNotice.value = null;
  }

  // §4.4: the ONE manager-level scope watcher — session switch, cwd drift, deselection,
  // caps loss and the phone list-route deselect (selected → null) all land here (拍板 2).
  const stopScopeWatch = watch(
    () => scopeKeyOf(scope.value),
    (next, prev) => {
      if (next !== prev) closeAll();
    },
  );

  function openWindow(
    ref: PreviewNavRef,
    fromId: number | null,
    openOpts?: { route?: PreviewRoute },
  ): OpenWindowResult {
    if (disposed) return "ignored";
    if (scope.value === null || opts.preview === undefined) return "ignored";
    const from = windowOf(fromId);
    if (fromId !== null && from === null) return "ignored"; // a dead initiator never acts
    if (from !== null) clearNoticeFor(from.id); // §3.4 rule ① — this window opened something

    // §4.3 step 2: from the conversation there is no in-place target — every ref appends a
    // window (the "file" here only means "open a window", never a type claim).
    const route: PreviewRoute = from === null ? "file" : (openOpts?.route ?? routeOf(ref, probeHandle?.kindOf));

    // §3.2/§3.4: a KNOWN dir navigates in place — in-window dir routing outranks dedup.
    if (route === "dir" && from !== null) {
      from.handle.navigate({ path: ref.path, dir: true });
      return "in-place";
    }

    // §3.4 dedup: MRU order (order's tail first), by the windows' CURRENT view path —
    // loading/error/unsupported/tooLarge included, string-exact (no ~ normalization).
    for (let i = order.value.length - 1; i >= 0; i--) {
      const hit = metas.get(order.value[i]!);
      if (hit === undefined) continue;
      const v = hit.handle.view.value;
      if ("path" in v && v.path === ref.path) {
        focusWindow(order.value[i]!, { moveFocus: true });
        return "focused";
      }
    }

    // §3.4 cap: navigate inside the initiator (or the active window for conversation
    // clicks) and surface the limit notice there.
    if (windows.value.length >= PREVIEW_WINDOW_MAX) {
      const target = from ?? windowOf(activeId.value);
      if (target === null) return "ignored";
      target.handle.navigate(ref);
      armLimitNotice(from !== null ? from.id : activeId.value!);
      return "navigated";
    }

    // §4.3 step 6: a fresh window (speculative iff the route was unknown and it has an
    // origin — §3.3; a conversation click is never speculative because it has no origin
    // to fold back into).
    const id = nextWindowId++;
    const machine = createPreviewMachine({
      scope,
      preview: opts.preview,
      coarse: opts.coarse,
      ...(probeHandle !== undefined ? { probe: probeHandle } : {}),
      ...(opts.createFileReader !== undefined ? { createFileReader: opts.createFileReader } : {}),
      history: { budget: history, winId: id },
      onSessionChanged,
    });
    const meta: WindowMeta = {
      id,
      handle: machine,
      originId: from !== null ? from.id : null,
      pendingFold: route === "unknown" && from !== null,
      originEpoch: from !== null ? from.handle.navEpoch.value : 0,
      noticeEpoch: null,
      stopWatchers: [],
    };
    metas.set(id, meta);
    windows.value = [...windows.value, { id, handle: machine }];
    order.value = [...order.value, id];

    // §3.4 rule ①: this window's own navigate/back (navEpoch bump) clears its notice —
    // guarded by the epoch captured at arm time so the notice-setting navigate itself
    // (which bumps navEpoch BEFORE the arm) never clears what it just armed.
    meta.stopWatchers.push(
      watch(machine.navEpoch, () => {
        if (
          limitNotice.value !== null &&
          limitNotice.value.id === id &&
          meta.noticeEpoch !== null &&
          machine.navEpoch.value !== meta.noticeEpoch
        ) {
          limitNotice.value = null;
        }
      }),
    );

    // §3.3: watch the first settle (phase leaving loading/closed) of a speculative window.
    if (meta.pendingFold) {
      meta.stopWatchers.push(
        watch(
          () => machine.view.value.phase,
          (phase) => {
            if (!meta.pendingFold || phase === "loading" || phase === "closed") return;
            meta.pendingFold = false;
            if (phase !== "dir") return; // a file/error stays a normal window
            const v = machine.view.value;
            if (v.phase !== "dir" || machine.stackDepth.value !== 0) return;
            const origin = windowOf(meta.originId);
            if (origin === null || origin.handle.navEpoch.value !== meta.originEpoch) return; // paged away / gone
            origin.handle.adopt(v as PreviewDirPhase); // pushes origin's view; zero requests
            closeWindow(id); // this close never triggers the regular focus-return (host-side)
            focusWindow(meta.originId!, { moveFocus: true });
          },
        ),
      );
    }

    machine.open(ref);
    focusRequest.value = { id, seq: ++focusSeq };
    return "opened";
  }

  // §4.3: the root handle — the frozen `PreviewHandle` face plus the windows face, bridged
  // by ONE cast (same discipline as `usePreview`). Deliberately no navigate/back/up:
  // `asDirHandle(root) === null` — the host must use `asWindowsHandle`.
  const rootView = computed<PreviewView>(() => {
    const a = activeId.value;
    const m = a === null ? undefined : metas.get(a);
    return m === undefined ? { phase: "closed" } : (m.handle.view.value as PreviewView);
  });

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    stopScopeWatch();
    closeAll();
  }
  onScopeDispose(dispose, true); // failSilently: node unit tests run outside a component scope

  const root: PreviewWindowsHandle = {
    view: rootView,
    scope,
    open: (ref: PreviewNavRef) => openWindow(ref, null),
    close: closeAll,
    retry: () => {
      const a = activeId.value;
      if (a !== null) metas.get(a)?.handle.retry();
    },
    dispose,
    ...(probeHandle !== undefined ? { probe: probeHandle } : {}),
    windows,
    order,
    activeId,
    focusRequest,
    limitNotice,
    openWindow,
    closeWindow,
    focusWindow,
    closeAll,
  };
  return root as unknown as PreviewHandle;
}
