/**
 * web-hub-preview plan v3 §3.2 (package PV4; dir-plan v3.1 §0.2 A3/§5 P3): the App-level
 * preview state machine, extended with in-dialog DIRECTORY navigation.
 *
 * web-hub-preview-windows plan r2 §4.2 (W1): the machine is now split out as
 * `createPreviewMachine(deps)` — a DOM-free, watcher-free state machine one per preview
 * WINDOW — while `usePreview(opts)` stays as the single-window wrapper it always was (scope
 * computed + shared probe + the scope watcher + the frozen-face bridge cast). The machine's
 * observable single-window behavior is byte-identical to the pre-split composable (R10:
 * `use-preview.test.ts`'s original cases run unchanged); the multi-window deltas are strictly
 * additive and only activate through their deps:
 *
 * - `deps.onSessionChanged(scopeKey)` replaces the three hard-wired `close()` calls
 *   (settleError's session-changed branch, the continuation stream's `d.close`, and — new,
 *   §4.4/评审 #6 — the tree fetch's E_SESSION_CHANGED) so the WINDOW MANAGER can decide
 *   (only a key matching the CURRENT scope closes everything; a late error from an old
 *   scope/visit never does);
 * - `navEpoch` (bumped by load/back/adopt) lets the manager detect "the origin window paged
 *   away" for speculative fold-back (§3.3);
 * - `deps.history` (the §4.5 global byte budget) turns pushed snapshots into evictable
 *   ledger entries — `back()` over a demoted "stub" entry refetches instead of restoring;
 * - `adopt(view)` splices another window's already-fetched dir listing into THIS window
 *   (push current view, set view, no request — §3.3's fold-back target half);
 * - `dispose()` cleans only its own state (no watcher ownership — the wrapper/manager owns
 *   those) and latches `disposed` so late tree callbacks go silent.
 *
 * `closed ⇄ loading → image | text | dir | unsupported | tooLarge | error`, with the three
 * interrupt rules from the plan all folding into one seq guard + one AbortController:
 *
 * - a NEW `open()` supersedes the in-flight one (abort + drop by seq) and CLEARS the
 *   navigation history stack (A3: open 是对话框的入口);
 * - `close()` does the same and returns to `closed`;
 * - **作用域失效**: a watcher on `scopeKeyOf(scope)` (v3-2: `agentKey|sessionId|cwd` — a cwd
 *   change is treated exactly like a session switch) closes immediately, aborting the fetch
 *   and clearing the stack (the wrapper/manager registers that watcher — the machine itself
 *   owns none).
 *
 * `scope` itself is the §4.6 derivation (`previewScopeOf`): transport has `preview` ∧ hub caps
 * carry `preview.v1` (token) / `preview.lan.v1` (password — under the default mode "on" both
 * caps are declared, so LAN gets a scope, U1) ∧ the selected agent has a live session.
 * dir-plan §2.5.1: the scope additionally carries `abs`/`dirs` when the hub declares the
 * caps — `dirs` is what unlocks everything below.
 *
 * The image phase never sees a `blob:` URL (D1: CSP is not relaxed — `createObjectURL` is
 * source-scan banned): the transport's `Blob` converts through FileReader's `readAsDataURL`
 * and the `data:<mime>;base64,` prefix is verified before the phase flips (§3.2 image row).
 * The 40s client timeout lives in the TRANSPORT (`PREVIEW_CLIENT_TIMEOUT_MS`, spanning
 * headers+body, surfaced as a retryable `E_DEADLINE`) — this layer's controller exists for
 * open/close/scope interrupts, so there is exactly one deadline source on both adapters.
 *
 * dir-plan §5 P3 — in-dialog navigation (A3):
 * - `open()` clears the history stack, then loads (a transcript click starts a fresh visit);
 * - `navigate({path, dir?})` PUSHES the current content view (text/image/dir — the only
 *   phases with something to return to) onto a snapshot stack capped at
 *   `PREVIEW_NAV_STACK_MAX` (64, FIFO: the oldest entry falls out), then loads. Snapshots
 *   are restored verbatim by `back()` — no refetch, byte-stable, instantly;
 * - `back()` pops (a no-op at the bottom) and restores the snapshot view — unless the entry
 *   was demoted to a stub by the history budget, in which case it RELOADS `{path, dir}`
 *   (§4.5: the stub carries exactly the identity needed to refetch);
 * - `up()` navigates to `parentPreviewPath(current)` (a no-op at one-segment paths — `/` is
 *   not listable, A3's greyed-「上级」 semantics); it is only surfaced by the dir phase's UI;
 * - a click from inside the open dialog (the subtree `provide` override: `open` →
 *   `navigate`/`openWindow`) drills down instead of restarting, so md path refs (B6) and dir
 *   rows share the same stack;
 * - dir-ness of a requested path is resolved WITHOUT extra round trips: the probe pipeline
 *   already confirmed the click candidate, so `probe.kindOf(path) === "dir"` sets the
 *   `dir=1` opt-in directly. The no-probe fallback (a legacy transport without `probe`, or a
 *   stale kind) is a single 415 `not-regular` retry: the hub answers a directory fetched
 *   without `dir` with exactly that (§1.4), and a re-fetch with `dir:true` upgrades the
 *   click to a listing. A real non-regular file answers 415 both times and the error phase
 *   surfaces as before (one wasted round trip, never a wrong view).
 */
