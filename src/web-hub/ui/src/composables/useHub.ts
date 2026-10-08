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
 *
 * D2 — main-subscription LRU keep-alive (web-hub-session-switch plan §1.2/§2.2 step 3): the
 * single-slot "switch away ⇒ always unsubscribe" rule is gone. Whether the OLD session's main
 * subscription survives a switch is decided ONLY by `planKeepAlive()` (K = keep-alive cap,
 * product default 3, library default 1 — see `UseHubOptions.keepAliveSessions`); the LRU, the
 * `mainSubs` ledger, and the `mainOps` same-key serialization chain live in this closure (see
 * the D2 block comment in the body for the full contract, incl. R2-1's hello-time op voiding).
 * Hub-side semantics this relies on (plan §0.1): subscriptions are per (clientId, agentKey)
 * with no per-client main-subscription cap; a superseded or unsubscribed snapshot attempt
 * never delivers; `hello` means every old-client subscription is already gone server-side.
 */
import { shallowRef, type ShallowRef } from "vue";
import { initialState, needsRunSubscribe, needsSubscribe, reduce } from "@logic/state.js";
import { planKeepAlive } from "@logic/sessionKeepAlive.js";
import type { RenderGateDocument, RenderGateWindow } from "./renderGate.js";
import { createRenderGate, type RenderPriority } from "./renderGate.js";
import type {
  HubTransport,
  RemoveAgentOutcome,
  RemoveTarget,
  SpawnListOutcome,
  TransportHooks,
  WorktreeDiffTransport,
} from "../transport/types.js";
import { createControl } from "./useControl.js";
import { createSpawn } from "./useSpawn.js";
import { createNewSession } from "./useNewSession.js";
import { successorOf } from "@logic/spawn.js";
import type { SpawnsPayload, SpawnPolicyWire } from "@protocol/spawn.js";
import { SPAWN_MODEL_HUB_CAP } from "@protocol/version.js";
import type { HubHandle, HubSpawnHandle, HubState } from "../types.js";

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
   * storming `/api/subscribe`. fleet-drawer §3.3 also routes run re-subscribes through this
   * same window (its own map, same interval). */
  resyncMinIntervalMs?: number;
  /** fleet-drawer plan §3.3/§6.5 (F5): how long a run subscribe may stay pending (202 sent,
   * no `run_history` yet) before the watchdog re-subscribes — `RUN_TX.clientPendingMs`'s
   * browser mirror (10s; pinned equal by use-hub.test.ts, since importing the protocol module
   * here would drag typebox into the browser bundle). */
  runPendingWatchdogMs?: number;
  /** Forwarded to `createRenderGate` (§3.5 defaults: 100ms / 1000ms). */
  renderIntervalMs?: number;
  renderHiddenPollMs?: number;
  /** web-hub-spawn SP11 / plan §3.2: where a 「我发起的」 flow navigates on `live`
   * (`#/agent/<key>`). Default: a `route` dispatch (selection-level only — App.vue's hash
   * router remains the URL owner; SP12/SP13 wires the real hash navigate). */
  navigate?(agentKey: string): void;
  /** D2 (web-hub-session-switch plan §1.2 D2-2/D2-5): max sessions kept subscribed on the
   * hub, INCLUDING the selected one (⇒ at most K-1 background). Read on every selection
   * change, so shrinking the preference takes effect on the next switch. ABSENT ⇒ 1 — the
   * library-level default keeps the pre-D2 single-slot behavior for every existing embed and
   * test; only App.vue's wiring lifts the product default to 3 via `loadKeepAlive()`. */
  keepAliveSessions?(): number;
}

