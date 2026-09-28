/**
 * The one `HubHandle` implementation every component ultimately reads from (vue-plan.md v2.1
 * §3.3, §5.2 — P1 exclusive). Keeps the reducer's `raw` state in a plain (non-reactive) variable
 * — `reduce()` already returns a fresh object per change, so a `shallowRef` snapshot is enough
 * to drive Vue's own (microtask) patch scheduler; deep reactivity would be wasted work on a
 * possibly-large transcript. Side effects (subscribe/unsubscribe/resync rate limiting) run
 * synchronously off `raw` on every dispatch, ported byte-for-byte from the legacy `app.js`'s
 * `effects()` — this is the layer #25's "network requests still fire, DOM just doesn't" symptom
 * lived in, and it must stay independent of whatever the render gate (§3.5) decides to do.
 *
 * Unlike the legacy vanilla-DOM `wireFleetUi`, there is no "stop rendering while `conn===
 * "auth"`/after `close()`" bookkeeping here: which view is mounted (`LoginView` vs.
 * `DashboardView`) is a declarative function of `state.value.conn` at the `App.vue` level, so a
 * stale imperative `render()` call hitting removed DOM (the vanilla-JS failure mode that
 * bookkeeping guarded against) cannot happen — Vue's own component teardown handles it. The
 * `disposed` flag here only guards against a message/promise resolving after `dispose()`.
 */
import { shallowRef, type ShallowRef } from "vue";
import { initialState, needsSubscribe, reduce } from "@logic/state.js";
import type { RenderGateDocument, RenderGateWindow } from "./renderGate.js";
import { createRenderGate, type RenderPriority } from "./renderGate.js";
import type { HubTransport, TransportHooks } from "../transport/types.js";
import { createControl } from "./useControl.js";
import type { HubHandle, HubState } from "../types.js";

/** Whatever `@logic/state.js`'s JSDoc `initialState()`/`reduce()` actually traffic in — kept
 * distinct from the frozen, hand-authored `HubState` view so this file never has to fight TS
 * over `routed`/`wanted` (reducer-internal bookkeeping, §3.3, deliberately not surfaced on
 * `HubState`) or `conn`'s widened `string` vs. `ConnState`. */
type LogicState = ReturnType<typeof initialState>;
type DispatchMsg = { event: string; data?: unknown; id?: number };

export interface UseHubOptions<TTimer = ReturnType<typeof setTimeout>> {
  /** Builds the transport, wiring `onMessage`/`onConn` back into this composable's own dispatch
   * loop — the same "hooks in, client out" shape the legacy `wireFleetUi(win, doc, makeClient)`
   * used, so `transport/token.ts` / `transport/password.ts` plug in unchanged. */
  createTransport(hooks: TransportHooks): HubTransport;
  doc: RenderGateDocument;
  win: RenderGateWindow;
  setTimeout(fn: () => void, ms: number): TTimer;
  clearTimeout(handle: TTimer): void;
  now?(): number;
  /** Minimum interval between (re)subscribe attempts for the same agent key — mirrors the
   * legacy `RESYNC_MIN_INTERVAL_MS` (2000ms) rate limit that keeps a flapping connection from
   * storming `/api/subscribe`. */
  resyncMinIntervalMs?: number;
  /** Forwarded to `createRenderGate` (§3.5 defaults: 100ms / 1000ms). */
  renderIntervalMs?: number;
  renderHiddenPollMs?: number;
}

export interface UseHubHandle extends HubHandle {
  readonly transport: HubTransport;
  /** Fetch one older page for `agentKey` — a no-op unless its history is loaded, has more, and
   * isn't already paging (mirrors the legacy scroll-triggered `client.page()` call; the Vue UI
   * triggers it from `Transcript.vue`'s `load-older` emit instead of a scroll listener). */
  loadOlder(agentKey: string): void;
  start(): Promise<void>;
  dispose(): void;
}

function priorityFor(msg: DispatchMsg): RenderPriority {
  if (msg.event === "fleet") return "throttle";
  if (msg.event === "ev") {
    const type = (msg.data as { e?: { type?: unknown } } | undefined)?.e?.type;
    if (type === "message_update" || type === "tool_execution_update") return "throttle";
  }
  return "now";
}