import { computed, onScopeDispose, ref, shallowReactive, watch, type Ref } from "vue";
import {
  classifyPreviewError,
  clientImageBudget,
  clientTextStreamCap,
  parentPreviewPath,
  previewScopeOf,
  scopeKeyOf,
} from "@logic/preview.js";
import { estimateSnapshotBytes, type PreviewHistoryBudget } from "@logic/previewHistoryBudget.js";
import { usePreviewProbe, type PreviewProbeHandle } from "./usePreviewProbe.js";
import { createPreviewTree, type PreviewTreeStore } from "./usePreviewTree.js";
import { classifyChunkOutcome, nextChunkAction } from "@logic/previewStream.js";
import type { PreviewDirListing } from "@protocol/preview.js";
import type { PreviewDirOutcome, PreviewTransport } from "../transport/types.js";
import type { HubState, PreviewHandle, PreviewPathScope, PreviewTextStream, PreviewView } from "../types.js";

/** The structural slice of the DOM `FileReader` this composable needs (injectable for tests —
 * node has no `FileReader`; the real wiring (PV6, App.vue) simply doesn't pass
 * `createFileReader` and the default below reaches the browser global). Listeners go through
 * `addEventListener`, never the `onload`/`onerror` properties — source-scan bans `.on*=`
 * assignments across the whole UI. */
export interface FileReaderLike {
  readonly result: unknown;
  addEventListener(type: "load" | "error", listener: () => void): void;
  readAsDataURL(blob: Blob): void;
}

export interface UsePreviewOptions {
  /** `HubHandle.preview` — `undefined` ⇒ the scope is always `null` (nothing clickable). */
  readonly preview: PreviewTransport | undefined;
  /** Transport auth mode — the scope cap rule differs (password requires `preview.lan.v1`). */
  readonly mode: "token" | "password";
  /** The hub handle's render-gated state (caps + selected agent's session feed the scope). */
  readonly state: Readonly<Ref<HubState>>;
  /** `(pointer: coarse)` — touch devices preview against the 20MP budget (plan §0/P2-13). */
  readonly coarse: Readonly<Ref<boolean>>;
  readonly createFileReader?: () => FileReaderLike;
  /** preview-windows §4.5: override the global history budget's maxBytes. Used ONLY by
   * `usePreviewWindows` (the single-window wrapper ignores it); the default is
   * `historyBudgetFor(coarse)` (96 MiB desktop / 32 MiB touch). Injectable so the node suite
   * can drive eviction without allocating ~32 MiB of strings — same discipline as
   * `createFileReader`. */
  readonly historyBudgetBytes?: number;
}

/** A3: the in-dialog history stack cap — 返回 walks at most this many snapshots back. */
export const PREVIEW_NAV_STACK_MAX = 64;

/** dir-plan §5 P3: the `dir` phase — a `kind:"dir"` fetch's parsed `PreviewDirListing`
 * (protocol-frozen shape). Lives HERE (not in the frozen `types.ts` union) so the P3 file
 * domain keeps every pre-P3 fake/outcome literal type-valid; `PreviewViewDir` below is what
 * this composable actually stores and what `PreviewHost` renders. */
export interface PreviewDirPhase {
  readonly phase: "dir";
  readonly path: string;
  readonly listing: PreviewDirListing;
}

/** `PreviewView` plus the P3 `dir` phase (additive — every existing phase is unchanged). */
export type PreviewViewDir = PreviewView | PreviewDirPhase;

/**
 * The navigation ref `open`/`navigate` accept: `dir` forces the `dir=1` listing request (a
 * dir-row click knows its target is a directory; a prose ref click relies on the probe kind
 * / the 415 fallback instead). Wider than the frozen `PreviewHandle`'s `{path}` — a function
 * accepting this superset stays assignable to the frozen face.
 */
export interface PreviewNavRef {
  readonly path: string;
  readonly dir?: true;
}

/**
 * preview-windows §4.5: a history entry demoted by the global byte budget. `back()` over a
 * stub REFETCHES `{path, dir}` instead of restoring a snapshot (the memory is gone; the
 * identity is not). Only ever appears inside the machine's private stack.
 */
export interface PreviewNavStub {
  readonly stub: { readonly path: string; readonly dir?: true };
}

/** dir-plan §5 P3: the handle `usePreview` actually builds. Structurally the frozen
 * `PreviewHandle` (same members, plus the navigation trio + `stackDepth`) with `view`
 * widened to `PreviewViewDir` and `navigate`/`back`/`up` required. It deliberately does NOT
 * `extends PreviewHandle`: the widened `view` would be an illegal member override
 * (`Ref<PreviewViewDir>` is not assignable to `Readonly<Ref<PreviewView>>`), which is exactly
 * why `usePreview`'s declared return stays the frozen face and the widening is bridged by
 * ONE cast at the return boundary (sound: this composable is the only writer of the ref, and
 * a reader of the frozen face never pattern-matches a phase it cannot produce on its own). */