export interface UseHubHandle extends HubHandle {
  readonly transport: HubTransport;
  /** Fetch one older page for `agentKey` — a no-op unless its history is loaded, has more, and
   * isn't already paging (mirrors the legacy scroll-triggered `client.page()` call; the Vue UI
   * triggers it from `Transcript.vue`'s `load-older` emit instead of a scroll listener). */
  loadOlder(agentKey: string): void;
  /** fleet-drawer plan §6.5 (F5): select/deselect the drawer's run for `agentKey`. A re-select
   * of the same run resets its `runTx` (the error state's manual retry path); any other run of
   * the agent still believed subscribed is torn down first (hub budget: 2 runs/client). */
  selectRun(agentKey: string, runId: string | null): void;
  /** fleet-drawer §6.5 (F5): fetch one older page of the selected run's transcript — a no-op
   * unless its `runTx` is loaded, has more, and isn't already paging (or the transport lacks
   * `runPage`). */
  pageRun(agentKey: string): void;
  /** D2 diag/test surface (plan §3.2 invariants I1/I2): this tab's main-subscription ledger —
   * every agentKey it believes the hub holds a (possibly pending) subscription for, with the
   * clientId each attempt was issued under. Never used by any decision path — decisions read
   * the live closure map; this is the read-only mirror the randomized model test asserts
   * against (ledger size ≤ K; quiescent ledger keys == the fake hub's subscription set). */
  mainSubLedger(): ReadonlyArray<{ key: string; clientId: string }>;
  /** worktree-diff plan v3.1 §4.5/§4.6 (package D4): the `GET /api/worktree-diff/*` call
   * surface, passed through from the transport iff it offers it — `useWorktreeDiff` (D5)
   * treats its absence as "no scope" (no expandable rows, the panel stays byte-identical,
   * I8). Same optional-passthrough discipline as `preview` above. */
  readonly worktreeDiff?: WorktreeDiffTransport;
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

/** Bounded FIFO guard for the one-shot automatic queryOnly (§3.5) — see runControlEffects. */
const AUTO_QUERY_CAP = 256;

export function useHub<TTimer = ReturnType<typeof setTimeout>>(opts: UseHubOptions<TTimer>): UseHubHandle {
  const now = opts.now ?? Date.now;
  const resyncMinIntervalMs = opts.resyncMinIntervalMs ?? 2_000;
  const runPendingWatchdogMs = opts.runPendingWatchdogMs ?? 10_000;

  // ---------------------------------------------------------------------------
  // D2 (web-hub-session-switch plan §1.2 / §2.2 step 3): main-subscription keep-alive state.
  //   `sessionLru` — the MRU-last order of sessions worth keeping subscribed; planning is the
  //     pure `planKeepAlive()` (logic/sessionKeepAlive.ts), this closure only commits and
  //     executes the resulting evictions.
  //   `mainSubs` — the LEDGER: what this tab believes the hub holds for (clientId, agentKey),
  //     pending included. The ONE source of truth for transport decisions — never the
  //     reducer's `sub` (which survives hello/evict for rendering). Mirrors the run side's
  //     `runSubs` + `runAttemptLive` discipline (Major-3): a subscribe POST's result is only
  //     committed when the ledger entry is still this attempt (same gen, same clientId, and
  //     the clientId is still current).
  //   `mainOps` — same-key SERIALIZATION (D2-4): a key with an in-flight op chains the next op
  //     behind it (a slow `unsubscribe(A)` must never overtake a newer `subscribe(A)` on the
  //     wire — the hub would kill the fresh subscription). A key with no in-flight op calls its
  //     op SYNCHRONOUSLY, byte-identical to the pre-D2 call order (K=1 golden). R2-1: on hello
  //     every queued (not yet executing) op of the OLD client is voided and unlinked from its
  //     key, so the current client's subscribe never queues behind a dead client's op; each
  //     queued op re-validates its client immediately before executing anyway (double
  //     insurance — an in-flight op cannot be unsent, but its clientId scoping makes it
  //     harmless to the new client).
  // ---------------------------------------------------------------------------
  let sessionLru: string[] = [];
  const mainSubs = new Map<string, { clientId: string; gen: number }>();
  let mainGenSeq = 0;
  interface MainOp {
    clientId: string;
    cancelled: boolean;
  }
  const mainOps = new Map<string, { op: MainOp; promise: Promise<void> }>();
  let prevMainClientId: string | null = null;

  const keepAliveCap = (): number => {
    const get = opts.keepAliveSessions;
    if (get === undefined) return 1; // library default = legacy single-slot (plan D2-5)
    const v = get();
    return typeof v === "number" && Number.isFinite(v) ? Math.max(1, Math.min(5, Math.floor(v))) : 1;
  };

  /** D2-4/R2-1: serialize same-key main ops; see the block comment above for the full contract. */
  function enqueueMain(key: string, clientId: string, fn: () => Promise<unknown>): void {
    const op: MainOp = { clientId, cancelled: false };
    const exec = (): Promise<unknown> | undefined => {
      if (op.cancelled || clientId !== raw.clientId) return undefined; // R2-1 pre-exec re-validation
      return fn();
    };
    const prev = mainOps.get(key);
    // No in-flight op ⇒ `exec()` (the transport call) runs SYNCHRONOUSLY as this expression
    // is built — the pre-D2 call order. Chained ⇒ it runs once the previous op settles.
    const attempt: Promise<unknown> = prev === undefined ? Promise.resolve(exec()) : prev.promise.then(exec);
    const settled: Promise<void> = attempt.then(
      () => {},
      () => {},
    ); // an op failure must never poison the chain
    const entry = { op, promise: settled };
    mainOps.set(key, entry);
    void settled.then(() => {
      if (mainOps.get(key) === entry) mainOps.delete(key); // only the chain tail unlinks
    });
  }

  /** D2: tear one session's main subscription down — ledger first, transport second (only if
   * the ledger actually held the key under the CURRENT client), reducer last. An agent whose
   * ledger entry is gone (failed POST, hello, agent_removed) sends nothing. */
  function evictSession(key: string): void {
    const m = mainSubs.get(key);
    const a = raw.agents.get(key);
    if (m !== undefined) {
      mainSubs.delete(key);
      if (m.clientId === raw.clientId) enqueueMain(key, m.clientId, () => transport.unsubscribe(m.clientId, key));
    }
    if (a !== undefined && (a.sub !== null || m !== undefined))
      dispatch({ event: "unsubscribed", data: { agentKey: key } });
  }

  let raw: LogicState = initialState();
  const state = shallowRef<HubState>(raw as unknown as HubState) as ShallowRef<HubState>;

  const lastSubAt = new Map<string, number>();
  const autoQueried = new Set<string>(); // §3.5: one automatic queryOnly per pending item id
  let subTimer: TTimer | null = null;
  let prevSelected: string | null = null;
  let disposed = false;

  // ---------------------------------------------------------------------------
  // fleet-drawer plan §6.5 (F5): run-subscription bookkeeping. `runSubs` is this tab's own
  // belief of what the hub currently streams to THIS clientId — the half of the truth the
  // reducer can't see (a `hello` changes the clientId out from under a healthy-looking runTx;
  // a failed POST must clear the belief even though the reducer keeps the slot). `runRetries`
  // counts watchdog re-subscribes (error state after 2, §6.5/U13) and is cleared the moment a
  // subscription attempt SETTLES (snapshot/error landed — `runSettleEffects`), so a later
  // pending episode always starts its U13 budget from zero. `runWatchdogs` is ONE timer per
  // runKey (acceptance fix #1: a single global timer let one run's arm eat another's — timers
  // are now created/replaced per key and cleared precisely on settle/unsubscribe/hello).
  // `gen` is the attempt generation (acceptance fix #3): every async callback re-checks it, so
  // a stale subscribe POST resolving after an agent switch / hello / manual re-select can
  // never poison the new generation's state.
  // ---------------------------------------------------------------------------
  type RunSub = { agentKey: string; runId: string; clientId: string; gen: number };
  const runSubs = new Map<string, RunSub>();
  const runRetries = new Map<string, number>();
  const lastRunSubAt = new Map<string, number>();
  const runWatchdogs = new Map<string, { timer: TTimer; agentKey: string; runId: string }>();
  let runSubGenSeq = 0;
  let runSubTimer: TTimer | null = null;
  let prevRunClientId: string | null = null;

  /** Is the async result of subscribe attempt `gen` (issued under `clientId`) still the
   * CURRENT subscription of `key`? False once the entry was replaced (a newer attempt),
   * removed (unsubscribed/settled), or the SSE clientId moved on (hello) — the caller must
   * drop the result silently instead of touching the new generation's state. */
  function runAttemptLive(key: string, gen: number, clientId: string): boolean {
    const cur = runSubs.get(key);
    return cur !== undefined && cur.gen === gen && cur.clientId === clientId && cur.clientId === raw.clientId;
  }

  /** Precise teardown of one runKey's timer (acceptance fix #1 — never a stray fire). */
  function clearRunWatchdog(key: string): void {
    const w = runWatchdogs.get(key);
    if (w === undefined) return;
    runWatchdogs.delete(key);
    opts.clearTimeout(w.timer);
  }

  /** F5 discipline: unref'd-in-Node timers (browser handles are numbers — the guard no-ops). */
  function unrefIfAble(t: TTimer | null): void {
    const u = t as unknown as { unref?: unknown } | null;
    if (u !== null && typeof u.unref === "function") {
      (u as { unref: () => void }).unref();
    }
  }

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

  /** The single navigation sink (new-session `live` jump + restore successor follow). */
  function navigateTo(agentKey: string): void {
    if (opts.navigate !== undefined) opts.navigate(agentKey);
    else dispatch({ event: "route", data: { agentKey } });
  }

  function dispatch(msg: DispatchMsg): void {
    if (disposed) return;
    const next = reduce(
      raw,
      msg.id === undefined
        ? { event: msg.event, data: msg.data ?? {} }
        : { event: msg.event, data: msg.data ?? {}, id: msg.id },
    );
    if (next === raw) return; // no-op event: no effects, no render request (mirrors legacy app.js)
    const prevSpawns = raw.spawns;
    raw = next;
    // SP11: every `spawns` slot change (snapshot on reconnect, live broadcast) feeds the
    // new-session orchestrator — it settles awaiting flows / refills retained first prompts.
    if (raw.spawns !== prevSpawns) {
      newSession.noteSpawns(raw.spawns);
      // spawn-restore plan §9.1: a viewer of a restored session's OLD key follows its successor
      // (`restore.prevAgentKey === wanted`, live) instead of landing on 「已删除」. Deferred so the
      // navigation (hash change / route event) never re-enters this dispatch.
      const successor = successorOf(raw.spawns, raw.wanted);
      if (successor !== undefined && successor !== raw.wanted) {
        const from = raw.wanted;
        queueMicrotask(() => {
          if (!disposed && raw.wanted === from) navigateTo(successor);
        });
      }
    }
    runEffects();
    gate.request(priorityFor(msg));
  }

  function runEffects(): void {
    if (raw.clientId !== prevMainClientId) {
      // hello: the old client's subscriptions died with the SSE connection — the ledger and
      // every QUEUED (not yet executing) op of the old client go with it (R2-1). Unlinking the
      // map entries means the current client's next op on that key runs immediately instead of
      // queueing behind a dead client's op; an old op already mid-flight cannot be unsent, but
      // it is scoped to the old clientId and its POST result fails the ledger check below.
      mainSubs.clear();
      prevMainClientId = raw.clientId;
      for (const [k, entry] of [...mainOps]) {
        if (entry.op.clientId !== raw.clientId) {
          entry.op.cancelled = true;
          mainOps.delete(k);
        }
      }
    }
    // D2-11/一般-10: ledger entries for agents that no longer exist die on EVERY pass — a
    // background keep-alive agent can vanish via `agent_removed` without any selection change
    // (the hub already cleared its subscriptions for everyone; the stale belief must not
    // count toward the cap nor produce a later useless unsubscribe... which would be harmless
    // anyway, but the ledger stays the one source of truth).
    if (mainSubs.size > 0) {
      for (const k of [...mainSubs.keys()]) if (!raw.agents.has(k)) mainSubs.delete(k);
    }
    if (raw.selected !== prevSelected) {
      const old = prevSelected;
      prevSelected = raw.selected;
      const runIds: string[] = [];
      if (old !== null && raw.clientId) {
        // F5 (fleet-drawer §6.4 #7): the OLD agent's run subscriptions tear down FIRST — before
        // any main-subscription call below — so the transport call order stays
        // runUnsubscribe(old run) → unsubscribe(old) → (nested effects) subscribe(new) …
        for (const [k, v] of [...runSubs]) {
          if (v.agentKey !== old) continue;
          runSubs.delete(k);
          runRetries.delete(k);
          clearRunWatchdog(k);
          runIds.push(v.runId);
          void transport.runUnsubscribe?.(raw.clientId, old, v.runId);
        }
      }
      // D2 (v2 Blocker-1): switching away only tears the old session's RUN subscriptions (above)
      // — whether its MAIN subscription survives is decided solely by the LRU plan below.
      const plan = planKeepAlive({
        lru: sessionLru,
        selected: raw.selected,
        old,
        cap: keepAliveCap(),
        exists: (k) => raw.agents.has(k),
        failed: (k) => raw.agents.get(k)?.history === "error",
      });
      // Commit the LRU BEFORE evicting: evictSession's dispatch re-enters runEffects, where the
      // selection is no longer changed — no re-planning — so a re-entrant pass must see the
      // post-switch LRU, not the pre-switch one.
      sessionLru = plan.lru;
      for (const k of plan.evict) evictSession(k);
      if (old !== null)
        for (const runId of runIds) dispatch({ event: "run_unsubscribed", data: { agentKey: old, runId } });
    }
    runControlEffects();
    runSessionEffects();
    runSettleEffects();
    runFleetEffects();
  }

  function runSessionEffects(): void {
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
        unrefIfAble(subTimer);
      }
      return;
    }
    lastSubAt.set(key, now());
    // D2-3: ledger before POST — the attempt is registered under (clientId, gen) and every
    // async continuation below re-validates it, so an evicted/re-subscribed/hello-superseded
    // attempt's result is dropped silently instead of poisoning the new generation's state.
    const gen = ++mainGenSeq;
    mainSubs.set(key, { clientId, gen });
    dispatch({ event: "subscribing", data: { agentKey: key, clientId } });
    enqueueMain(key, clientId, () =>
      transport.subscribe(clientId, key).then(
        (r) => {
          if (disposed) return;
          const cur = mainSubs.get(key);
          if (cur === undefined || cur.gen !== gen || cur.clientId !== clientId || clientId !== raw.clientId) return; // superseded attempt — drop the stale result
          if (!r.ok) mainSubs.delete(key); // hub never registered it — nothing to unsubscribe later
          dispatch(
            r.ok
              ? { event: "subscribed", data: { agentKey: key } }
              : { event: "subscribe_failed", data: { agentKey: key, error: r.error } },
          );
        },
        () => {
          // transport-level failure (POST never answered): same discipline as `!r.ok` — the hub
          // never registered this attempt, so the ledger entry must not survive it (the pre-D2
          // code just dropped an unhandled rejection here).
          if (disposed) return;
          const cur = mainSubs.get(key);
          if (cur === undefined || cur.gen !== gen || cur.clientId !== clientId || clientId !== raw.clientId) return;
          mainSubs.delete(key);
          dispatch({ event: "subscribe_failed", data: { agentKey: key, error: "E_TRANSPORT" } });
        },
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // F5 (fleet-drawer §6.5): run-transcript effects — subscribe/re-subscribe the selected
  // agent's `runSel`, watchdog a pending subscribe, self-heal E_BUSY, and re-subscribe after
  // an SSE `hello` (clientId change). Run subscriptions are owned HERE, never by components.
  // ---------------------------------------------------------------------------

  function finishRunError(key: string, agentKey: string, runId: string, error: string, reason?: string): void {
    runSubs.delete(key);
    dispatch({
      event: "run_history",
      data: { agentKey, runId, error, ...(reason !== undefined ? { reason } : {}) },
    });
  }

  /** Tear down every OTHER run this tab still believes subscribed (§6.5 E_BUSY self-heal).
   * They belong to other agents/selections — their runTx slots keep their content, only the
   * pending mark clears; a later re-select re-subscribes. */
  function dropOtherRuns(keepKey: string): void {
    const clientId = raw.clientId;
    for (const [k, v] of [...runSubs]) {
      if (k === keepKey) continue;
      runSubs.delete(k);
      runRetries.delete(k);
      clearRunWatchdog(k);
      if (clientId !== null) void transport.runUnsubscribe?.(clientId, v.agentKey, v.runId);
      dispatch({ event: "run_unsubscribed", data: { agentKey: v.agentKey, runId: v.runId } });
    }
  }

  /** One watchdog timer per runKey (acceptance fix #1): arming for an attempt replaces only
   * THAT key's timer, so two pending runs can never eat each other's deadline. The callback
   * captures the attempt's `gen` and drops itself when superseded. `agentKey`/`runId` ride
   * along so `runSettleEffects` can inspect the state without parsing the composite key. */
  function armRunWatchdog(key: string, gen: number, agentKey: string, runId: string): void {
    clearRunWatchdog(key);
    const timer = opts.setTimeout(() => {
      runWatchdogs.delete(key);
      if (disposed) return;
      const sub = runSubs.get(key);
      if (sub === undefined || sub.gen !== gen) return; // superseded attempt — nothing to do
      if (sub.clientId !== raw.clientId) {
        clearRunWatchdog(key); // stale SSE era — the hello branch already re-armed a fresh timer
        return;
      }
      const tx = raw.agents.get(sub.agentKey)?.runTx;
      if (tx === null || tx === undefined || tx.runId !== sub.runId) {
        clearRunWatchdog(key); // this key is no longer the agent's current run — self-clean
        return;
      }
      if (tx.pendingSince === undefined) return; // settled/unsubscribed meanwhile
      // SSE reconnect in progress: no history can arrive yet — push the deadline, don't burn a retry.
      if (raw.conn !== "open") {
        armRunWatchdog(key, gen, agentKey, runId);
        return;
      }
      const retries = runRetries.get(key) ?? 0;
      if (retries >= 2) {
        // §6.5/U13: two re-subscribes already burned — error state with a manual retry button.
        runRetries.delete(key);
        finishRunError(key, sub.agentKey, sub.runId, "E_DEADLINE");
        return;
      }
      runRetries.set(key, retries + 1);
      runSubs.delete(key);
      startRunSubscribe(sub.agentKey, sub.runId);
    }, runPendingWatchdogMs);
    runWatchdogs.set(key, { timer, agentKey, runId });
    unrefIfAble(timer);
  }

  /** Fire one run-subscribe attempt (initial, watchdog retry, or E_BUSY retry). Each attempt
   * gets a fresh `gen`; every async continuation (the POST result AND the E_BUSY retry) must
   * pass `runAttemptLive` first, so a stale promise resolving after an agent switch / hello /
   * manual re-select is dropped silently instead of poisoning the new generation (acceptance
   * fix #3). Failure modes: E_BUSY ⇒ drop the other runs and retry ONCE (same generation),
   * then error; anything else ⇒ error state via the `run_history` error carrier (manual retry). */
  function startRunSubscribe(agentKey: string, runId: string): void {
    const clientId = raw.clientId;
    if (disposed || clientId === null) return;
    const key = `${agentKey}|${runId}`;
    const gen = ++runSubGenSeq;
    const at = now();
    lastRunSubAt.set(key, at);
    runSubs.set(key, { agentKey, runId, clientId, gen });
    dispatch({ event: "run_subscribing", data: { agentKey, runId, at, retries: runRetries.get(key) ?? 0 } });
    const post = (isRetry: boolean): void => {
      const send = transport.runSubscribe;
      if (send === undefined) {
        finishRunError(key, agentKey, runId, "E_UNSUPPORTED");
        return;
      }
      void send(clientId, agentKey, runId).then((r) => {
        if (disposed) return;
        if (!runAttemptLive(key, gen, clientId)) return; // superseded — drop the stale result
        if (r.ok) return; // 202 — the snapshot rides SSE run_history
        if (r.error === "E_BUSY" && !isRetry) {
          dropOtherRuns(key);
          post(true);
          return;
        }
        finishRunError(key, agentKey, runId, r.error, r.reason);
      });
    };
    post(false);
    if (transport.runSubscribe !== undefined) armRunWatchdog(key, gen, agentKey, runId);
  }

  /**
   * Acceptance fix #2's cleanup hook: runs after EVERY dispatch (from `runEffects`), observing
   * the post-reduce state — the semantically closest point to the reducer's history handling
   * (state.js's `run_history`/`run_end`) without useHub reaching into the reducer. A runKey's
   * subscription attempt has SETTLED when the agent's runTx for it is no longer pending and
   * holds a terminal outcome (`history:"loaded"` — the snapshot or run_end landed — or
   * `history:"error"`): its watchdog timer and retry counter are done and get cleared, so a
   * LATER pending episode (a §3.3 hole, a hello) always starts its §6.5/U13 budget from zero
   * instead of inheriting a stale count and erroring early.
   */
  function runSettleEffects(): void {
    if (runWatchdogs.size === 0) return;
    for (const [key, w] of [...runWatchdogs]) {
      const tx = raw.agents.get(w.agentKey)?.runTx;
      if (
        tx !== null &&
        tx !== undefined &&
        tx.runId === w.runId &&
        tx.pendingSince === undefined &&
        (tx.history === "loaded" || tx.history === "error")
      ) {
        clearRunWatchdog(key);
        runRetries.delete(key);
      }
    }
  }

  function runFleetEffects(): void {
    if (disposed) return;
    // §6.5: a new SSE clientId (hello) invalidates every run subscription this tab believes in
    // — the old client's subs died with the connection, so only the local bookkeeping needs
    // clearing (runTx content deliberately survives; the selected run re-subscribes right away
    // and shows the "reconnecting" pending badge meanwhile).
    if (raw.clientId !== prevRunClientId) {
      const had = [...runSubs.entries()];
      runSubs.clear();
      prevRunClientId = raw.clientId;
      // Acceptance fix #1: every old-era timer goes with the old clientId — the re-subscribe
      // below arms fresh ones (and stale attempt results are dropped by the gen check).
      for (const [k] of had) {
        runRetries.delete(k);
        clearRunWatchdog(k);
      }
      for (const [, v] of had) dispatch({ event: "run_unsubscribed", data: { agentKey: v.agentKey, runId: v.runId } });
    }
    if (raw.conn !== "open" || raw.clientId === null) return;
    const sel = raw.selected;
    if (sel === null) return;
    const a = raw.agents.get(sel);
    if (!a || a.down || typeof a.runSel !== "string") return;
    const runId = a.runSel;
    const key = `${sel}|${runId}`;
    const tx = a.runTx;
    if (tx !== null && tx !== undefined && tx.runId === runId && tx.pendingSince !== undefined) return; // in flight
    if (tx !== null && tx !== undefined && tx.runId === runId && tx.history === "error") return; // manual retry only
    const stateWants = needsRunSubscribe(raw) !== undefined;
    if (!stateWants && runSubs.has(key)) return; // subscribed and healthy
    const wait = (lastRunSubAt.get(key) ?? 0) + resyncMinIntervalMs - now();
    if (wait > 0) {
      // §3.3 browser column: run re-subscribes share the main resync window (own map).
      if (runSubTimer === null) {
        runSubTimer = opts.setTimeout(() => {
          runSubTimer = null;
          runEffects();
        }, wait);
        unrefIfAble(runSubTimer);
      }
      return;
    }
    startRunSubscribe(sel, runId);
  }

  /**
   * control-plan §3.5/§7.7: a pending item in `unknown` (fetch timeout / agent_gone — possibly
   * executed) gets exactly ONE automatic queryOnly once its agent is live — never an automatic
   * re-execution. A command-kind item armed with `lateQuery` (reducer's cmd_late case, v2.1)
   * also gets one query to fetch the full result (SSE cmd_late never carries output, §6.6).
   * Both guards self-clear: query_start transitions the item out of `unknown`/`lateQuery`, and
   * `autoQueried` blocks the unknown-driven path from ever firing twice for the same id.
   */
  function runControlEffects(): void {
    for (const [agentKey, a] of raw.agents) {
      if (a.down) continue;
      const pending = (a as { pendingCtl?: unknown }).pendingCtl;
      if (!Array.isArray(pending)) continue;
      for (const it of pending as Array<Record<string, unknown>>) {
        if (!it || typeof it.id !== "string") continue;
        if (it.lateQuery === true && it.state === "querying") {
          void control.query(agentKey, it.id); // query_start clears lateQuery ⇒ fires once
          continue;
        }
        if (it.state === "unknown") {
          const qk = `${agentKey}|${it.id}`;
          if (autoQueried.has(qk)) continue;
          autoQueried.add(qk);
          while (autoQueried.size > AUTO_QUERY_CAP) {
            const oldest = autoQueried.values().next().value;
            if (oldest === undefined) break;
            autoQueried.delete(oldest);
          }
          void control.query(agentKey, it.id);
        }
      }
    }
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

  function selectRun(agentKey: string, runId: string | null): void {
    if (disposed) return;
    // Tear down any OTHER run of this agent this tab still believes subscribed (hub budget:
    // 2 distinct runs per client — §3.4's 503 E_BUSY is exactly this, and the E_BUSY self-heal
    // drops the others anyway; doing it eagerly keeps the common switch under the budget).
    const clientId = raw.clientId;
    for (const [k, v] of [...runSubs]) {
      if (v.agentKey !== agentKey) continue;
      if (runId !== null && v.runId === runId) continue;
      runSubs.delete(k);
      runRetries.delete(k);
      clearRunWatchdog(k);
      if (clientId !== null) void transport.runUnsubscribe?.(clientId, agentKey, v.runId);
      dispatch({ event: "run_unsubscribed", data: { agentKey, runId: v.runId } });
    }
    runRetries.delete(`${agentKey}|${runId ?? ""}`);
    dispatch({ event: "run_select", data: { agentKey, runId } });
  }

  function pageRun(agentKey: string): void {
    if (disposed) return;
    const tx = raw.agents.get(agentKey)?.runTx;
    if (!tx || tx.history !== "loaded" || !tx.hasMore || tx.paging || tx.oldestEntryId === undefined) return;
    if (transport.runPage === undefined) return;
    const runId = tx.runId;
    const before = tx.oldestEntryId;
    dispatch({ event: "run_paging", data: { agentKey, runId } });
    void transport.runPage(agentKey, runId, before).then((r) => {
      if (disposed) return;
      dispatch(
        r.ok
          ? { event: "run_page", data: { ...(r.data as Record<string, unknown>), agentKey, runId } }
          : {
              event: "run_page_failed",
              data: {
                agentKey,
                runId,
                error: r.error,
                ...("reason" in r && r.reason !== undefined ? { reason: r.reason } : {}),
              },
            },
      );
    });
  }

  const transport = opts.createTransport({
    onMessage: (msg) => dispatch(msg),
    onConn: (c) => dispatch({ event: "conn", data: { state: c } }),
  });
  const control = createControl(transport, dispatch, {
    // D21: prompt/abort/command carry `expect.sessionId` of the session currently shown (§7.7).
    getSessionId: (agentKey) => {
      const session = raw.agents.get(agentKey)?.session as { sessionId?: unknown } | undefined;
      return typeof session?.sessionId === "string" ? session.sessionId : undefined;
    },
    now,
  });

  // ---------------------------------------------------------------------------
  // web-hub-spawn SP11 (arch §8.3, plan §3.2): the headless-spawn call surface plus the
  // new-session orchestrator. `list()` successes are remembered so the orchestrator's
  // awaiting watchdog tracks the hub's real `registerTimeoutS` instead of the 30s default.
  // ---------------------------------------------------------------------------
  const spawnBase = createSpawn(transport);
  let latestSpawnPolicy: SpawnPolicyWire | undefined;
  const listWithPolicy = async (): Promise<SpawnListOutcome> => {
    const r = await spawnBase.list();
    if (r.ok) latestSpawnPolicy = r.policy;
    return r;
  };
  const newSession = createNewSession({
    start: (req) => spawnBase.start(req),
    policy: () => latestSpawnPolicy,
    // default-model plan F1 (D4): the second cap guard — `model` only reaches the wire while
    // the CURRENT hub frame still advertises `spawn.model.v1` (a hub downgrade mid-session
    // silently drops it instead of 400ing).
    modelCap: () => {
      const h = raw.hub;
      const caps = h !== null && typeof h === "object" ? (h as { caps?: unknown }).caps : undefined;
      return Array.isArray(caps) && caps.includes(SPAWN_MODEL_HUB_CAP);
    },
    control,
    navigate: (agentKey) => navigateTo(agentKey),
    now,
    setTimeout: opts.setTimeout,
    clearTimeout: opts.clearTimeout,
  });
  const spawn: HubSpawnHandle = {
    // default-model plan F1: `spawnBase.list` already folds a well-formed `prefs` slot into
    // the ref, so both names can share this one wrapped path (policy tracking + prefs fold).
    list: listWithPolicy,
    refreshPrefs: listWithPolicy,
    dirs: () => spawnBase.dirs(),
    start: (req) => spawnBase.start(req),
    stop: (spawnId, force) => spawnBase.stop(spawnId, force),
    prefs: spawnBase.prefs,
    setDefaultModel: (defaultModel) => spawnBase.setDefaultModel(defaultModel),
    newSession,
  };

  // ---------------------------------------------------------------------------
  // web-hub-delete-session plan v2 §5.3/§5.4: `removeAgent` — a transport without it (test
  // fakes) degrades to `E_UNSUPPORTED`, same discipline as `createSpawn`'s UNSUPPORTED_*.
  // ---------------------------------------------------------------------------
  const UNSUPPORTED_REMOVE: RemoveAgentOutcome = { ok: false, error: "E_UNSUPPORTED" };
  function removeAgent(target: RemoveTarget): Promise<RemoveAgentOutcome> {
    return transport.removeAgent === undefined ? Promise.resolve(UNSUPPORTED_REMOVE) : transport.removeAgent(target);
  }

  return {
    state: state as Readonly<ShallowRef<HubState>>,
    control,
    spawn,
    removeAgent,
    // PV4 (web-hub-preview plan v3 §4.6): the preview call surface rides the handle iff the
    // transport offers it — `usePreview`'s scope derivation treats its absence as "nothing
    // is clickable" (`previewScopeOf`'s `hasTransport`).
    ...(transport.preview === undefined ? {} : { preview: transport.preview }),
    // worktree-diff plan v3.1 §4.6 (D4): same passthrough rule as `preview` — the surface rides
    // the handle iff the transport offers it (a test fake without it keeps "no scope").
    ...(transport.worktreeDiff === undefined ? {} : { worktreeDiff: transport.worktreeDiff }),
    dispatch,
    transport,
    loadOlder,
    selectRun,
    pageRun,
    mainSubLedger: () => [...mainSubs.entries()].map(([key, m]) => ({ key, clientId: m.clientId })),
    start: () => transport.start(),
    dispose() {
      if (disposed) return;
      disposed = true;
      // D2/R2-1: queued (not yet executing) main ops die with the handle — their continuations
      // would otherwise fire transport calls into a closed client.
      for (const [, entry] of mainOps) entry.op.cancelled = true;
      mainOps.clear();
      mainSubs.clear();
      if (subTimer !== null) {
        opts.clearTimeout(subTimer);
        subTimer = null;
      }
      if (runSubTimer !== null) {
        opts.clearTimeout(runSubTimer);
        runSubTimer = null;
      }
      for (const w of runWatchdogs.values()) opts.clearTimeout(w.timer);
      runWatchdogs.clear();
      newSession.dispose();
      gate.dispose();
      transport.close();
    },
  };
}
