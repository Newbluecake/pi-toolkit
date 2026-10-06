/**
 * Browser-side state reducer (plan §包 E). Pure functions, no DOM, no I/O —
 * `reduce(state, msg)` never mutates its input and returns a new state (or the
 * same object when nothing changed). Runs unchanged under vitest (node).
 *
 * `msg` is either an SSE frame (`event` ∈ SSE_EVENTS, `data` = parsed JSON,
 * `id` = SSE id) or a local UI/transport event (`event` ∈ LOCAL_EVENTS).
 *
 * Dedupe rules (arch §7): transcript items from history entries are keyed by
 * entry id; non-custom messages additionally by messageKey (`role:timestamp`,
 * toolResult + `:toolCallId`); custom messages are NOT deduped by key (content
 * keys collide) — live ones are deduped by `ev` seq, appended ones by entry id.
 *
 * Control-plane (control-plan v2.1 §7.3/§7.7, package C4): the `dialogs`/`ctl`/`commands`/
 * `cmd_late` SSE frames land in per-agent slots, `status.queue`/`queueDropped` feed the
 * queue mirror, local `ctl_send`/`ctl_result`/`ctl_retry`/`ctl_discard` events drive the
 * `pendingCtl` optimistic-item state machine (the transitions themselves live in
 * `./control.js`'s pure `pendingTransition`), and the `hub` frame's `caps`/`state`/
 * supersede fields surface as top-level `control`/`hubState`/… — all ADDITIVE cases; no
 * pre-P2 event's semantics changed.
 *
 * Fleet drawer (fleet-drawer plan §3.3/§6.5, package F5): every agent additionally carries the
 * drawer's selected run (`runSel`) and its transcript (`runTx`). The runTx seq rules mirror §3.3's
 * browser column: `run_history` wholesale REPLACES the state (`lastSeq = fromSeq - 1`), `run_ev`
 * is appended only when `seq === lastSeq + 1` and the tapId matches (duplicates dropped, a hole
 * sets `needsResync` for `useHub`'s rate-limited re-subscribe), `run_end` enters `terminal` WITHOUT
 * clearing received items (§3.6's "live 查看的内容保留"), and a `lastSeq` mismatch re-arms
 * `needsResync`. The entry/message cores (`historyCore`/`pageCore`/`eventCore`) are shared with the
 * main session — same code path, main-session behavior pinned unchanged by logic-state.test.ts.
 *
 * Todo panel (todo-web plan §4, package T4): the optional `StatusInfo.todo` task-list summary
 * is mirrored off the status slot onto `AgentState.todo` (absent-means-cleared, same semantics
 * as the `queue` mirror) for the detail header's read-only TodoPanel.
 */

/**
 * @typedef {{ kind: string, title?: string, since: number }} Prompt
 * @typedef {{ epoch: string, open: any[], closed: any[] }} DialogsState
 * @typedef {import("./control.js").PendingItem} PendingCtlItem
 * @typedef {{ toolCallId: string, toolName: string, args: unknown, partial?: string,
 *   result?: unknown, isError?: boolean, done: boolean, truncated?: boolean }} LiveTool
 * @typedef {{ id: string, kind: "message" | "custom" | "compaction" | "branch_summary" | "model_change",
 *   entryId?: string | undefined, seq?: number | undefined, key?: string | undefined, message?: any, entry?: any,
 *   truncated?: boolean | undefined }} Item
 * @typedef {{ clientId: string, pending: boolean, failed?: boolean }} Sub
 * @typedef {{ active: number, terminal: number }} FleetOmitted
 * @typedef {{ runId: string, tapId?: string | undefined, lastSeq: number, items: Item[],
 *   keys: Set<string>, entryIds: Set<string>, uid: number, streaming: any, tools: LiveTool[],
 *   history: "none" | "waiting" | "loaded" | "error", historyError?: string | undefined,
 *   reason?: string | undefined, hasMore: boolean, oldestEntryId?: string | undefined, paging: boolean,
 *   terminal: boolean, status: string, live: boolean, source?: "live" | "file" | undefined,
 *   pendingSince?: number | undefined, retries: number, lastRow?: any,
 *   needsResync: boolean }} RunTxState
 * @typedef {{
 *   key: string, card: any, down: boolean, downReason?: string | undefined,
 *   session?: any, status?: any, prompts: Prompt[], fleet: any[],
 *   items: Item[], keys: Set<string>, entryIds: Set<string>, uid: number,
 *   lastSeq: number, streaming: any | null, tools: LiveTool[],
 *   history: "none" | "waiting" | "loaded" | "error", historyError?: string | undefined,
 *   hasMore: boolean, oldestEntryId?: string | undefined, paging: boolean,
 *   needsResync: boolean, sub: Sub | null,
 *   dialogs?: DialogsState | undefined, queue?: any[] | undefined,
 *   pendingCtl: PendingCtlItem[], ctl?: any[] | undefined, commands?: any[] | undefined,
 *   runSel: string | null, runTx: RunTxState | null, fleetOmitted?: FleetOmitted | undefined,
 *   todo?: import("../../../protocol/messages.js").TodoWire | undefined,
 * }} AgentState
 * @typedef {{
 *   clientId: string | null, hub: any, conn: string, lastEventId?: number,
 *   selected: string | null, agents: Map<string, AgentState>, order: string[],
 *   routed: boolean, wanted: string | null,
 *   control: boolean, hubState?: "running" | "stopping" | "restarting" | undefined,
 *   nextVersion?: string | undefined, supersedePending: boolean,
 *   supersedeDeadlineAt?: number | undefined, forced: boolean, draining: boolean,
 *   spawns: import("../../../protocol/spawn.js").SpawnsPayload | null,
 *   removed: ReadonlySet<string>,
 * }} State
 * @typedef {{ event: string, data: any, id?: number }} Msg
 */
import { pendingTransition } from "./control.js";
import { SSE_EVENTS } from "@protocol/http-contract.ts";

/**
 * Anti-drift pin (verifier r1 #2, P2 打回): `"agent_removed"` has no standalone named export in
 * `protocol/http-contract.ts` — it only exists as one entry of the frozen `SSE_EVENTS` array.
 * This throws at MODULE LOAD TIME (not just in a test someone remembers to write) if the
 * protocol ever renames/removes it without updating this file. `SSE_EVENTS` is free to import
 * here — `http-contract.ts` only TYPE-imports `messages.js` (zero runtime typebox cost), same
 * rationale `./contract.js`'s header already documents.
 * @param {string} name @returns {string}
 */
function pinnedEvent(name) {
  if (!SSE_EVENTS.includes(name)) {
    throw new Error(
      `@logic/state.js: protocol drift — "${name}" is no longer in protocol/http-contract.ts's SSE_EVENTS`,
    );
  }
  return name;
}

const AGENT_REMOVED_EVENT = pinnedEvent("agent_removed");