export interface PreviewHandleDir {
  readonly view: Readonly<Ref<PreviewViewDir>>;
  /** The §4.6 scope derivation (`null` ⇒ no path is clickable). */
  readonly scope: Readonly<Ref<PreviewPathScope | null>>;
  /** closed/any ⇒ loading (a no-op without a scope); aborts whatever was in flight; 清栈. */
  open(ref: PreviewNavRef): void;
  /** Any ⇒ closed; aborts the in-flight fetch (§3.2 作用域失效 uses the same path); 清栈. */
  close(): void;
  /** error(retryable) ⇒ re-load the same path WITHOUT touching the stack; no-op elsewhere. */
  retry(): void;
  dispose(): void;
  /** The batch probe controller — present iff the transport implements `probe`. */
  readonly probe?: PreviewProbeHandle;
  /** A3: descend (history push) — the dialog-internal click path. */
  navigate(ref: PreviewNavRef): void;
  /** A3: pop the history stack (a no-op at its bottom). */
  back(): void;
  /** A3: navigate to `parentPreviewPath(view.path)` (a no-op at one-segment paths). */
  up(): void;
  /** chunked-plan §4.2: idempotent "the next segment is needed" signal (single-flight,
   * ≥300 ms spaced, coalesced; from a retryable `error` it is the manual 重试). */
  loadMore(): void;
  /** chunked-plan §4.2: reload the current path WITHOUT touching the navigation stack
   * (the `changed` state's 重新打开). */
  reopen(): void;
  /** A3: history stack depth (drives the 返回 button's disabled state). Reactive. */
  readonly stackDepth: Readonly<Ref<number>>;
  /**
   * preview-tree (2026-10): the in-dialog inline-expansion store — per-visit like the
   * history stack (cleared by the same `open()`/`close()` call sites, kept across
   * `navigate()`/`back()` so drill-down never loses expansions). Always present on the
   * real handle; `PreviewDir` degrades to no-chevrons when a fake omits it.
   */
  readonly tree: PreviewTreeStore;
}

/**
 * preview-windows §4.2 (W1): the per-window machine handle — the P3 dir handle plus the two
 * multi-window members. `navEpoch` bumps on every view-identity change (load/back/adopt);
 * the window manager compares it against the epoch captured at speculative-open time (§3.3).
 * `adopt` is §3.3's fold-back landing: push the current view, splice in the OTHER window's
 * already-settled dir listing, zero requests.
 */
export type PreviewMachine = PreviewHandleDir & {
  readonly navEpoch: Readonly<Ref<number>>;
  adopt(v: PreviewDirPhase): void;
};

/** The global §4.5 budget plus this machine's window id (tokens are per-machine counters). */
export interface PreviewHistoryPort {
  readonly budget: PreviewHistoryBudget;
  readonly winId: number;
}

/** The content phases A3/§4.5 can snapshot (the only views with something to return to). */
export type PreviewNavSnapshotView = Extract<PreviewViewDir, { phase: "text" | "image" | "dir" }>;

/** preview-windows §4.1/§4.2 (W1): everything one machine needs — the scope/transport/
 * coarse-pointer trio, the SHARED probe handle (created once by the wrapper/manager, never
 * per window), the optional FileReader factory, the optional history budget, and the
 * session-change port (§4.4). */
export interface PreviewMachineDeps {
  readonly scope: Readonly<Ref<PreviewPathScope | null>>;
  readonly preview: PreviewTransport | undefined;
  readonly coarse: Readonly<Ref<boolean>>;
  readonly probe?: PreviewProbeHandle;
  readonly createFileReader?: () => FileReaderLike;
  readonly history?: PreviewHistoryPort;
  /**
   * §4.4: a fetch answered E_SESSION_CHANGED under `scopeKey`. The single-window wrapper
   * closes; the window manager closes everything iff the key matches the CURRENT scope.
   */
  readonly onSessionChanged: (scopeKey: string) => void;
}

/**
 * Recover the P3 navigation face from an injected `PreviewHandle` (duck-typed — a pre-P3
 * handle or a frozen component fake omits `navigate`/`back`/`up` and gets `null`: the host
 * then degrades to open-only navigation, per the frozen-types convention).
 */
export function asDirHandle(h: PreviewHandle): PreviewHandleDir | null {
  const d = h as Partial<PreviewHandleDir>;
  return typeof d.navigate === "function" &&
    typeof d.back === "function" &&
    typeof d.up === "function" &&
    d.stackDepth !== undefined
    ? (h as PreviewHandleDir)
    : null;
}

function defaultFileReader(): FileReaderLike {
  return new FileReader() as unknown as FileReaderLike;
}

function readDataUrl(create: () => FileReaderLike, blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = create();
    fr.addEventListener("load", () =>
      typeof fr.result === "string" ? resolve(fr.result) : reject(new Error("E_BAD_DATA_URL")),
    );
    fr.addEventListener("error", () => reject(new Error("E_READ")));
    fr.readAsDataURL(blob);
  });
}

