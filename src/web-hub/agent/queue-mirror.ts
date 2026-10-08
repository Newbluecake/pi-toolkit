/**
 * Queue mirror (plan §4.4, D6).
 *
 * pi has no `queue_update` extension event (`_emitQueueUpdate` only reaches
 * the internal app bus, `agent-session.js:642-648`), so this mirror is fed
 * entirely from the events web-hub already forwards: `input` (enqueue),
 * `message_start{role:"user"}` (dequeue), and the 1 Hz `hasPendingMessages()`
 * sample (clear on drain — covers TUI Esc / abort / any other queue-clearing
 * path that fires no event at all).
 *
 * The mirror's enqueue/dequeue are extension-event-driven while the sample reads
 * pi's internal `_steeringMessages`/`_followUpMessages` synchronously
 * (`agent-session.js:1856`, exposed as `ctx.hasPendingMessages()` at :2728) — the
 * two are NOT atomic, so a clear-on-first-empty-sample rule misfires in the two
 * interleaving windows below (field repro: a busy-time web steer got marked
 * "dropped" even though pi had it queued, misleading the user into resending):
 *
 *  - enqueue→push: `prompt()` fires the extension `input` event at
 *    `agent-session.js:1502` (per-handler awaited dispatch, `extensions/runner.js:1202`)
 *    and only pushes into `_steeringMessages` afterwards in `_queueSteer`
 *    (`agent-session.js:1697`) — a tick in between sees "mirror non-empty, pi empty";
 *  - splice→dispatch: at delivery `_handleAgentEvent` splices the text out of
 *    `_steeringMessages` (`agent-session.js:718-721`) BEFORE the awaited
 *    `_emitExtensionEvent` (`agent-session.js:735`) reaches our `message_start`
 *    dequeue — same false-empty view from a tick inside that dispatch chain.
 *
 * Fix decision (candidate c of the investigation; a and b rejected):
 *  - a) "steer items never enter the mirror" is factually wrong about pi — a steer
 *    queued mid-turn waits in `_steeringMessages` until the agent loop's next
 *    `getSteeringMessages()` poll (`pi-agent-core/agent-loop.js:85/111/186`), which
 *    can be a long tool call away; the queued display is correct and load-bearing
 *    for the web UI's steer rows;
 *  - b) pi 1.0's queued-input disposition (`queued`/`handled`/`started`) is only
 *    reachable from the RPC transport — the extension API's `sendUserMessage`
 *    (`extensions/loader.js:306`, `agent-session.js:2676`) is fire-and-forget and
 *    returns nothing, so the mirror can never see it;
 *  - c) therefore `clearIfEmpty` requires the empty condition to PERSIST past a
 *    grace window (`clearGraceMs`, default 1.5 s ≈ two 1 Hz ticks) before clearing:
 *    the race windows are one extension-dispatch chain wide and always resolve
 *    first, while genuine queue-empty states (TUI Esc `clearQueue()`, the
 *    §4.4-row-3 drain paths) persist and still reach `dropped`, just ~1.5 s later.
 */
import type { QueueItemWire } from "../protocol/messages.js";

export type QueueSource = QueueItemWire["source"];

export interface QueueMirrorDeps {
  now?: () => number;
  /** Wire clip length in characters (plan: "截 200 字符"). */
  clipChars?: number;
  maxItems?: number;
  /** How long `hasPendingMessages()===false` must persist (ms) before `clearIfEmpty` actually
   * clears — see the module header for the two interleaving windows this bridges. */
  clearGraceMs?: number;
}

export interface QueueMirror {
  items(): readonly QueueItemWire[];
  /** One-shot: returns and clears the cmdIds dropped since the last call (StatusInfo.queueDropped
   * "仅下一帧携带"). */
  takeDropped(): string[];
  enqueue(entry: { text: string; deliver: "steer" | "followUp"; source: QueueSource; cmdId?: string }): QueueItemWire;
  /** FIFO dequeue by exact full text: steer first, then followUp (K17 fallback order).
   * Matches the FULL enqueue text, never the wire-clipped copy — pi's `message_start` carries
   * the whole message, and a >`clipChars` steer can never equal its own clipped wire text
   * (field bug: long steers stayed queued and the grace expiry marked them `dropped`). */
  dequeueByText(text: string): QueueItemWire | undefined;
  /** web-hub-steer-recall plan §4.4 A3 / Y7.3 (verifier r_BHFA552J P1): precise, IDENTITY-based
   * dequeue for the hold-attribution consumption step. Unlike `dequeueByText`, this NEVER matches
   * by text/FIFO position — it removes the item ONLY if one exists whose `cmdId` is EXACTLY
   * `cmdId` (and, defensively, whose text still equals `text`). A same-text TUI/other-extension
   * item (which never carries a web cmdId) or a different web item can never be mistaken for the
   * one being asked for, regardless of enqueue/consumption ordering. Returns `undefined` (queue
   * untouched) when no such item exists — the caller's contract is "dequeue NOTHING on a miss",
   * never fall back to a blind text match. */
  dequeueByCmdId(cmdId: string, text: string): QueueItemWire | undefined;
  /** `hasPendingMessages()===false` sample (§4.4 row 3): once the empty condition has persisted
   * past the grace window, clears everything and records any web-sourced cmdIds as dropped. A
   * no-op while pending is still true, the mirror is empty, or the grace is still running (the
   * first false sample only arms it; a true sample re-arms nothing and fully resets). */
  clearIfEmpty(hasPending: boolean): QueueItemWire[];
  /** Unconditional clear (§4.4 row 4: session_start/detach). Does not touch `takeDropped`'s
   * bookkeeping — callers decide what a session-boundary clear means for their own state. */
  clearAll(): QueueItemWire[];
  /** Retained full-text match keys — always equals `items().length`; any mismatch is a
   * removal-path leak (tests pin this invariant for every removal path). */
  fullTextCount(): number;
  dispose(): void;
}

