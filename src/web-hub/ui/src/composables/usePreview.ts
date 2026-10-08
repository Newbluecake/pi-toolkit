/**
 * web-hub-preview plan v3 §3.2 (package PV4; dir-plan v3.1 §0.2 A3/§5 P3): the App-level
 * preview state machine, extended with in-dialog DIRECTORY navigation.
 *
 * `closed ⇄ loading → image | text | dir | unsupported | tooLarge | error`, with the three
 * interrupt rules from the plan all folding into one seq guard + one AbortController:
 *
 * - a NEW `open()` supersedes the in-flight one (abort + drop by seq) and CLEARS the
 *   navigation history stack (A3: open 是对话框的入口);
 * - `close()` does the same and returns to `closed`;
 * - **作用域失效**: a watcher on `scopeKeyOf(scope)` (v3-2: `agentKey|sessionId|cwd` — a cwd
 *   change is treated exactly like a session switch) closes immediately, aborting the fetch
 *   and clearing the stack.
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
 * - `back()` pops (a no-op at the bottom) and restores the snapshot view;
 * - `up()` navigates to `parentPreviewPath(current)` (a no-op at one-segment paths — `/` is
 *   not listable, A3's greyed-「上级」 semantics); it is only surfaced by the dir phase's UI;
 * - a click from inside the open dialog (PreviewHost's subtree `provide` override: `open` →
 *   `navigate`) drills down instead of restarting, so md path refs (B6) and dir rows share
 *   the same stack;
 * - dir-ness of a requested path is resolved WITHOUT extra round trips: the probe pipeline
 *   already confirmed the click candidate, so `probe.kindOf(path) === "dir"` sets the
 *   `dir=1` opt-in directly. The no-probe fallback (a legacy transport without `probe`, or a
 *   stale kind) is a single 415 `not-regular` retry: the hub answers a directory fetched
 *   without `dir` with exactly that (§1.4), and a re-fetch with `dir:true` upgrades the
 *   click to a listing. A real non-regular file answers 415 both times and the error phase
 *   surfaces as before (one wasted round trip, never a wrong view).
 */
import { computed, onScopeDispose, ref, watch, type Ref } from "vue";
import {
  classifyPreviewError,
  clientImageBudget,
  parentPreviewPath,
  previewScopeOf,
  scopeKeyOf,
} from "@logic/preview.js";
import { usePreviewProbe, type PreviewProbeHandle } from "./usePreviewProbe.js";
import type { PreviewDirListing } from "@protocol/preview.js";
import type { PreviewDirOutcome, PreviewTransport } from "../transport/types.js";
import type { HubState, PreviewHandle, PreviewPathScope, PreviewView } from "../types.js";

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
  /** A3: history stack depth (drives the 返回 button's disabled state). Reactive. */
  readonly stackDepth: Readonly<Ref<number>>;
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