/**
 * md-preview-html plan: the same Blob → `data:<mime>;base64,` conversion the image phase uses,
 * exported for the markdown inline-image fetcher (`useMdImageLoader.ts`) so both paths share
 * the one FileReader discipline (D1/HP8 — never `createObjectURL`). The caller still verifies
 * the `data:` prefix itself.
 */
export function readPreviewDataUrl(blob: Blob, create: () => FileReaderLike = defaultFileReader): Promise<string> {
  return readDataUrl(create, blob);
}

/**
 * The §4.6 scope derivation as one shared computed — `usePreview` and `usePreviewWindows`
 * (§4.1: "scope 全局一份") both build it through here so the two can never drift.
 */
export function previewScopeRef(opts: UsePreviewOptions): Readonly<Ref<PreviewPathScope | null>> {
  return computed<PreviewPathScope | null>(() => {
    const st = opts.state.value;
    const hub = st.hub;
    const selected = st.selected;
    const agent = selected === null ? undefined : st.agents.get(selected);
    const session =
      agent?.session ?? (agent?.card !== undefined ? (agent.card as { session?: unknown }).session : undefined);
    return previewScopeOf({
      mode: opts.mode,
      hubCaps: hub !== null && typeof hub === "object" ? (hub as { caps?: unknown }).caps : undefined,
      hasTransport: opts.preview !== undefined,
      agentKey: selected,
      session,
    });
  });
}

/**
 * preview-windows §4.2 (W1): the per-window state machine. The closure body is the pre-split
 * `usePreview` moved verbatim; the deltas are exactly the ones listed in the file header
 * (onSessionChanged routing, tree session-change guard, navEpoch, history budget + stubs,
 * adopt, watcher-free dispose). Caller owns disposal — call `dispose()` when the window goes.
 */