let idCounter = 0;

export function createQueueMirror(deps: QueueMirrorDeps = {}): QueueMirror {
  const now = deps.now ?? Date.now;
  const clipChars = deps.clipChars ?? 200;
  const maxItems = deps.maxItems ?? 32;
  const clearGraceMs = deps.clearGraceMs ?? 1_500;
  let queue: QueueItemWire[] = [];
  let dropped: string[] = [];
  /** Full (un-clipped) enqueue text by item id — the `dequeueByText` match key. The wire `text`
   * is a display-only clipped copy (plan §4.4 "截 200 字符"), so a >`clipChars` message would
   * otherwise never match its own delivery and survive until the grace expiry marks it
   * `dropped`. Removed on every queue-removal path (overflow shift, dequeue, grace clear,
   * clearAll, dispose) so entries can't outlive their item. */
  const fullTextById = new Map<string, string>();
  /** `now()` of the first empty sample of the current empty window, `undefined` while not armed.
   * Reset by any signal of queue activity (true sample, enqueue, dequeue hit, actual clear,
   * clearAll, dispose) so a stale window can never leak into a later item's lifetime. */
  let emptySince: number | undefined;

  return {
    items: () => queue.slice(),
    takeDropped: () => {
      const d = dropped;
      dropped = [];
      return d;
    },
    enqueue(entry) {
      idCounter += 1;
      const item: QueueItemWire = {
        id: `wq${idCounter}`,
        text: entry.text.length > clipChars ? entry.text.slice(0, clipChars) : entry.text,
        deliver: entry.deliver,
        source: entry.source,
        at: now(),
      };
      if (entry.cmdId !== undefined) item.cmdId = entry.cmdId;
      queue.push(item);
      fullTextById.set(item.id, entry.text);
      if (queue.length > maxItems) {
        const evicted = queue.shift();
        if (evicted !== undefined) fullTextById.delete(evicted.id); // GC path: evicted items keep no key
      }
      emptySince = undefined; // fresh activity: a new item must never inherit a stale empty window
      return item;
    },
    dequeueByText(text) {
      let idx = queue.findIndex((q) => q.deliver === "steer" && fullTextById.get(q.id) === text);
      if (idx === -1) idx = queue.findIndex((q) => q.deliver === "followUp" && fullTextById.get(q.id) === text);
      if (idx === -1) return undefined;
      const [item] = queue.splice(idx, 1);
      if (item !== undefined) fullTextById.delete(item.id);
      emptySince = undefined; // the queue moved — re-arm on the next empty sample
      return item;
    },
    dequeueByCmdId(cmdId, text) {
      const idx = queue.findIndex((q) => q.cmdId === cmdId && fullTextById.get(q.id) === text);
      if (idx === -1) return undefined; // miss: queue left COMPLETELY untouched
      const [item] = queue.splice(idx, 1);
      if (item !== undefined) fullTextById.delete(item.id);
      emptySince = undefined;
      return item;
    },
    clearIfEmpty(hasPending) {
      if (hasPending) {
        emptySince = undefined;
        return [];
      }
      if (queue.length === 0) {
        emptySince = undefined;
        return [];
      }
      const at = now();
      if (emptySince === undefined) {
        emptySince = at; // grace armed — race windows (module header) resolve before it expires
        return [];
      }
      if (at - emptySince < clearGraceMs) return [];
      const cleared = queue;
      queue = [];
      emptySince = undefined;
      for (const item of cleared) {
        fullTextById.delete(item.id);
        if (item.cmdId !== undefined) dropped.push(item.cmdId);
      }
      return cleared;
    },
    clearAll() {
      const cleared = queue;
      queue = [];
      fullTextById.clear();
      emptySince = undefined;
      return cleared;
    },
    fullTextCount: () => fullTextById.size,
    dispose() {
      queue = [];
      dropped = [];
      fullTextById.clear();
      emptySince = undefined;
    },
  };
}