/** Local (non-SSE) events understood by `reduce`. */
export const LOCAL_EVENTS = Object.freeze([
  "conn", // {state:"connecting"|"open"|"reconnecting"|"auth"}
  "select", // {agentKey}
  "route", // {agentKey: string | null} — vue-plan.md v2.1 §3.3 compatibility extension (P1): the
  // hash router (§3.7) is the single source of truth for selection in the new UI. Once any
  // `route` event has been dispatched, `withSelection` stops auto-picking the first live agent
  // and instead only honors the last routed `agentKey` (or clears selection if it isn't/isn't
  // yet present). The legacy UI never dispatches this event, so `routed` stays permanently
  // false there and behavior is byte-for-byte unchanged.
  "subscribing", // {agentKey, clientId}
  "subscribed", // {agentKey}
  "subscribe_failed", // {agentKey, error}
  "unsubscribed", // {agentKey}
  "retry", // {agentKey}
  "paging", // {agentKey}
  "page", // HistoryPayload from GET /api/history
  "page_failed", // {agentKey, error}
  "ctl_send", // {agentKey, item} — optimistic pendingCtl item (§7.3)
  "ctl_result", // {agentKey, id, transition} — a pendingTransition event (§7.7)
  "ctl_retry", // {agentKey, id} — failed item back to sending (same id)
  "ctl_discard", // {agentKey, id} — drop the item
  // fleet-drawer plan §6.5 (F5): run-transcript slot. `run_select` picks/drops the drawer's run
  // (resetting runTx — a re-select of the same run is the error state's manual retry),
  // `run_subscribing` marks a subscribe attempt in flight (`at` feeds useHub's watchdog via
  // `pendingSince`, `retries` rides along), `run_unsubscribed` clears the pending mark without
  // touching received content, and `run_paging`/`run_page`/`run_page_failed` mirror `paging`/
  // `page`/`page_failed` for `useHub.pageRun`.
  "run_select", // {agentKey, runId: string | null}
  "run_subscribing", // {agentKey, runId, at, retries}
  "run_unsubscribed", // {agentKey, runId}
  "run_paging", // {agentKey, runId}
  "run_page", // RunHistoryPayload + {agentKey} (GET /api/run/history)
  "run_page_failed", // {agentKey, runId, error, reason?}
]);

/** @returns {State} */
export function initialState() {
  return {
    clientId: null,
    hub: null,
    conn: "connecting",
    selected: null,
    agents: new Map(),
    order: [],
    routed: false,
    wanted: null,
    control: false,
    supersedePending: false,
    forced: false,
    draining: false,
    supersedeBlocked: undefined,
    spawns: null,
    removed: new Set(),
  };
}

/**
 * web-hub-delete-session plan v2 §5.1: bounded FIFO membership set for `agent_removed`'s
 * `State.removed` — caps unbounded growth from a long-lived tab that watches many delete/
 * reappear cycles. Idempotent (a duplicate `agent_removed` for the same key is a no-op, same
 * object back) so callers keep the reducer's no-op \u21d2 same-state invariant.
 * @param {ReadonlySet<string>} set @param {string} key @returns {ReadonlySet<string>}
 */