export function createPreviewMachine(deps: PreviewMachineDeps): PreviewMachine {
  const view = ref<PreviewViewDir>({ phase: "closed" }) as Ref<PreviewViewDir>;
  const scope = deps.scope;

  let seq = 0;
  let ctl: AbortController | null = null;
  let lastPath: string | null = null;
  let lastDir: true | undefined;

  /** A3 history stack: snapshots of content views (text/image/dir — plus §4.5 stub entries)
   * + the element to refocus on back() — null outside a DOM (node unit tests) or when the
   * trigger is gone. `view` is MUTABLE so the budget's stub callback can demote in place. */
  const stack: Array<{
    view: PreviewViewDir | PreviewNavStub;
    focus: Element | null;
    token: number | null;
  }> = [];
  const stackDepth = ref(0);
  let tokenSeq = 0;

  // preview-windows §3.3: the view-identity epoch — load/back/adopt bump it; the manager
  // captures it when speculatively opening a window and folds back only if it still matches.
  const navEpoch = ref(0);

  // preview-windows §4.4/评审 #6: the tree's visit epoch — clearVisit() bumps it so a late
  // tree E_SESSION_CHANGED from an already-abandoned visit can never reach onSessionChanged.
  let visitEpoch = 0;

  // chunked-plan §4.2: the continuation stream's own cancellation domain (a SEPARATE
  // controller/seq from the main load, so a late continuation can never write into a view it
  // no longer belongs to) + the coalescing / Retry-After timer.
  let streamSeq = 0;
  let streamCtl: AbortController | null = null;
  let streamTimer: ReturnType<typeof setTimeout> | null = null;
  let streamLastEndedAt = Number.NEGATIVE_INFINITY;
  let streamCtx: { readonly sc: PreviewPathScope; readonly path: string } | null = null;

  /** Cancel whatever the stream has in flight; a loading/waiting stream returns to `more`
   * (cancellation is never an error — §4.2 取消 row). */
  function abortStream(): void {
    streamSeq++;
    if (streamCtl !== null) {
      streamCtl.abort();
      streamCtl = null;
    }
    if (streamTimer !== null) {
      clearTimeout(streamTimer);
      streamTimer = null;
    }
    const v = view.value;
    if (
      v.phase === "text" &&
      v.stream !== undefined &&
      (v.stream.state === "loading" || v.stream.state === "waiting")
    ) {
      v.stream.state = "more";
    }
  }

  function abortInFlight(): void {
    seq++;
    if (ctl !== null) {
      ctl.abort();
      ctl = null;
    }
    abortStream();
  }

  // preview-tree: the inline-expansion store. Its fetchDir rides the SAME scope + transport
  // as open/navigate (an expansion is just a `dir:true` listing fetch that does NOT touch
  // the view/seq state machine); every in-flight expansion fetch has its own controller,
  // aborted by tree.clear(). A dir:true fetch that comes back non-dir (the path raced into
  // a regular file server-side) maps to the same E_PREVIEW_UNSUPPORTED code the error phase
  // would have shown — never a wrong tree.
  //
  // preview-windows §4.4 (评审 #6): an E_SESSION_CHANGED expansion answer is routed through
  // deps.onSessionChanged — but ONLY when the answer still belongs to THIS visit (visitEpoch
  // unchanged), the machine is alive, and the CURRENT scope still is the scope the request
  // left under. Every other late/stale answer keeps the legacy `{ok:false,error}` return
  // (the tree row shows its own error state; nothing else moves).
  const tree = createPreviewTree(async (path, signal) => {
    const sc = scope.value;
    const transport = deps.preview;
    if (sc === null || transport === undefined) return { ok: false, error: "E_NO_SCOPE" };
    const ve = visitEpoch;
    try {
      const out = await transport.fetch(
        { agentKey: sc.agentKey, sessionId: sc.sessionId, path, dir: true },
        { signal, maxPixels: clientImageBudget({ coarse: deps.coarse.value }) },
      );
      if (
        !out.ok &&
        out.error === "E_SESSION_CHANGED" &&
        !disposed &&
        ve === visitEpoch &&
        scopeKeyOf(scope.value) === scopeKeyOf(sc)
      ) {
        deps.onSessionChanged(scopeKeyOf(sc));
      }
      if (!out.ok) return { ok: false, error: out.error };
      if (out.kind !== "dir") return { ok: false, error: "E_PREVIEW_UNSUPPORTED" };
      return { ok: true, listing: out.listing };
    } catch {
      return { ok: false, error: "E_NETWORK" };
    }
  });

  function clearStack(): void {
    stack.length = 0;
    stackDepth.value = 0;
    if (deps.history !== undefined) deps.history.budget.dropWindow(deps.history.winId);
  }

  function clearVisit(): void {
    // visit-scoped state goes together: history stack AND the inline-expansion tree
    // (弹窗关闭即弃; a fresh open is a fresh visit). §4.4: the epoch bump also silences any
    // in-flight tree fetch's session-change routing (see the tree fetch above).
    visitEpoch++;
    clearStack();
    tree.clear();
  }

  function close(): void {
    abortInFlight();
    lastPath = null;
    lastDir = undefined;
    clearVisit();
    if (view.value.phase !== "closed") view.value = { phase: "closed" };
  }

  function settleError(outcome: Extract<PreviewDirOutcome, { ok: false }>, path: string, sc: PreviewPathScope): void {
    const c = classifyPreviewError(outcome.status, outcome);
    if (c.kind === "session-changed") {
      // §3.2 / preview-windows §4.2: E_SESSION_CHANGED routes through the port — the wrapper
      // closes, the manager closes everything iff the key still matches the current scope.
      deps.onSessionChanged(scopeKeyOf(sc));
      return;
    }
    if (c.kind === "unsupported") {
      view.value = {
        phase: "unsupported",
        path,
        ...(c.reason !== undefined ? { reason: c.reason } : {}),
        ...(c.size !== undefined ? { size: c.size } : {}),
      };
      return;
    }
    if (c.kind === "tooLarge") {
      view.value = {
        phase: "tooLarge",
        path,
        ...(c.reason !== undefined ? { reason: c.reason } : {}),
        ...(c.size !== undefined ? { size: c.size } : {}),
        ...(c.max !== undefined ? { max: c.max } : {}),
        ...(c.dims !== undefined ? { dims: c.dims } : {}),
      };
      return;
    }
    view.value = {
      phase: "error",
      path,
      error: c.error,
      retryable: c.retryable,
      ...(c.retryAfterS !== undefined ? { retryAfterS: c.retryAfterS } : {}),
    };
  }

  function isDirHint(path: string): boolean {
    return deps.probe?.kindOf !== undefined && deps.probe.kindOf(path) === "dir";
  }

  /** §4.2 建流条件: scope carries `chunks`, the first chunk is truncated and echoed
   * offset/ident (`outcome.chunk`), and its byte length is known. Anything else ⇒ legacy
   * one-shot truncated display (no stream). */
  function buildStream(
    outcome: Extract<PreviewDirOutcome, { ok: true; kind: "text" }>,
    sc: PreviewPathScope,
    path: string,
  ): PreviewTextStream | undefined {
    if (sc.chunks !== true || outcome.truncated !== true) return undefined;
    if (outcome.chunk === undefined || outcome.bytes === undefined) return undefined;
    const cap = clientTextStreamCap({ coarse: deps.coarse.value });
    const s = shallowReactive<PreviewTextStream>({
      ident: outcome.chunk.ident,
      total: outcome.size,
      cap,
      firstBytes: outcome.bytes,
      chunks: [outcome.text],
      loaded: outcome.bytes,
      state: outcome.bytes >= cap ? "cap" : "more",
      autoRetries: 0,
    });
    streamCtx = { sc, path };
    streamLastEndedAt = Number.NEGATIVE_INFINITY;
    return s;
  }

  function currentStream(): PreviewTextStream | undefined {
    const v = view.value;
    return v.phase === "text" ? v.stream : undefined;
  }

  function streamFetch(s: PreviewTextStream): void {
    const transport = deps.preview;
    const c = streamCtx;
    if (transport === undefined || c === null) return;
    s.state = "loading";
    delete s.error;
    delete s.retryable;
    delete s.retryAt;
    const mySeq = ++streamSeq;
    const ac = new AbortController();
    streamCtl = ac;
    void transport
      .fetch(
        {
          agentKey: c.sc.agentKey,
          sessionId: c.sc.sessionId,
          path: c.path,
          chunk: { offset: s.loaded, ident: s.ident },
        },
        { signal: ac.signal, maxPixels: clientImageBudget({ coarse: deps.coarse.value }) },
      )
      .catch((): PreviewDirOutcome => ({ ok: false, status: 0, error: "E_NETWORK" }) as PreviewDirOutcome)
      .then((out) => {
        if (mySeq !== streamSeq || currentStream() !== s) return; // superseded — drop
        if (streamCtl === ac) streamCtl = null;
        streamLastEndedAt = Date.now();
        const d = classifyChunkOutcome(s, out) as {
          state?: PreviewTextStream["state"];
          append?: { text: string; bytes: number };
          loaded?: number;
          autoRetries?: number;
          retryAfterS?: number;
          error?: string;
          retryable?: boolean;
          close?: true;
          drop?: true;
        };
        if (d.drop === true) {
          s.state = "more";
          return;
        }
        if (d.close === true) {
          // §4.2 + preview-windows §4.2: the continuation saw E_SESSION_CHANGED — route
          // through the port under the scope THIS stream was built for (not necessarily
          // the current one; the manager compares).
          deps.onSessionChanged(scopeKeyOf(c.sc));
          return;
        }
        if (d.append !== undefined) {
          s.chunks = [...s.chunks, d.append.text];
          s.loaded = d.loaded ?? s.loaded;
        }
        if (d.autoRetries !== undefined) s.autoRetries = d.autoRetries;
        if (d.error !== undefined) s.error = d.error;
        if (d.retryable !== undefined) s.retryable = d.retryable;
        if (d.state === "waiting") {
          const waitMs = (d.retryAfterS ?? 1) * 1000;
          s.retryAt = Date.now() + waitMs;
          s.state = "waiting";
          streamTimer = setTimeout(() => {
            streamTimer = null;
            if (currentStream() === s && s.state === "waiting") streamFetch(s);
          }, waitMs);
          return;
        }
        s.state = d.state ?? "error";
      });
  }

  function pumpStream(s: PreviewTextStream): void {
    const act = nextChunkAction(s, Date.now(), streamLastEndedAt) as
      { type: "load"; resetRetries?: boolean } | { type: "schedule"; delayMs: number } | { type: "none" };
    if (act.type === "load") {
      if (act.resetRetries === true) s.autoRetries = 0;
      streamFetch(s);
    } else if (act.type === "schedule" && streamTimer === null) {
      streamTimer = setTimeout(() => {
        streamTimer = null;
        if (currentStream() === s) pumpStream(s);
      }, act.delayMs);
    }
  }

  function loadMore(): void {
    const s = currentStream();
    if (s !== undefined) pumpStream(s);
  }

  function reopen(): void {
    if (lastPath === null) return;
    load(lastPath, lastDir); // same path/dir-ness; the history stack is untouched
  }

  /** §4.2 入栈降级: a stack snapshot keeps only the first chunk (memory stays ≤ 64 × 256 KiB);
   * back() resumes from there — the ident guarantees consistency. */
  function demoteStream(v: PreviewViewDir): void {
    if (v.phase !== "text" || v.stream === undefined) return;
    abortStream();
    const s = v.stream;
    s.chunks = s.chunks.slice(0, 1);
    s.loaded = s.firstBytes;
    s.state = "more";
    s.autoRetries = 0;
    delete s.error;
    delete s.retryable;
    delete s.retryAt;
  }

  function captureFocus(): Element | null {
    return typeof document === "undefined" ? null : document.activeElement;
  }

  function refocus(el: Element | null): void {
    if (el === null || typeof document === "undefined" || !document.contains(el)) return;
    (el as HTMLElement).focus();
  }

  /** preview-windows §4.5: the budget's demote callback — swap a live snapshot for a stub
   * carrying exactly the identity `back()` needs to refetch. No-op for popped/shifted tokens. */
  function stubEntry(token: number): void {
    for (const e of stack) {
      if (e.token !== token) continue;
      const v = e.view;
      if ("stub" in v) return; // already demoted
      if (v.phase !== "text" && v.phase !== "image" && v.phase !== "dir") return; // never pushable
      e.view = { stub: { path: v.path, ...(v.phase === "dir" ? { dir: true } : {}) } };
      return;
    }
  }

  /** A3 + §4.5: push one snapshot (FIFO cap 64, bytes registered with the global budget iff
   * one is wired). Shared by navigate() and adopt(). Only CONTENT views are pushable. */
  function pushSnapshot(cur: PreviewNavSnapshotView): void {
    if (stack.length >= PREVIEW_NAV_STACK_MAX) {
      const shifted = stack.shift()!;
      if (shifted.token !== null && deps.history !== undefined) {
        deps.history.budget.remove(deps.history.winId, shifted.token);
      }
    }
    const token = deps.history !== undefined ? ++tokenSeq : null;
    stack.push({ view: cur, focus: captureFocus(), token });
    stackDepth.value = stack.length;
    if (deps.history !== undefined && token !== null) {
      deps.history.budget.add({
        winId: deps.history.winId,
        token,
        bytes: estimateSnapshotBytes(cur),
        stub: stubEntry,
      });
    }
  }

  /**
   * The single settle path for EVERY fetch outcome — exhaustive over the P3 union
   * (`PreviewDirOutcome`: text / image / dir) plus the two interrupt classes (seq drop and
   * the error taxonomy). `wantDir` gates the one-shot 415 `not-regular` re-fetch (the first
   * attempt's own opt-in state — never re-tried once it was already true).
   */
  function settleOutcome(
    outcome: PreviewDirOutcome,
    path: string,
    ctx: {
      readonly sc: PreviewPathScope;
      readonly mySeq: number;
      readonly ac: AbortController;
      readonly maxPixels: number;
    },
    wantDir: boolean,
  ): void {
    if (ctx.mySeq !== seq) return; // superseded / closed / scope invalidated — drop
    if (!outcome.ok) {
      // §1.4/P3: a directory fetched WITHOUT the opt-in answers 415 E_PREVIEW_UNSUPPORTED
      // not-regular; with the dirs capability one re-fetch with dir=1 upgrades the click to
      // a listing (a real non-regular file 415s again and the error phase surfaces).
      if (
        !wantDir &&
        ctx.sc.dirs === true &&
        outcome.error === "E_PREVIEW_UNSUPPORTED" &&
        outcome.reason === "not-regular" &&
        deps.preview !== undefined
      ) {
        void deps.preview
          .fetch(
            { agentKey: ctx.sc.agentKey, sessionId: ctx.sc.sessionId, path, dir: true },
            { signal: ctx.ac.signal, maxPixels: ctx.maxPixels },
          )
          .then((second) => settleOutcome(second, path, ctx, true));
        return;
      }
      settleError(outcome, path, ctx.sc);
      return;
    }
    switch (outcome.kind) {
      case "text": {
        const stream = buildStream(outcome, ctx.sc, path);
        view.value = {
          phase: "text",
          path,
          text: outcome.text,
          truncated: outcome.truncated,
          size: outcome.size,
          ...(outcome.bytes !== undefined ? { bytes: outcome.bytes } : {}),
          ...(stream !== undefined ? { stream } : {}),
        };
        return;
      }
      case "dir":
        view.value = { phase: "dir", path, listing: outcome.listing };
        return;
      case "image": {
        const mime = outcome.mime;
        void readDataUrl(deps.createFileReader ?? defaultFileReader, outcome.blob).then(
          (dataUrl) => {
            if (ctx.mySeq !== seq) return;
            if (!dataUrl.startsWith(`data:${mime};base64,`)) {
              view.value = { phase: "error", path, error: "E_BAD_DATA_URL", retryable: false };
              return;
            }
            view.value = {
              phase: "image",
              path,
              dataUrl,
              mime,
              dims: outcome.dims,
              size: outcome.size,
            };
          },
          () => {
            if (ctx.mySeq === seq) {
              view.value = { phase: "error", path, error: "E_READ", retryable: false };
            }
          },
        );
        return;
      }
    }
  }

  function load(path: string, dir?: true): void {
    const sc = scope.value;
    const transport = deps.preview;
    if (sc === null || transport === undefined) return; // no scope ⇒ nothing is clickable
    abortInFlight();
    navEpoch.value++; // §3.3: the view identity is about to change
    const mySeq = seq;
    const ac = new AbortController();
    ctl = ac;
    lastPath = path;
    lastDir = dir;
    view.value = { phase: "loading", path };
    const maxPixels = clientImageBudget({ coarse: deps.coarse.value });
    const wantDir = dir === true || isDirHint(path);
    void transport
      .fetch(
        {
          agentKey: sc.agentKey,
          sessionId: sc.sessionId,
          path,
          ...(wantDir ? { dir: true } : sc.chunks === true ? { chunk: true as const } : {}),
        },
        { signal: ac.signal, maxPixels },
      )
      .then((outcome) => {
        settleOutcome(outcome, path, { sc, mySeq, ac, maxPixels }, wantDir);
      });
  }

  function open(ref: PreviewNavRef): void {
    clearVisit(); // A3: a fresh open is a fresh visit — the history stack restarts empty
    load(ref.path, ref.dir);
  }

  function navigate(ref: PreviewNavRef): void {
    if (scope.value === null || deps.preview === undefined) return; // no scope ⇒ nothing is clickable
    const cur = view.value;
    if (cur.phase === "text" || cur.phase === "image" || cur.phase === "dir") {
      demoteStream(cur);
      pushSnapshot(cur); // A3 push (FIFO 64; §4.5 budget registration when wired)
    }
    // transient phases (loading/error/…) have nothing to return to — a navigate from there
    // (defensive: their bodies render no clickable refs) just loads.
    load(ref.path, ref.dir);
  }

  function back(): void {
    if (stack.length === 0) return;
    abortInFlight();
    navEpoch.value++; // §3.3: back changes the view identity too
    const entry = stack.pop()!;
    if (entry.token !== null && deps.history !== undefined) {
      deps.history.budget.remove(deps.history.winId, entry.token);
    }
    stackDepth.value = stack.length;
    const v = entry.view;
    if ("stub" in v) {
      // §4.5: the snapshot was demoted — refetch by identity instead of restoring memory.
      load(v.stub.path, v.stub.dir);
      refocus(entry.focus);
      return;
    }
    view.value = v;
    if ("path" in v) {
      lastPath = v.path;
      lastDir = v.phase === "dir" ? true : undefined;
    }
    if (v.phase === "text" && v.stream !== undefined && scope.value !== null) {
      // the demoted stream resumes under THIS view's context (the closure holds one at a time)
      streamCtx = { sc: scope.value, path: v.path };
      streamLastEndedAt = Number.NEGATIVE_INFINITY;
    }
    // A3/焦点: back() re-focuses the element that navigated away from the restored view when
    // it still exists; otherwise focus simply stays on the invoking control (never lost to
    // <body> — the dialog's trap keeps cycling).
    refocus(entry.focus);
  }

  function up(): void {
    const cur = view.value;
    const path = "path" in cur ? cur.path : null;
    if (path === null) return;
    const parent = parentPreviewPath(path);
    if (parent === null) return; // one-segment (or malformed): / is not listable — greyed
    navigate({ path: parent, dir: true });
  }

  /**
   * preview-windows §3.3 (W1): fold-back landing — splice ANOTHER window's already-settled
   * dir listing into this one. Pushes the current content view exactly like navigate() would
   * (so 返回 works), drops any in-flight fetch of THIS window (the adopted view must stick),
   * and bumps navEpoch. Zero requests.
   */
  function adopt(v: PreviewDirPhase): void {
    const cur = view.value;
    if (cur.phase === "text" || cur.phase === "image" || cur.phase === "dir") {
      demoteStream(cur);
      pushSnapshot(cur);
    }
    abortInFlight();
    navEpoch.value++;
    view.value = v;
    lastPath = v.path;
    lastDir = true;
  }

  function retry(): void {
    if (view.value.phase !== "error" || lastPath === null) return;
    load(lastPath, lastDir); // same path, same dir-ness — the history stack is untouched
  }

  let disposed = false;
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    // preview-windows §4.2: the machine owns NO watcher (the wrapper/manager registers the
    // scope watcher) — disposal only cleans its own in-flight work and visit state.
    clearVisit();
    abortInFlight();
  }

  const machine: PreviewMachine = {
    view: view as Readonly<Ref<PreviewViewDir>>,
    scope,
    open,
    close,
    retry,
    dispose,
    ...(deps.probe !== undefined ? { probe: deps.probe } : {}),
    navigate,
    back,
    up,
    loadMore,
    reopen,
    stackDepth,
    tree,
    navEpoch,
    adopt,
  };
  return machine;
}