export function useHub<TTimer = ReturnType<typeof setTimeout>>(opts: UseHubOptions<TTimer>): UseHubHandle {
  const now = opts.now ?? Date.now;
  const resyncMinIntervalMs = opts.resyncMinIntervalMs ?? 2_000;

  let raw: LogicState = initialState();
  const state = shallowRef<HubState>(raw as unknown as HubState) as ShallowRef<HubState>;

  const lastSubAt = new Map<string, number>();
  let subTimer: TTimer | null = null;
  let prevSelected: string | null = null;
  let disposed = false;

  const gate = createRenderGate<TTimer>({
    commit: () => {
      state.value = raw as unknown as HubState;
    },
    ...(opts.renderIntervalMs === undefined ? {} : { intervalMs: opts.renderIntervalMs }),
    ...(opts.renderHiddenPollMs === undefined ? {} : { hiddenPollMs: opts.renderHiddenPollMs }),
    setTimeout: opts.setTimeout,
    clearTimeout: opts.clearTimeout,
    now,
    doc: opts.doc,
    win: opts.win,
  });

  function dispatch(msg: DispatchMsg): void {
    if (disposed) return;
    const next = reduce(
      raw,
      msg.id === undefined
        ? { event: msg.event, data: msg.data ?? {} }
        : { event: msg.event, data: msg.data ?? {}, id: msg.id },
    );
    if (next === raw) return; // no-op event: no effects, no render request (mirrors legacy app.js)
    raw = next;
    runEffects();
    gate.request(priorityFor(msg));
  }

  function runEffects(): void {
    if (raw.selected !== prevSelected) {
      const old = prevSelected;
      prevSelected = raw.selected;
      const oldAgent = old === null ? undefined : raw.agents.get(old);
      if (old !== null && oldAgent?.sub && raw.clientId) {
        void transport.unsubscribe(raw.clientId, old);
        dispatch({ event: "unsubscribed", data: { agentKey: old } });
      }
    }
    const key = needsSubscribe(raw);
    const clientId = raw.clientId;
    if (key === undefined || clientId === null) return;
    const wait = (lastSubAt.get(key) ?? 0) + resyncMinIntervalMs - now();
    if (wait > 0) {
      // rate-limit resync storms; re-evaluate once the window passes
      if (subTimer === null) {
        subTimer = opts.setTimeout(() => {
          subTimer = null;
          runEffects();
        }, wait);
      }
      return;
    }
    lastSubAt.set(key, now());
    dispatch({ event: "subscribing", data: { agentKey: key, clientId } });
    void transport.subscribe(clientId, key).then((r) => {
      dispatch(
        r.ok
          ? { event: "subscribed", data: { agentKey: key } }
          : { event: "subscribe_failed", data: { agentKey: key, error: r.error } },
      );
    });
  }

  function loadOlder(agentKey: string): void {
    if (disposed) return;
    const a = raw.agents.get(agentKey);
    if (!a || a.history !== "loaded" || !a.hasMore || a.paging || !a.oldestEntryId) return;
    const oldestEntryId = a.oldestEntryId;
    dispatch({ event: "paging", data: { agentKey } });
    void transport.page(agentKey, oldestEntryId).then((r) => {
      dispatch(
        r.ok
          ? { event: "page", data: { ...(r.data as Record<string, unknown>), agentKey } }
          : { event: "page_failed", data: { agentKey, error: r.error } },
      );
    });
  }

  const transport = opts.createTransport({
    onMessage: (msg) => dispatch(msg),
    onConn: (c) => dispatch({ event: "conn", data: { state: c } }),
  });
  const control = createControl(transport, dispatch);

  return {
    state: state as Readonly<ShallowRef<HubState>>,
    control,
    dispatch,
    transport,
    loadOlder,
    start: () => transport.start(),
    dispose() {
      if (disposed) return;
      disposed = true;
      if (subTimer !== null) {
        opts.clearTimeout(subTimer);
        subTimer = null;
      }
      gate.dispose();
      transport.close();
    },
  };
}