const REMOVED_CAP = 64;
function addRemoved(set, key) {
  if (set.has(key)) return set;
  const next = new Set(set);
  next.add(key);
  while (next.size > REMOVED_CAP) {
    const oldest = next.values().next().value;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
}

/**
 * A key reappearing (a fresh `agents`/`agent_up` snapshot carries it again, §3: the same pi
 * process re-`hello`s after a removed-card reconnect) clears it from `removed` — the reducer's
 * no-op \u21d2 same-state invariant holds (returns the SAME set when nothing changes).
 * @param {ReadonlySet<string>} set @param {Iterable<string>} keys @returns {ReadonlySet<string>}
 */
function clearRemoved(set, keys) {
  if (set.size === 0) return set;
  let next = set;
  for (const k of keys) {
    if (next.has(k)) {
      if (next === set) next = new Set(set);
      next.delete(k);
    }
  }
  return next;
}

/**
 * todo-web §4 (T4): minimal shape check for `StatusInfo.todo` before mirroring it onto the
 * agent (`undefined` = absent/cleared — the panel renders nothing). Deliberately shallow:
 * the hub's own schema already validated the frame; this only guards against a hand-rolled
 * or legacy peer putting a non-object / task-less value in the slot.
 * @param {any} status
 * @returns {import("../../../protocol/messages.js").TodoWire | undefined}
 */
function todoFromStatus(status) {
  const t = status !== null && typeof status === "object" ? status.todo : undefined;
  return t !== null && typeof t === "object" && Array.isArray(t.tasks) ? t : undefined;
}

/**
 * @param {any} card
 * @returns {AgentState}
 */
function newAgent(card) {
  return {
    key: String(card.agentKey),
    card,
    down: false,
    session: card.session,
    status: card.status,
    todo: todoFromStatus(card.status),
    prompts: Array.isArray(card.prompts) ? card.prompts : [],
    fleet: [],
    items: [],
    keys: new Set(),
    entryIds: new Set(),
    uid: 0,
    lastSeq: -1,
    streaming: null,
    tools: [],
    history: "none",
    hasMore: false,
    paging: false,
    needsResync: false,
    sub: null,
    pendingCtl: [],
    // fleet-drawer §6.5 (F5): the drawer's selected run + its transcript state.
    runSel: null,
    runTx: null,
    ...(card.dialogs && typeof card.dialogs === "object" ? { dialogs: card.dialogs } : {}),
    // accfix-N2: mirrors the `dialogs` line above — a browser attaching AFTER the agent already
    // announced its `commands` slot (fresh tab, reconnect, second tab) must not sit without a
    // command palette until a live `commands` SSE event happens to fire again.
    ...(Array.isArray(card.commands) ? { commands: card.commands } : {}),
  };
}

/**
 * Map every pending item through `fn` (which returns the next item, the same item, or `null`
 * to remove). Reference-preserving: returns the SAME array when nothing changed, so callers
 * can keep the reducer's no-op ⇒ same-state invariant.
 * @param {PendingCtlItem[]} list @param {(it: PendingCtlItem) => PendingCtlItem | null} fn
 * @returns {PendingCtlItem[]}
 */
function transitionPending(list, fn) {
  let out = null;
  for (let i = 0; i < list.length; i++) {
    const it = /** @type {PendingCtlItem} */ (list[i]);
    const next = fn(it);
    if (out) {
      if (next !== null) out.push(next);
    } else if (next !== it) {
      out = [...list.slice(0, i)];
      if (next !== null) out.push(next);
    }
  }
  return out ?? list;
}

/**
 * Same key rule as protocol `messageKey` for non-custom roles.
 * @param {any} m
 * @returns {string | undefined}
 */
export function messageKey(m) {
  if (!m || typeof m !== "object") return undefined;
  if (m.role === "custom") return undefined; // custom: never key-deduped in the browser
  const ts = m.timestamp ?? "";
  if (m.role === "toolResult") return `${m.role}:${ts}:${typeof m.toolCallId === "string" ? m.toolCallId : ""}`;
  return `${m.role}:${ts}`;
}

/**
 * @param {State} s
 * @param {string} key
 * @param {(a: AgentState) => AgentState} fn
 * @returns {State}
 */
function updateAgent(s, key, fn) {
  const a = s.agents.get(key);
  if (!a) return s;
  const next = fn(a);
  if (next === a) return s;
  const agents = new Map(s.agents);
  agents.set(key, next);
  return { ...s, agents };
}

/**
 * @param {State} s
 * @param {Msg} msg
 * @returns {State}
 */
export function reduce(s, msg) {
  if (!msg || typeof msg.event !== "string") return s;
  const d = msg.data && typeof msg.data === "object" ? msg.data : {};
  const next = reduceInner(s, msg.event, d);
  if (typeof msg.id === "number" && Number.isFinite(msg.id) && next.lastEventId !== msg.id) {
    return { ...next, lastEventId: msg.id };
  }
  return next;
}

/**
 * @param {State} s
 * @param {string} event
 * @param {any} d
 * @returns {State}
 */
function reduceInner(s, event, d) {
  const key = typeof d.agentKey === "string" ? d.agentKey : undefined;
  switch (event) {
    // ---------------------------------------------------------------- global
    case "hello": {
      // New SSE connection ⇒ new clientId; subscriptions of the old client are gone.
      const agents = new Map();
      for (const [k, a] of s.agents) agents.set(k, a.sub ? { ...a, sub: null } : a);
      return { ...s, clientId: typeof d.clientId === "string" ? d.clientId : null, agents };
    }
    case "hub": {
      // §7.3/§7.7 + §6.6: caps negotiate the control plane (missing cmd.v1 ⇒ read-only UI);
      // state/nextVersion/supersede* drive HubStateBanner (v2.1: countdown, forced, draining).
      const caps = Array.isArray(d.caps) ? d.caps : [];
      return {
        ...s,
        hub: d,
        control: caps.includes("cmd.v1"),
        hubState: d.state === "running" || d.state === "stopping" || d.state === "restarting" ? d.state : undefined,
        nextVersion: typeof d.nextVersion === "string" ? d.nextVersion : undefined,
        supersedePending: d.supersedePending === true,
        supersedeDeadlineAt: typeof d.supersedeDeadlineAt === "number" ? d.supersedeDeadlineAt : undefined,
        forced: d.forced === true,
        draining: d.draining === true,
        supersedeBlocked:
          d.supersedeBlocked === "stopped" || d.supersedeBlocked === "unknown" ? d.supersedeBlocked : undefined,
      };
    }
    case "ping":
      return s;
    case "resync": {
      const agents = new Map();
      for (const [k, a] of s.agents) agents.set(k, a.history !== "none" ? { ...a, needsResync: true } : a);
      return { ...s, agents };
    }
    case "spawns": {
      // web-hub-spawn arch §8.2: the `SpawnsPayload` snapshot/broadcast (Public projection
      // only). Overwrite semantics — a reconnect's snapshot wholesale replaces the slot (no
      // merging, no clearing on `hello`: the hub re-sends the snapshot right after `agents`
      // on every new SSE connection, so a stale slot survives only until then). Invalid
      // payloads are ignored wholesale (same discipline as every other slot here).
      if (!Array.isArray(d.items) || typeof d.active !== "number" || typeof d.max !== "number") return s;
      for (const it of d.items) {
        if (!it || typeof it !== "object" || typeof it.spawnId !== "string" || typeof it.state !== "string") return s;
      }
      return d === s.spawns ? s : { ...s, spawns: d };
    }
    case "agents": {
      const cards = Array.isArray(d) ? d : Array.isArray(d.agents) ? d.agents : [];
      const agents = new Map();
      const order = [];
      for (const card of cards) {
        if (!card || typeof card.agentKey !== "string" || agents.has(card.agentKey)) continue;
        const old = s.agents.get(card.agentKey);
        agents.set(card.agentKey, old ? mergeCard(old, card) : newAgent(card));
        order.push(card.agentKey);
      }
      // web-hub-delete-session plan v2 §5.1: a fresh snapshot carrying a previously-removed key
      // (§3: the same pi process re-„hello“s) clears it from `removed` — the card is genuinely back.
      const removed = clearRemoved(s.removed, agents.keys());
      return withSelection({ ...s, agents, order, removed });
    }
    case "agent_up": {
      const card = d.agent && typeof d.agent === "object" ? d.agent : d;
      if (typeof card.agentKey !== "string") return s;
      const agents = new Map(s.agents);
      const old = s.agents.get(card.agentKey);
      agents.set(card.agentKey, old ? mergeCard(old, card) : newAgent(card));
      const order = old ? s.order : [...s.order, card.agentKey];
      const removed = clearRemoved(s.removed, [card.agentKey]);
      return withSelection({ ...s, agents, order, removed });
    }
    case "agent_down":
      if (!key) return s;
      return updateAgent(s, key, (a) => ({
        ...a,
        down: true,
        downReason: typeof d.reason === "string" ? d.reason : undefined,
        card: { ...a.card, state: "stale" },
        streaming: null,
        tools: a.tools.filter((t) => t.done),
        prompts: [],
        // §3.5: in-flight control items become "结果未知，agent 已离线" — never auto re-executed;
        // useHub's effect queryOnly's them once the agent is live again.
        pendingCtl: transitionPending(a.pendingCtl, (it) => pendingTransition(it, { type: "offline" })),
      }));
    case "agent_stale":
      if (!key) return s;
      return updateAgent(s, key, (a) => ({ ...a, card: { ...a.card, state: "stale" } }));
    case AGENT_REMOVED_EVENT: {
      // web-hub-delete-session plan v2 §2.3/§5.1: hub-broadcast card removal. Drops the key from
      // `agents`/`order` (if still present — a prior `agent_down` or `agents` snapshot may have
      // already dropped it) and records it in `removed` so `DashboardView.vue` can render the
      // 「已删除」 empty state instead of 「未连接」 for a tab still viewing it. `withSelection` settles
      // the selection (the removed agent can never stay selected via auto-pick; a `route`-pinned
      // deep link to it resolves to `null`, same as any other vanished key).
      if (!key) return s;
      const removed = addRemoved(s.removed, key);
      if (!s.agents.has(key)) return removed === s.removed ? s : withSelection({ ...s, removed });
      const agents = new Map(s.agents);
      agents.delete(key);
      const order = s.order.filter((k) => k !== key);
      return withSelection({ ...s, agents, order, removed });
    }

    // ---------------------------------------------------------------- per agent
    case "session":
      if (!key || !d.session) return s;
      return updateAgent(s, key, (a) => applySession(a, d.session));
    case "status":
      if (!key || !d.status) return s;
      return updateAgent(s, key, (a) => {
        /** @type {AgentState} */
        const next = { ...a, status: d.status, card: { ...a.card, status: d.status } };
        // todo-web §4 (T4): mirror the optional task-list summary off the status slot for the
        // detail header's TodoPanel. Same absent-means-cleared semantics as the queue mirror
        // below — the wire omits `todo` entirely once the last task is cleared (the agent-side
        // projection returns `undefined`), and the whole-slot replace above alone would leave
        // no single field the panel can read without re-narrowing `status` itself.
        next.todo = todoFromStatus(d.status);
        // §7.3: the D6 queue mirror rides the status slot; queueDropped cmdIds transition the
        // matching optimistic items to `dropped` (back to the terminal editor / discarded).
        // acc32-B2②: the wire omits `queue` once empty (status.ts only sets it when non-empty)
        // — default to `[]` here just like the "fleet"/"prompt" cases below already do, or the
        // client keeps the last non-empty array forever once the server-side queue drains.
        next.queue = Array.isArray(d.status.queue) ? d.status.queue : [];
        if (Array.isArray(d.status.queueDropped) && d.status.queueDropped.length > 0) {
          const dropped = new Set(d.status.queueDropped.filter((/** @type {any} */ x) => typeof x === "string"));
          next.pendingCtl = transitionPending(next.pendingCtl, (it) =>
            dropped.has(it.id) ? pendingTransition(it, { type: "dropped" }) : it,
          );
        }
        return next;
      });
    case "fleet":
      if (!key) return s;
      return updateAgent(s, key, (a) => applyFleet(a, d));
    case "prompt":
      if (!key) return s;
      return updateAgent(s, key, (a) => ({ ...a, prompts: Array.isArray(d.prompts) ? d.prompts : [] }));
    case "gap":
      if (!key) return s;
      return updateAgent(s, key, (a) => (a.history === "none" || a.needsResync ? a : { ...a, needsResync: true }));
    case "history":
      if (!key) return s;
      return updateAgent(s, key, (a) => applyHistory(a, d));
    case "ev":
      if (!key || typeof d.seq !== "number" || !d.e || typeof d.e.type !== "string") return s;
      return updateAgent(s, key, (a) => applyEv(a, d.seq, d.e));
    case "append":
      if (!key || !Array.isArray(d.entries)) return s;
      return updateAgent(s, key, (a) => (a.history === "loaded" ? appendEntries(a, d.entries) : a));

    // ------------------------------------------------- fleet drawer run transcript (§3.3/§6.5, F5)
    // Every wrapper preserves the reducer's no-op ⇒ same-state invariant: the apply* helper
    // returns the SAME tx object on a dropped frame, and only then does the agent object (and
    // state) stay identical.
    case "run_history":
      // SSE `run_history` (RunHistoryPayload | RunHistoryError); useHub also reuses this event
      // locally to surface a failed runSubscribe POST — same shape, single code path.
      if (!key || typeof d.runId !== "string") return s;
      return updateAgent(s, key, (a) => {
        if (!a.runTx || a.runTx.runId !== d.runId) return a;
        const tx = applyRunHistory(a.runTx, d, a.fleet);
        return tx === a.runTx ? a : { ...a, runTx: tx };
      });
    case "run_ev":
      if (!key || typeof d.runId !== "string" || typeof d.seq !== "number" || !d.e || typeof d.e.type !== "string")
        return s;
      return updateAgent(s, key, (a) => {
        if (!a.runTx || a.runTx.runId !== d.runId) return a;
        const tx = applyRunEv(a.runTx, d);
        return tx === a.runTx ? a : { ...a, runTx: tx };
      });
    case "run_end":
      if (!key || typeof d.runId !== "string" || typeof d.lastSeq !== "number" || typeof d.status !== "string")
        return s;
      return updateAgent(s, key, (a) => {
        if (!a.runTx || a.runTx.runId !== d.runId) return a;
        const tx = applyRunEnd(a.runTx, d);
        return tx === a.runTx ? a : { ...a, runTx: tx };
      });

    // ---------------------------------------------------------------- control plane (§7.3/§7.7)
    case "dialogs": {
      // DialogsFrame slot (D2, overwrite semantics). closed[] also settles this tab's own
      // dialog_* pending items: cmdId === id ⇒ this request won (§3.5); anything else lost.
      if (!key) return s;
      const epoch = typeof d.epoch === "string" ? d.epoch : "";
      const open = Array.isArray(d.open) ? d.open : [];
      const closed = Array.isArray(d.closed) ? d.closed : [];
      return updateAgent(s, key, (a) => {
        let pendingCtl = a.pendingCtl;
        for (const c of closed) {
          if (!c || typeof c.dialogId !== "string") continue;
          pendingCtl = transitionPending(pendingCtl, (it) =>
            (it.kind === "dialog_answer" || it.kind === "dialog_cancel") && it.dialogId === c.dialogId
              ? pendingTransition(it, {
                  type: "dialog_closed",
                  ...(typeof c.cmdId === "string" ? { cmdId: c.cmdId } : {}),
                  ...(typeof c.by === "string" ? { by: c.by } : {}),
                })
              : it,
          );
        }
        return { ...a, dialogs: { epoch, open, closed }, pendingCtl };
      });
    }
    case "ctl": {
      // Prompt-ledger slot (§4.3/§4.5): raw items kept on `agent.ctl`; entries merge into the
      // matching local pending item by cmdId (§7.7) — never creating new ones.
      if (!key) return s;
      const items = Array.isArray(d.items) ? d.items : [];
      return updateAgent(s, key, (a) => {
        const byCmdId = new Map();
        for (const e of items) {
          if (e && typeof e.cmdId === "string") byCmdId.set(e.cmdId, e);
        }
        const pendingCtl = transitionPending(a.pendingCtl, (it) => {
          const entry = byCmdId.get(it.id);
          return entry ? pendingTransition(it, { type: "ctl", entry }) : it;
        });
        return { ...a, ctl: items, pendingCtl };
      });
    }
    case "commands":
      // §4.6 commands slot (completion + policy badges for the composer).
      if (!key) return s;
      return updateAgent(s, key, (a) => ({ ...a, commands: Array.isArray(d.items) ? d.items : [] }));
    case "cmd_late":
      // D15: a result that settled after the HTTP response was lost — terminates the pending
      // item (command-kind items arm a one-shot queryOnly to fetch the output, v2.1 §7.7).
      if (!key || typeof d.id !== "string") return s;
      return updateAgent(s, key, (a) => {
        const pendingCtl = transitionPending(a.pendingCtl, (it) =>
          it.id === d.id
            ? pendingTransition(it, {
                type: "late",
                ok: d.ok === true,
                ...(typeof d.code === "string" ? { code: d.code } : {}),
              })
            : it,
        );
        return pendingCtl === a.pendingCtl ? a : { ...a, pendingCtl };
      });

    // ---------------------------------------------------------------- local
    case "conn":
      return typeof d.state === "string" && d.state !== s.conn ? { ...s, conn: d.state } : s;
    case "select":
      return key && s.agents.has(key) && s.selected !== key ? { ...s, selected: key } : s;
    case "route": {
      const wanted = typeof d.agentKey === "string" ? d.agentKey : null;
      if (s.routed && s.wanted === wanted) return s; // no-op re-route to the same target
      return withSelection({ ...s, routed: true, wanted });
    }
    case "subscribing":
      if (!key || typeof d.clientId !== "string") return s;
      return updateAgent(s, key, (a) => ({
        ...a,
        sub: { clientId: d.clientId, pending: true },
        needsResync: false,
        history: a.history === "loaded" ? "loaded" : "waiting",
        historyError: undefined,
      }));
    case "subscribed":
      if (!key) return s;
      return updateAgent(s, key, (a) => (a.sub ? { ...a, sub: { ...a.sub, pending: false } } : a));
    case "subscribe_failed":
      if (!key) return s;
      return updateAgent(s, key, (a) => ({
        ...a,
        sub: a.sub ? { ...a.sub, pending: false, failed: true } : null,
        history: "error",
        historyError: String(d.error ?? "E_SUBSCRIBE"),
      }));
    case "unsubscribed":
      if (!key) return s;
      return updateAgent(s, key, (a) => ({ ...a, sub: null, history: "none", needsResync: false, paging: false }));
    case "retry":
      if (!key) return s;
      return updateAgent(s, key, (a) => ({ ...a, sub: null, needsResync: true, historyError: undefined }));
    case "paging":
      if (!key) return s;
      return updateAgent(s, key, (a) => ({ ...a, paging: true }));
    case "page":
      if (!key) return s;
      return updateAgent(s, key, (a) => applyPage(a, d));
    case "page_failed":
      if (!key) return s;
      return updateAgent(s, key, (a) => ({ ...a, paging: false }));
    case "run_select":
      // {agentKey, runId: string | null} — null deselects. Always resets runTx (a re-select of
      // the same run is the error state's manual retry); `lastRow` is re-captured from the
      // fleet rows on the next snapshot/subscribing if the run is still listed.
      if (!key) return s;
      return updateAgent(s, key, (a) => {
        const runId = typeof d.runId === "string" ? d.runId : null;
        return a.runSel === runId && a.runTx === null ? a : { ...a, runSel: runId, runTx: null };
      });
    case "run_subscribing": {
      // {agentKey, runId, at, retries} — a subscribe attempt started. Content already received
      // survives (§6.5: after a hello-caused re-subscribe the drawer keeps showing it behind a
      // "reconnecting" badge — that badge is `pendingSince !== undefined` with loaded history).
      if (!key || typeof d.runId !== "string") return s;
      const at = typeof d.at === "number" ? d.at : 0;
      const retries = typeof d.retries === "number" && d.retries >= 0 ? Math.floor(d.retries) : 0;
      return updateAgent(s, key, (a) => {
        const prev = a.runTx && a.runTx.runId === d.runId ? a.runTx : null;
        const base = prev ?? newRunTx(d.runId);
        return {
          ...a,
          runTx: {
            ...base,
            pendingSince: at,
            retries,
            needsResync: false,
            history: prev && prev.history === "loaded" ? "loaded" : "waiting",
            historyError: undefined,
            reason: undefined,
          },
        };
      });
    }
    case "run_unsubscribed":
      // {agentKey, runId} — the subscription is gone (agent switch, deselect, E_BUSY cleanup).
      // Only clears the pending mark: received content stays (a terminal replay keeps working
      // from the same slot), and `needsResync` deliberately survives so a rate-limited
      // re-subscribe still fires once the window passes.
      if (!key || typeof d.runId !== "string") return s;
      return updateAgent(s, key, (a) =>
        a.runTx && a.runTx.runId === d.runId && a.runTx.pendingSince !== undefined
          ? { ...a, runTx: { ...a.runTx, pendingSince: undefined } }
          : a,
      );
    case "run_paging":
      if (!key || typeof d.runId !== "string") return s;
      return updateAgent(s, key, (a) =>
        a.runTx && a.runTx.runId === d.runId && !a.runTx.paging ? { ...a, runTx: { ...a.runTx, paging: true } } : a,
      );
    case "run_page":
      if (!key || typeof d.runId !== "string") return s;
      return updateAgent(s, key, (a) => {
        if (!a.runTx || a.runTx.runId !== d.runId) return a;
        if (a.runTx.history !== "loaded") return { ...a, runTx: { ...a.runTx, paging: false } };
        return { ...a, runTx: { ...a.runTx, ...pageCore(a.runTx, d), paging: false } };
      });
    case "run_page_failed": {
      // {agentKey, runId, error, reason?} — §3.6: paging a terminal run whose session is gone
      // (not_persisted & the other deny-class reasons) disables "load older" for good and
      // records the reason for the hint; transient failures keep hasMore for a retry.
      if (!key || typeof d.runId !== "string") return s;
      const deny =
        typeof d.reason === "string" &&
        [
          "not_persisted",
          "unknown_run",
          "file_missing",
          "leaf_unknown",
          "leaf_missing",
          "too_large",
          "parse_error",
        ].includes(d.reason);
      return updateAgent(s, key, (a) => {
        if (!a.runTx || a.runTx.runId !== d.runId) return a;
        if (!deny) return { ...a, runTx: { ...a.runTx, paging: false } };
        return { ...a, runTx: { ...a.runTx, paging: false, hasMore: false, reason: d.reason } };
      });
    }
    case "ctl_send":
      // Optimistic item for a just-dispatched control request (§7.3). Same id replaces (retry).
      if (!key || !d.item || typeof d.item.id !== "string") return s;
      return updateAgent(s, key, (a) => ({
        ...a,
        pendingCtl: [...a.pendingCtl.filter((it) => it.id !== d.item.id), d.item],
      }));
    case "ctl_result": {
      // A pendingTransition event for one item — the reducer stays a thin shell around
      // ./control.js's pure state machine so components and tests share one definition.
      if (!key || typeof d.id !== "string" || !d.transition || typeof d.transition !== "object") return s;
      return updateAgent(s, key, (a) => {
        const pendingCtl = transitionPending(a.pendingCtl, (it) =>
          it.id === d.id ? pendingTransition(it, d.transition) : it,
        );
        return pendingCtl === a.pendingCtl ? a : { ...a, pendingCtl };
      });
    }
    case "ctl_retry":
      if (!key || typeof d.id !== "string") return s;
      return updateAgent(s, key, (a) => {
        const pendingCtl = transitionPending(a.pendingCtl, (it) =>
          it.id === d.id ? pendingTransition(it, { type: "retry" }) : it,
        );
        return pendingCtl === a.pendingCtl ? a : { ...a, pendingCtl };
      });
    case "ctl_discard":
      if (!key || typeof d.id !== "string") return s;
      return updateAgent(s, key, (a) => {
        const pendingCtl = a.pendingCtl.filter((it) => it.id !== d.id);
        return pendingCtl.length === a.pendingCtl.length ? a : { ...a, pendingCtl };
      });
    default:
      return s;
  }
}

/**
 * The visible outcome of §3.7's routing: once any `route` event has been dispatched, the last
 * routed `agentKey` (if present among `agents`) is the only thing that can select an agent —
 * `withSelection` never falls back to auto-picking the first live one (a deep link to an agent
 * that hasn't arrived yet, or one that just went away, must show "not connected", not silently
 * jump to whatever else is in the list). Pre-P1 (or an old UI session that never dispatches
 * `route`) `s.routed` stays `false` and this is byte-for-byte the original auto-select behavior.
 * @param {State} s @returns {State}
 */
function withSelection(s) {
  if (s.routed) {
    const next = s.wanted !== null && s.agents.has(s.wanted) ? s.wanted : null;
    return next === s.selected ? s : { ...s, selected: next };
  }
  if (s.selected !== null && s.agents.has(s.selected)) return s;
  const first = s.order.find((k) => !s.agents.get(k)?.down) ?? s.order[0] ?? null;
  return first === s.selected ? s : { ...s, selected: first };
}

/** @param {AgentState} a @param {any} card @returns {AgentState} */
function mergeCard(a, card) {
  /** @type {AgentState} */
  let next = {
    ...a,
    card,
    down: false,
    downReason: undefined,
    status: card.status ?? a.status,
    prompts: Array.isArray(card.prompts) ? card.prompts : a.prompts,
  };
  if (card.session) next = applySession(next, card.session);
  // todo-web T4: keep the mirror in lockstep with whichever status object won above
  // (`card.status ?? a.status`) — a reconnect's `agent_up` card carries the same slot.
  next.todo = todoFromStatus(next.status);
  if (card.dialogs && typeof card.dialogs === "object") next = { ...next, dialogs: card.dialogs };
  // accfix-N2: same rationale as `newAgent` above — a card refresh (e.g. `agent_up` after a
  // reconnect) that carries `commands` must fold it in, not just leave the previous value.
  if (Array.isArray(card.commands)) next = { ...next, commands: card.commands };
  return next;
}

/**
 * web-hub-preview plan v3-2 (§7-D13 cwd 双保险, PV4): same sessionId is SUPPOSED to pin cwd
 * (sessionManager 创建时钉住), but comparing `cwd` here too costs one line and treats any
 * cwd drift as a session replacement — clearing the transcript and forcing a refetch, which
 * is also exactly what `usePreview`'s scopeKey watcher needs to invalidate clickable paths.
 * @param {any} a @param {any} b
 */
function sameSession(a, b) {
  return (
    !!a &&
    !!b &&
    a.sessionId === b.sessionId &&
    (a.sessionFile ?? null) === (b.sessionFile ?? null) &&
    (a.cwd ?? null) === (b.cwd ?? null)
  );
}

/**
 * Session replaced (new/resume/fork) ⇒ drop the transcript and wait for a
 * fresh `history` (the hub also pushes `gap`; `needsResync` makes the app
 * re-subscribe either way).
 * @param {AgentState} a @param {any} session @returns {AgentState}
 */
function applySession(a, session) {
  const card = { ...a.card, session };
  if (sameSession(a.session, session) || a.session === undefined) return { ...a, session, card };
  if (a.history === "none") return { ...a, session, card, items: [], keys: new Set(), entryIds: new Set() };
  return {
    ...a,
    session,
    card,
    items: [],
    keys: new Set(),
    entryIds: new Set(),
    lastSeq: -1,
    streaming: null,
    tools: [],
    history: "waiting",
    hasMore: false,
    oldestEntryId: undefined,
    paging: false,
    needsResync: true,
  };
}

// ---------------------------------------------------------------------------
// history / entries
// ---------------------------------------------------------------------------

/**
 * @param {any} entry
 * @returns {Omit<Item, "id"> | undefined}
 */
function entryItem(entry) {
  if (!entry || typeof entry !== "object" || typeof entry.id !== "string") return undefined;
  const base = { entryId: entry.id, truncated: entry.truncated === true };
  switch (entry.type) {
    case "message":
      if (!entry.message || typeof entry.message !== "object") return undefined;
      return { ...base, kind: "message", message: entry.message, key: messageKey(entry.message) };
    case "custom_message":
      if (entry.display === false) return undefined;
      return { ...base, kind: "custom", entry };
    case "compaction":
      return { ...base, kind: "compaction", entry };
    case "branch_summary":
      return { ...base, kind: "branch_summary", entry };
    case "model_change":
      return { ...base, kind: "model_change", entry };
    default:
      return undefined; // custom(data), thinking_level_change: not rendered
  }
}

/**
 * Build items from entries, skipping ones already present (entry id, or
 * non-custom messageKey).
 * @param {AgentState} a @param {any[]} entries
 * @returns {{ items: Item[], keys: Set<string>, entryIds: Set<string>, uid: number }}
 */
function buildItems(a, entries) {
  const keys = new Set(a.keys);
  const entryIds = new Set(a.entryIds);
  let uid = a.uid;
  /** @type {Item[]} */
  const items = [];
  for (const entry of entries) {
    if (!entry || typeof entry.id !== "string" || entryIds.has(entry.id)) continue;
    entryIds.add(entry.id);
    const it = entryItem(entry);
    if (!it) continue;
    if (it.key !== undefined) {
      if (keys.has(it.key)) continue;
      keys.add(it.key);
    }
    items.push({ ...it, id: `e:${entry.id}:${uid++}` });
  }
  return { items, keys, entryIds, uid };
}

// ---------------------------------------------------------------------------
// transcript cores (fleet-drawer §6.5, F5): entry/message/page logic that depends ONLY on
// {items, keys, entryIds, uid, streaming, tools} — shared verbatim by the main session
// (AgentState) and the run transcript (RunTxState). Main-session behavior is byte-identical
// to the pre-F5 inline code (pinned by logic-state.test.ts); the run wrappers below add the
// seq/tapId/terminal rules from §3.3 on top.
// ---------------------------------------------------------------------------

/**
 * A history snapshot wholesale replaces the transcript core (fresh sets — dedupe state does
 * NOT carry over), folds `tailMessages`, derives `streaming`/live `tools` from `inflight`,
 * and lands `lastSeq = fromSeq - 1`.
 * @param {{ uid: number }} _c (core — only `uid` seeds the fresh id counter)
 * @param {any} d
 * @returns {{ items: Item[], keys: Set<string>, entryIds: Set<string>, uid: number, streaming: any, tools: LiveTool[], lastSeq: number, hasMore: boolean, oldestEntryId: string | undefined }}
 */
function historyCore(_c, d) {
  const built = buildItems(
    { items: [], keys: new Set(), entryIds: new Set(), uid: _c.uid },
    Array.isArray(d.entries) ? d.entries : [],
  );
  let uid = built.uid;
  const items = built.items;
  const keys = built.keys;
  for (const m of Array.isArray(d.tailMessages) ? d.tailMessages : []) {
    const it = messageItem(m, keys, `t:${uid++}`);
    if (it) items.push(it);
  }
  const inflight = d.inflight && typeof d.inflight === "object" ? d.inflight : undefined;
  const tools = Array.isArray(inflight?.tools)
    ? inflight.tools
        .filter((/** @type {any} */ t) => t && typeof t.toolCallId === "string")
        .map((/** @type {any} */ t) => ({
          toolCallId: t.toolCallId,
          toolName: String(t.toolName ?? ""),
          args: t.args,
          ...(typeof t.partial === "string" ? { partial: t.partial } : {}),
          done: false,
        }))
    : [];
  const fromSeq = typeof d.fromSeq === "number" ? d.fromSeq : 0;
  return {
    items,
    keys,
    entryIds: built.entryIds,
    uid,
    lastSeq: fromSeq - 1,
    streaming: inflight?.message ? cloneMessage(inflight.message) : null,
    tools,
    hasMore: d.hasMore === true,
    oldestEntryId: typeof d.oldestEntryId === "string" ? d.oldestEntryId : undefined,
  };
}

/**
 * One older page prepends its entries ahead of the existing items; dedupe state carries over.
 * @param {{ items: Item[], keys: Set<string>, entryIds: Set<string>, uid: number, oldestEntryId?: string | undefined }} c
 * @param {any} d
 * @returns {{ items: Item[], keys: Set<string>, entryIds: Set<string>, uid: number, hasMore: boolean, oldestEntryId: string | undefined }}
 */
function pageCore(c, d) {
  const built = buildItems(c, Array.isArray(d.entries) ? d.entries : []);
  return {
    items: [...built.items, ...c.items],
    keys: built.keys,
    entryIds: built.entryIds,
    uid: built.uid,
    hasMore: d.hasMore === true,
    oldestEntryId: typeof d.oldestEntryId === "string" ? d.oldestEntryId : c.oldestEntryId,
  };
}

/** @param {AgentState} a @param {any} d @returns {AgentState} */
function applyHistory(a, d) {
  if (d.error !== undefined && d.error !== null) {
    return { ...a, history: "error", historyError: String(d.error), sub: a.sub ? { ...a.sub, pending: false } : a.sub };
  }
  const core = historyCore(a, d);
  return {
    ...a,
    ...core,
    history: "loaded",
    historyError: undefined,
    paging: false,
    needsResync: false,
    sub: a.sub ? { ...a.sub, pending: false } : a.sub,
  };
}

/** @param {AgentState} a @param {any} d @returns {AgentState} */
function applyPage(a, d) {
  if (a.history !== "loaded") return { ...a, paging: false };
  return { ...a, ...pageCore(a, d), paging: false };
}

/** SSE `append` (spike K7④): entries the event stream never carried. @param {AgentState} a @param {any[]} entries */
function appendEntries(a, entries) {
  const built = buildItems(a, entries);
  if (built.items.length === 0 && built.entryIds.size === a.entryIds.size) return a;
  return { ...a, items: [...a.items, ...built.items], keys: built.keys, entryIds: built.entryIds, uid: built.uid };
}

/**
 * @param {any} m @param {Set<string>} keys (mutated: caller owns a fresh copy) @param {string} id
 * @param {number} [seq]
 * @returns {Item | undefined}
 */
function messageItem(m, keys, id, seq) {
  if (!m || typeof m !== "object" || typeof m.role !== "string") return undefined;
  const key = messageKey(m);
  if (key !== undefined) {
    if (keys.has(key)) return undefined;
    keys.add(key);
  }
  if (m.role === "custom" && m.display === false) return undefined;
  /** @type {Item} */
  const it = { id, kind: "message", message: m, truncated: m.truncated === true };
  if (key !== undefined) it.key = key;
  if (seq !== undefined) it.seq = seq;
  return it;
}

// ---------------------------------------------------------------------------
// live events
// ---------------------------------------------------------------------------

/** @param {AgentState} a @param {number} seq @param {any} e @returns {AgentState} */
function applyEv(a, seq, e) {
  if (a.history !== "loaded") return a; // buffered by the hub and replayed after `history`
  if (seq <= a.lastSeq) return a; // duplicate (ring replay / buffered overlap)
  const jumped = a.lastSeq >= 0 && seq > a.lastSeq + 1;
  const next = applyEvent({ ...a, lastSeq: seq }, seq, e);
  return jumped && !next.needsResync ? { ...next, needsResync: true } : next;
}

/** @param {any} m */
function cloneMessage(m) {
  const content = Array.isArray(m.content)
    ? m.content.map((/** @type {any} */ b) => (b && typeof b === "object" ? { ...b } : b))
    : m.content;
  return { ...m, content };
}

/**
 * Classify a message_update delta. Accepts both the flat wire form
 * (`{contentIndex, delta, kind|deltaType}`) and pi's nested
 * `assistantMessageEvent` form.
 * @param {any} e
 */
function deltaParts(e) {
  const ame = e.assistantMessageEvent && typeof e.assistantMessageEvent === "object" ? e.assistantMessageEvent : {};
  const tag = String(e.deltaType ?? e.kind ?? e.updateType ?? ame.type ?? "");
  const kind = /thinking/i.test(tag) ? "thinking" : /tool/i.test(tag) ? "toolCall" : "text";
  const index =
    typeof e.contentIndex === "number" ? e.contentIndex : typeof ame.contentIndex === "number" ? ame.contentIndex : 0;
  const delta = typeof e.delta === "string" ? e.delta : typeof ame.delta === "string" ? ame.delta : undefined;
  const content = e.content ?? ame.content;
  const toolCall = e.toolCall ?? ame.toolCall;
  return { kind, index, delta, content, toolCall };
}

/** @param {any} streaming @param {any} e */
function applyDelta(streaming, e) {
  const msg = streaming ? cloneMessage(streaming) : { role: "assistant", content: [] };
  if (!Array.isArray(msg.content))
    msg.content = typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : [];
  const { kind, index, delta, content, toolCall } = deltaParts(e);
  // Payload-less updates (e.g. assistantMessageEvent type done/error) carry nothing to merge —
  // ignore them instead of writing an empty placeholder block.
  if (delta === undefined && content === undefined && toolCall === undefined) return streaming;
  if (index < 0 || index > 10_000) return msg;
  while (msg.content.length <= index) msg.content.push(null);
  const prev = msg.content[index];
  if (kind === "toolCall") {
    if (toolCall && typeof toolCall === "object") msg.content[index] = { ...toolCall, type: "toolCall" };
    else if (delta !== undefined) {
      const base = prev && prev.type === "toolCall" ? prev : { type: "toolCall", id: "", name: "", arguments: {} };
      msg.content[index] = { ...base, partialJson: String(base.partialJson ?? "") + delta };
    }
  } else {
    const field = kind === "thinking" ? "thinking" : "text";
    const base = prev && prev.type === kind ? prev : { type: kind, [field]: "" };
    if (typeof content === "string") msg.content[index] = { ...base, [field]: content };
    else if (delta !== undefined) msg.content[index] = { ...base, [field]: String(base[field] ?? "") + delta };
  }
  msg.content = msg.content.map((/** @type {any} */ b) => b ?? { type: "text", text: "" });
  return msg;
}

/** @param {AgentState} a @param {number} seq @param {any} e @returns {AgentState} */
/**
 * The transcript-only half of event application (F5 kernel): everything that depends just on
 * {items, keys, entryIds, uid, streaming, tools}. Returns the SAME object when nothing
 * changed (the main-session wrapper relies on that to keep the reducer's no-op ⇒ same-state
 * invariant for its own no-op branches). `session_info_changed`/`model_select` are
 * deliberately NOT here — they mutate the agent's session/card slots and stay in the
 * main-session wrapper below (a run transcript has no session slot; those events are ignored
 * for runs, exactly like they are when `a.session` is absent for the main session).
 * @param {{ items: Item[], keys: Set<string>, entryIds: Set<string>, uid: number, streaming: any, tools: LiveTool[] }} c
 * @param {number} seq @param {any} e
 */
function eventCore(c, seq, e) {
  switch (e.type) {
    case "message_start":
      if (e.message && e.message.role === "assistant") return { ...c, streaming: cloneMessage(e.message) };
      return c;
    case "message_update":
      return { ...c, streaming: applyDelta(c.streaming, e) };
    case "message_end": {
      const m = e.message;
      if (!m || typeof m !== "object") return c;
      const keys = new Set(c.keys);
      const it = messageItem(m, keys, `s:${seq}`, seq);
      /** @type {any} */
      const next = { ...c, keys };
      if (m.role === "assistant") next.streaming = null;
      if (m.role === "toolResult" && typeof m.toolCallId === "string") {
        next.tools = c.tools.filter((t) => t.toolCallId !== m.toolCallId);
      }
      if (it) next.items = [...c.items, it];
      return next;
    }
    case "tool_execution_start": {
      if (typeof e.toolCallId !== "string") return c;
      const tool = { toolCallId: e.toolCallId, toolName: String(e.toolName ?? ""), args: e.args, done: false };
      return { ...c, tools: [...c.tools.filter((t) => t.toolCallId !== e.toolCallId), tool] };
    }
    case "tool_execution_update": {
      if (typeof e.toolCallId !== "string") return c;
      const partial = typeof e.partial === "string" ? e.partial : resultText(e.partialResult);
      return {
        ...c,
        tools: upsertTool(c.tools, e, (t) => ({ ...t, partial, ...(e.truncated === true ? { truncated: true } : {}) })),
      };
    }
    case "tool_execution_end": {
      if (typeof e.toolCallId !== "string") return c;
      return {
        ...c,
        tools: upsertTool(c.tools, e, (t) => ({
          ...t,
          done: true,
          result: e.result,
          isError: e.isError === true,
          ...(e.truncated === true ? { truncated: true } : {}),
        })),
      };
    }
    case "session_compact": {
      const ce = e.compactionEntry && typeof e.compactionEntry === "object" ? e.compactionEntry : undefined;
      const entryId = typeof ce?.id === "string" ? ce.id : undefined;
      if (entryId && c.entryIds.has(entryId)) return c;
      const entry = {
        type: "compaction",
        summary: ce?.summary ?? e.summary,
        firstKeptEntryId: ce?.firstKeptEntryId ?? e.firstKeptEntryId,
      };
      const entryIds = entryId ? new Set(c.entryIds).add(entryId) : c.entryIds;
      /** @type {Item} */
      const it = { id: `s:${seq}`, kind: "compaction", entry, seq };
      if (entryId) it.entryId = entryId;
      return { ...c, entryIds, items: [...c.items, it] };
    }
    case "agent_end":
      return c.streaming ? { ...c, streaming: null } : c;
    default:
      return c; // turn_*, agent_start/settled, input, ui_prompt_* (banner comes from `prompt`)
  }
}

/** @param {AgentState} a @param {number} seq @param {any} e @returns {AgentState} */
function applyEvent(a, seq, e) {
  switch (e.type) {
    case "session_info_changed":
      if (typeof e.name === "string" && a.session) {
        const session = { ...a.session, name: e.name };
        return { ...a, session, card: { ...a.card, session } };
      }
      return a;
    case "model_select":
      if (e.model && typeof e.model === "object" && a.session) {
        const session = {
          ...a.session,
          model: { provider: String(e.model.provider ?? ""), id: String(e.model.id ?? "") },
        };
        return { ...a, session, card: { ...a.card, session } };
      }
      return a;
    default: {
      const c = {
        items: a.items,
        keys: a.keys,
        entryIds: a.entryIds,
        uid: a.uid,
        streaming: a.streaming,
        tools: a.tools,
      };
      const next = eventCore(c, seq, e);
      return next === c ? a : { ...a, ...next };
    }
  }
}

// ---------------------------------------------------------------------------
// run transcript (fleet-drawer §3.3/§6.5, F5)
// ---------------------------------------------------------------------------

/**
 * A fresh runTx slot (fleet-drawer §6.5). `tapId`/`lastRow` are absent until a snapshot lands;
 * `lastSeq` is a placeholder — the `history !== "loaded"` guard drops any `run_ev` that could
 * conceivably arrive before the snapshot sets the real watermark (`lastSeq = fromSeq - 1`).
 * @param {string} runId @returns {RunTxState}
 */
function newRunTx(runId) {
  return {
    runId,
    lastSeq: 0,
    items: [],
    keys: new Set(),
    entryIds: new Set(),
    uid: 0,
    streaming: null,
    tools: [],
    history: "waiting",
    hasMore: false,
    paging: false,
    terminal: false,
    status: "",
    live: false,
    retries: 0,
    needsResync: false,
  };
}

/**
 * The last-seen fleet row for a run, or undefined. §6.3: when the selected run leaves the
 * projected rows, `runTx.lastRow` keeps the LAST one seen so the drawer header keeps working.
 * @param {any[]} rows @param {string} runId
 */
function rowForRun(rows, runId) {
  for (const row of rows) {
    if (row && typeof row === "object" && row.runId === runId) return row;
  }
  return undefined;
}

/** @param {any} d @returns {FleetOmitted | undefined} */
function validOmitted(d) {
  return d && typeof d === "object" && typeof d.active === "number" && typeof d.terminal === "number"
    ? { active: d.active, terminal: d.terminal }
    : undefined;
}

/**
 * `fleet` frame: replaces the rows slot, folds `omitted` (F0's optional counts), and keeps
 * `runTx.lastRow` fresh while the selected run is still listed (kept verbatim once it leaves —
 * §6.3's "被选中的 run 移出 rows" case).
 * @param {AgentState} a @param {any} d @returns {AgentState}
 */
function applyFleet(a, d) {
  const runs = Array.isArray(d.runs) ? d.runs : [];
  /** @type {AgentState} */
  let next = { ...a, fleet: runs, fleetOmitted: validOmitted(d.omitted) };
  if (a.runTx) {
    const row = rowForRun(runs, a.runTx.runId);
    if (row !== undefined && row !== a.runTx.lastRow) next = { ...next, runTx: { ...a.runTx, lastRow: row } };
  }
  return next;
}

/**
 * `run_history` (§3.3): a snapshot wholesale REPLACES the runTx state — fresh dedupe sets,
 * `lastSeq = fromSeq - 1`, inflight-derived streaming/tools. Also the error carrier
 * (§3.5 `E_AGENT_GONE`, §3.6 denial vocabulary, and useHub's failed runSubscribe POST):
 * an error keeps already-received content (§3.6: a live viewer's transcript stays).
 * @param {RunTxState} tx @param {any} d @param {any[]} fleetRows
 * @returns {RunTxState}
 */
function applyRunHistory(tx, d, fleetRows) {
  if (d.error !== undefined && d.error !== null) {
    return {
      ...tx,
      history: "error",
      historyError: String(d.error),
      reason: typeof d.reason === "string" ? d.reason : undefined,
      pendingSince: undefined,
      needsResync: false,
      paging: false,
    };
  }
  const core = historyCore(tx, d);
  return {
    ...tx,
    ...core,
    tapId: typeof d.tapId === "string" ? d.tapId : undefined,
    history: "loaded",
    historyError: undefined,
    reason: undefined,
    pendingSince: undefined,
    needsResync: false,
    paging: false,
    terminal: d.terminal === true,
    status: typeof d.status === "string" ? d.status : tx.status,
    live: d.live === true,
    source: d.source === "file" ? "file" : "live",
    lastRow: tx.lastRow ?? rowForRun(fleetRows, tx.runId),
  };
}

/**
 * `run_ev` (§3.3 browser column): tapId mismatch or `seq <= lastSeq` ⇒ drop (duplicate);
 * a hole (`seq !== lastSeq + 1`) ⇒ set `needsResync` (useHub re-subscribes, rate-limited) and
 * drop the frame — the re-snapshot replays it; `seq === lastSeq + 1` ⇒ apply via the shared
 * event core and advance the watermark.
 * @param {RunTxState} tx @param {{ tapId?: unknown, seq: number, e: any }} d
 * @returns {RunTxState}
 */
function applyRunEv(tx, d) {
  if (tx.history !== "loaded") return tx; // buffered hub-side until run_history
  if (tx.tapId !== undefined && d.tapId !== tx.tapId) return tx; // stale tap (pre-resync frame)
  if (d.seq <= tx.lastSeq) return tx; // duplicate
  if (d.seq !== tx.lastSeq + 1) return { ...tx, needsResync: true }; // hole ⇒ re-subscribe
  const c = {
    items: tx.items,
    keys: tx.keys,
    entryIds: tx.entryIds,
    uid: tx.uid,
    streaming: tx.streaming,
    tools: tx.tools,
  };
  const next = eventCore(c, d.seq, d.e);
  return { ...tx, ...next, lastSeq: d.seq };
}

/**
 * `run_end` (§3.3): `lastSeq` matches the watermark ⇒ terminal (items kept — §3.6 explicitly
 * forbids clearing a live viewer's received content), live off, streaming bubble dropped;
 * a mismatch ⇒ `needsResync` (the re-snapshot takes the terminal-file path server-side).
 * @param {RunTxState} tx @param {{ tapId?: unknown, lastSeq: number, status: string }} d
 * @returns {RunTxState}
 */
function applyRunEnd(tx, d) {
  if (tx.history !== "loaded") return tx; // hub buffers end behind history (§G8) — stale frame
  if (tx.tapId !== undefined && d.tapId !== tx.tapId) return tx;
  if (tx.lastSeq !== d.lastSeq) return { ...tx, needsResync: true };
  return { ...tx, terminal: true, live: false, status: d.status, streaming: null, pendingSince: undefined };
}

/** @param {LiveTool[]} tools @param {any} e @param {(t: LiveTool) => LiveTool} fn */
function upsertTool(tools, e, fn) {
  const i = tools.findIndex((t) => t.toolCallId === e.toolCallId);
  if (i < 0)
    return [...tools, fn({ toolCallId: e.toolCallId, toolName: String(e.toolName ?? ""), args: e.args, done: false })];
  const out = tools.slice();
  out[i] = fn(/** @type {LiveTool} */ (tools[i]));
  return out;
}

/** Plain text of a tool result / content array (text blocks only). @param {unknown} r */
export function resultText(r) {
  if (typeof r === "string") return r;
  if (!r || typeof r !== "object") return "";
  const content = /** @type {any} */ (r).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && b.type === "text" && typeof b.text === "string" ? b.text : b && b.type === "image" ? "[image]" : "",
      )
      .filter((t) => t !== "")
      .join("\n");
  }
  return "";
}