export function usePreview(opts: UsePreviewOptions): PreviewHandle {
  const view = ref<PreviewViewDir>({ phase: "closed" }) as Ref<PreviewViewDir>;

  const scope = computed<PreviewPathScope | null>(() => {
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

  let seq = 0;
  let ctl: AbortController | null = null;
  let lastPath: string | null = null;
  let lastDir: true | undefined;

  /** A3 history stack: snapshots of content views (text/image/dir) + the element to refocus
   * on back() — null outside a DOM (node unit tests) or when the trigger is gone. */
  const stack: Array<{ readonly view: PreviewViewDir; readonly focus: Element | null }> = [];
  const stackDepth = ref(0);

  function abortInFlight(): void {
    seq++;
    if (ctl !== null) {
      ctl.abort();
      ctl = null;
    }
  }

  function clearStack(): void {
    stack.length = 0;
    stackDepth.value = 0;
  }

  function close(): void {
    abortInFlight();
    lastPath = null;
    lastDir = undefined;
    clearStack();
    if (view.value.phase !== "closed") view.value = { phase: "closed" };
  }

  // 作用域失效 (§3.2): the scope KEY (agentKey|sessionId|cwd) changing — session switch,
  // cwd drift (v3-2), agent deselected, caps lost on reconnect — closes instantly (and, per
  // A3, drops the whole navigation history with it: another session's paths are not ours).
  const stopWatch = watch(
    () => scopeKeyOf(scope.value),
    (next, prev) => {
      if (next !== prev) close();
    },
  );

  function settleError(outcome: Extract<PreviewDirOutcome, { ok: false }>, path: string): void {
    const c = classifyPreviewError(outcome.status, outcome);
    if (c.kind === "session-changed") {
      // §3.2: E_SESSION_CHANGED closes directly — the transcript itself is about to reload.
      close();
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

  // 2026-10-07 修订「先探测后标记」: the batch probe controller rides the SAME handle iff the
  // transport implements `probe` — otherwise `handle.probe` stays absent and `PathText` keeps
  // the legacy always-clickable rendering (component-level fakes never break). dir-plan P3
  // additionally consults its `kindOf` for the `dir=1` opt-in (see `isDirHint`).
  const probeHandle: PreviewProbeHandle | undefined =
    opts.preview !== undefined && opts.preview.probe !== undefined
      ? usePreviewProbe({ probe: opts.preview.probe, scope })
      : undefined;

  function isDirHint(path: string): boolean {
    return probeHandle?.kindOf !== undefined && probeHandle.kindOf(path) === "dir";
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
        opts.preview !== undefined
      ) {
        void opts.preview
          .fetch(
            { agentKey: ctx.sc.agentKey, sessionId: ctx.sc.sessionId, path, dir: true },
            { signal: ctx.ac.signal, maxPixels: ctx.maxPixels },
          )
          .then((second) => settleOutcome(second, path, ctx, true));
        return;
      }
      settleError(outcome, path);
      return;
    }
    switch (outcome.kind) {
      case "text":
        view.value = {
          phase: "text",
          path,
          text: outcome.text,
          truncated: outcome.truncated,
          size: outcome.size,
        };
        return;
      case "dir":
        view.value = { phase: "dir", path, listing: outcome.listing };
        return;
      case "image": {
        const mime = outcome.mime;
        void readDataUrl(opts.createFileReader ?? defaultFileReader, outcome.blob).then(
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
    const transport = opts.preview;
    if (sc === null || transport === undefined) return; // no scope ⇒ nothing is clickable
    abortInFlight();
    const mySeq = seq;
    const ac = new AbortController();
    ctl = ac;
    lastPath = path;
    lastDir = dir;
    view.value = { phase: "loading", path };
    const maxPixels = clientImageBudget({ coarse: opts.coarse.value });
    const wantDir = dir === true || isDirHint(path);
    void transport
      .fetch(
        {
          agentKey: sc.agentKey,
          sessionId: sc.sessionId,
          path,
          ...(wantDir ? { dir: true } : {}),
        },
        { signal: ac.signal, maxPixels },
      )
      .then((outcome) => {
        settleOutcome(outcome, path, { sc, mySeq, ac, maxPixels }, wantDir);
      });
  }

  function open(ref: PreviewNavRef): void {
    clearStack(); // A3: a fresh open is a fresh visit — the history stack restarts empty
    load(ref.path, ref.dir);
  }

  function captureFocus(): Element | null {
    return typeof document === "undefined" ? null : document.activeElement;
  }

  function refocus(el: Element | null): void {
    if (el === null || typeof document === "undefined" || !document.contains(el)) return;
    (el as HTMLElement).focus();
  }

  function navigate(ref: PreviewNavRef): void {
    if (scope.value === null || opts.preview === undefined) return; // no scope ⇒ nothing clickable
    const cur = view.value;
    if (cur.phase === "text" || cur.phase === "image" || cur.phase === "dir") {
      if (stack.length >= PREVIEW_NAV_STACK_MAX) stack.shift(); // FIFO: oldest falls out
      stack.push({ view: cur, focus: captureFocus() });
      stackDepth.value = stack.length;
    }
    // transient phases (loading/error/…) have nothing to return to — a navigate from there
    // (defensive: their bodies render no clickable refs) just loads.
    load(ref.path, ref.dir);
  }

  function back(): void {
    if (stack.length === 0) return;
    abortInFlight();
    const entry = stack.pop()!;
    stackDepth.value = stack.length;
    const v = entry.view;
    view.value = v;
    if ("path" in v) {
      lastPath = v.path;
      lastDir = v.phase === "dir" ? true : undefined;
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

  function retry(): void {
    if (view.value.phase !== "error" || lastPath === null) return;
    load(lastPath, lastDir); // same path, same dir-ness — the history stack is untouched
  }

  let disposed = false;
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    stopWatch();
    clearStack();
    abortInFlight();
  }
  onScopeDispose(dispose, true); // failSilently: safe to call outside a component/effect scope (unit tests)

  const dirHandle: PreviewHandleDir = {
    view: view as Readonly<Ref<PreviewViewDir>>,
    scope,
    open,
    close,
    retry,
    dispose,
    ...(probeHandle !== undefined ? { probe: probeHandle } : {}),
    navigate,
    back,
    up,
    stackDepth,
  };

  // The frozen-face bridge: everything except `view` is structurally identical (and
  // `open`/`navigate`'s wider param stays contravariance-safe); `view` is narrowed by this
  // one cast — sound because this closure is the ref's only writer and `PreviewHost` recovers
  // the widened face via `asDirHandle` before reading a `dir` phase.
  return dirHandle as unknown as PreviewHandle;
}