export function usePreview(opts: UsePreviewOptions): PreviewHandle {
  // preview-windows §4.2: the single-window wrapper — the §4.6 scope, the shared probe and
  // the scope watcher live HERE; the machine below gets them as deps. The wiring keeps the
  // pre-split behavior byte-identical (R10): onSessionChanged closes, no history budget.
  const scope = previewScopeRef(opts);

  // 2026-10-07 修订「先探测后标记」: the batch probe controller rides the SAME handle iff the
  // transport implements `probe` — otherwise `handle.probe` stays absent and `PathText` keeps
  // the legacy always-clickable rendering (component-level fakes never break). dir-plan P3
  // additionally consults its `kindOf` for the `dir=1` opt-in (the machine's `isDirHint`).
  const probeHandle: PreviewProbeHandle | undefined =
    opts.preview !== undefined && opts.preview.probe !== undefined
      ? usePreviewProbe({ probe: opts.preview.probe, scope })
      : undefined;

  const m = createPreviewMachine({
    scope,
    preview: opts.preview,
    coarse: opts.coarse,
    ...(probeHandle !== undefined ? { probe: probeHandle } : {}),
    ...(opts.createFileReader !== undefined ? { createFileReader: opts.createFileReader } : {}),
    onSessionChanged: () => m.close(),
  });

  // 作用域失效 (§3.2): the scope KEY (agentKey|sessionId|cwd) changing — session switch,
  // cwd drift (v3-2), agent deselected, caps lost on reconnect — closes instantly (and, per
  // A3, drops the whole navigation history with it: another session's paths are not ours).
  const stopWatch = watch(
    () => scopeKeyOf(scope.value),
    (next, prev) => {
      if (next !== prev) m.close();
    },
  );

  let disposed = false;
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    stopWatch();
    m.dispose();
  }
  onScopeDispose(dispose, true); // failSilently: safe to call outside a component/effect scope (unit tests)

  const dirHandle: PreviewHandleDir & Pick<PreviewMachine, "navEpoch" | "adopt"> = {
    ...m,
    dispose,
  };

  // The frozen-face bridge: everything except `view` is structurally identical (and
  // `open`/`navigate`'s wider param stays contravariance-safe); `view` is narrowed by this
  // one cast — sound because this closure is the only writer of the ref and `PreviewHost`
  // recovers the widened face via `asDirHandle` before reading a `dir` phase.
  return dirHandle as unknown as PreviewHandle;
}