// ---------------------------------------------------------------------------
// derived decisions (pure)
// ---------------------------------------------------------------------------

/**
 * The agent the app should (re)subscribe now, if any: the selected, live
 * agent whose subscription is missing, belongs to an older SSE client, or
 * needs a resync. Never while a subscribe is in flight.
 * @param {State} s
 * @returns {string | undefined}
 */
export function needsSubscribe(s) {
  if (!s.clientId || s.selected === null) return undefined;
  const a = s.agents.get(s.selected);
  if (!a || a.down) return undefined;
  if (a.sub?.pending) return undefined;
  if (a.sub?.failed && !a.needsResync) return undefined; // manual retry only
  if (!a.sub || a.sub.clientId !== s.clientId || a.needsResync) return a.key;
  return undefined;
}

/** @param {State} s @returns {AgentState | undefined} */
export function selectedAgent(s) {
  return s.selected === null ? undefined : s.agents.get(s.selected);
}

/**
 * The run `useHub` should (re)subscribe now, if any (fleet-drawer §6.5): the selected, live
 * agent's `runSel`, when its runTx is missing, belongs to a different run, or carries
 * `needsResync` (a §3.3 hole / `run_end` mismatch). Mirrors `needsSubscribe`'s guards: never
 * while a subscribe is in flight (`pendingSince`), never for an `error` runTx (manual retry
 * only — `selectRun` re-select resets it). This is HALF the truth: `useHub`'s own `runSubs`
 * (this-tab subscription belief) covers the cases state can't see — a `hello`-caused
 * clientId change that cleared `runSubs` while the runTx still looks healthy.
 * @param {State} s
 * @returns {{ agentKey: string, runId: string } | undefined}
 */
export function needsRunSubscribe(s) {
  if (!s.clientId || s.selected === null) return undefined;
  const a = s.agents.get(s.selected);
  if (!a || a.down || typeof a.runSel !== "string") return undefined;
  const tx = a.runTx;
  if (tx && tx.runId === a.runSel) {
    if (tx.pendingSince !== undefined) return undefined; // in flight
    if (tx.history === "error") return undefined; // manual retry only
    if (!tx.needsResync) return undefined;
  }
  return { agentKey: a.key, runId: a.runSel };
}
