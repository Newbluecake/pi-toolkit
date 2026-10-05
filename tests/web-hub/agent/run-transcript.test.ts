/**
 * Agent-side run-transcript service (fleet-drawer plan §4.2, F2) — fake port + fake
 * `trySend` (the agent half of §10's S1–S6): seq/gap/end protocol, snapshot/page answers,
 * terminal file path, tap caps, compat posture (no `runtx.v1` ⇒ silently inert), dispose.
 * The `trySend` result table itself lives in connection.test.ts; the 18-combo caps matrix
 * and the wire-level wiring live in wiring-control.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  createRunTranscripts,
  type RunTranscriptPort,
  type RunTxRunInfo,
} from "../../../src/web-hub/agent/run-transcript.js";
import type { SendResult } from "../../../src/web-hub/agent/connection.js";
import type { AgentFrame } from "../../../src/web-hub/protocol/messages.js";
import { RUN_TX, type RunTxReqFrame } from "../../../src/web-hub/protocol/run-transcript.js";
import { fakeTimerQueue } from "./helpers.js";

// --------------------------------------------------------------------- harness

type Listener = { onEvent(e: unknown): void; onEnd(status: string): void };
type ObserveResult = ReturnType<RunTranscriptPort["observe"]>;

interface Sent {
  frame: AgentFrame;
  droppable: boolean;
}

function msgEntry(id: string, parentId: string | null, text = "x"): unknown {
  return {
    id,
    parentId,
    type: "message",
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text }] },
  };
}

const RUN = "r_ABCDEFGH";

function req(runId = RUN, over: Partial<RunTxReqFrame> = {}): RunTxReqFrame {
  return { t: "run_tx_req", rid: "rid-1", runId, limit: 200, maxBytes: RUN_TX.maxBytes, ...over };
}

function harness(
  init: {
    enabled?: boolean;
    infos?: Record<string, RunTxRunInfo | undefined>;
    branches?: Record<string, readonly unknown[] | undefined>;
    observe?: (runId: string, l: Listener) => ObserveResult;
  } = {},
) {
  const sent: Sent[] = [];
  const scripted: SendResult[] = [];
  let defaultResult: SendResult = "written";
  let enabled = init.enabled ?? true;
  let now = 1_000_000;
  const timers = fakeTimerQueue();
  const observeCalls: string[] = [];
  const detaches: string[] = [];
  const port: RunTranscriptPort = {
    info: (runId) => init.infos?.[runId],
    branch: (runId) => init.branches?.[runId],
    observe: (runId, l) => {
      observeCalls.push(runId);
      return init.observe !== undefined ? init.observe(runId, l) : { kind: "unknown" };
    },
  };
  const rt = createRunTranscripts({
    port: () => port,
    trySend: (frame, o) => {
      sent.push({ frame, droppable: o?.droppable === true });
      return scripted.length > 0 ? scripted.shift()! : defaultResult;
    },
    enabled: () => enabled,
    now: () => now,
    setTimer: timers.setTimer,
  });
  return {
    rt,
    sent,
    scripted,
    observeCalls,
    detaches,
    frames: () => sent.map((s) => s.frame),
    types: () => sent.map((s) => s.frame.t),
    setEnabled: (v: boolean) => {
      enabled = v;
    },
    setResult: (r: SendResult) => {
      defaultResult = r;
    },
    advance: (ms: number) => {
      now += ms;
    },
    timers,
  };
}

const liveRun: RunTxRunInfo = { status: "running", terminal: false };
const termRun = (over: Partial<RunTxRunInfo> = {}): RunTxRunInfo => ({
  status: "completed",
  terminal: true,
  ...over,
});

// ------------------------------------------------------------------ compat (§3.2)

describe("compat posture (§3.2 matrix: no runtx.v1 / setting off ⇒ silently inert)", () => {
  it("enabled() false ⇒ run_tx_req gets no reply and run_watch never touches the port", () => {
    const h = harness({ enabled: false, infos: { [RUN]: liveRun } });
    h.rt.onReq(req());
    h.rt.onWatch(RUN, true);
    h.rt.tick();
    expect(h.sent).toEqual([]);
    expect(h.observeCalls).toEqual([]);
  });

  it("flipping enabled off mid-flight ⇒ run_watch is ignored, no tap is created", () => {
    const h = harness({ infos: { [RUN]: liveRun } });
    h.setEnabled(false);
    h.rt.onWatch(RUN, true);
    expect(h.observeCalls).toEqual([]);
  });

  it("link-up WITHOUT the cap tears every tap down instead of leaking frames", () => {
    const bag: { l?: Listener } = {};
    const h = harness({
      infos: { [RUN]: liveRun },
      observe: (_id, l) => {
        bag.l = l;
        return { kind: "attached", detach: () => h.detaches.push(_id) };
      },
    });
    h.rt.onWatch(RUN, true);
    expect(h.observeCalls).toEqual([RUN]);
    h.setEnabled(false); // e.g. the new link's hello_ack.caps lacks runtx.v1
    h.rt.onLink(true);
    expect(h.detaches).toEqual([RUN]);
    bag.l?.onEvent({ type: "turn_start", turnIndex: 1 });
    h.rt.tick();
    expect(h.sent).toEqual([]); // no frames ever left the torn-down tap
  });
});

// ---------------------------------------------------------------------- onReq

describe("onReq — deterministic answers", () => {
  it("unknown run ⇒ E_NOT_FOUND/unknown_run", () => {
    const h = harness();
    h.rt.onReq(req());
    expect(h.frames()).toEqual([
      { t: "run_tx_reply", rid: "rid-1", runId: RUN, ok: false, code: "E_NOT_FOUND", reason: "unknown_run" },
    ]);
  });

  it("terminal without sessionFile ⇒ not_persisted", () => {
    const h = harness({ infos: { [RUN]: termRun() } });
    h.rt.onReq(req());
    expect(h.frames()[0]).toMatchObject({ ok: false, code: "E_NOT_FOUND", reason: "not_persisted" });
  });

  it("terminal with sessionFile but no finalLeafId ⇒ leaf_unknown", () => {
    const h = harness({ infos: { [RUN]: termRun({ sessionFile: "/tmp/s.jsonl" }) } });
    h.rt.onReq(req());
    expect(h.frames()[0]).toMatchObject({ ok: false, code: "E_NOT_FOUND", reason: "leaf_unknown" });
  });

  it("terminal with both ⇒ source:file reply carrying sessionFile + finalLeafId", () => {
    const h = harness({
      infos: { [RUN]: termRun({ status: "timed_out", sessionFile: "/tmp/s.jsonl", finalLeafId: "leaf-9" }) },
    });
    h.rt.onReq(req());
    expect(h.frames()[0]).toEqual({
      t: "run_tx_reply",
      rid: "rid-1",
      runId: RUN,
      ok: true,
      source: "file",
      status: "timed_out",
      sessionFile: "/tmp/s.jsonl",
      finalLeafId: "leaf-9",
    });
  });

  it("terminal goes the file path UNCONDITIONALLY, even while a tap is attached", () => {
    const a =
      (bag: { l?: Listener }) =>
      (runId: string, l: Listener): ObserveResult => {
        bag.l = l;
        return { kind: "attached", detach: () => undefined };
      };
    const bag: { l?: Listener } = {};
    const h = harness({
      infos: { [RUN]: termRun({ sessionFile: "/tmp/s.jsonl", finalLeafId: "L" }) },
      observe: a(bag),
    });
    h.rt.onWatch(RUN, true); // tap attached while the run was live
    h.rt.onReq(req());
    expect(h.frames()[0]).toMatchObject({ ok: true, source: "file", sessionFile: "/tmp/s.jsonl" });
  });

  it("live snapshot without a tap: tail projection, seq 0, no tapId, watching:false", () => {
    const branch = [msgEntry("e1", null), msgEntry("e2", "e1"), msgEntry("e3", "e2")];
    const h = harness({ infos: { [RUN]: liveRun }, branches: { [RUN]: branch } });
    h.rt.onReq(req(RUN, { limit: 2 }));
    const f = h.frames()[0] as Extract<AgentFrame, { t: "run_tx_reply" }>;
    expect(f).toMatchObject({
      ok: true,
      source: "live",
      status: "running",
      seq: 0,
      watching: false,
      hasMore: true,
      truncated: false,
    });
    expect(f).not.toHaveProperty("tapId");
    expect(f).not.toHaveProperty("inflight");
    if (f.ok && f.source === "live") expect(f.entries.map((e) => e.id)).toEqual(["e2", "e3"]);
  });

  it("live snapshot walks the tail until the byte budget and marks truncated", () => {
    const big = "z".repeat(4 * 1024);
    const branch = [msgEntry("e1", null, big), msgEntry("e2", "e1", big), msgEntry("e3", "e2", big)];
    const h = harness({ infos: { [RUN]: liveRun }, branches: { [RUN]: branch } });
    h.rt.onReq(req(RUN, { limit: 200, maxBytes: 6 * 1024 }));
    const f = h.frames()[0] as Extract<AgentFrame, { t: "run_tx_reply" }>;
    expect(f).toMatchObject({ ok: true, truncated: true, hasMore: true });
    if (f.ok && f.source === "live") expect(f.entries.map((e) => e.id)).toEqual(["e3"]); // newest first under budget
  });

  it("clamps maxBytes to RUN_TX.maxBytes (= LIMITS.branchReplyBytes)", () => {
    const chunk = "z".repeat(60 * 1024);
    const branch = Array.from({ length: 60 }, (_, i) => msgEntry(`e${i}`, i === 0 ? null : `e${i - 1}`, chunk));
    const h = harness({ infos: { [RUN]: liveRun }, branches: { [RUN]: branch } });
    h.rt.onReq(req(RUN, { limit: 400, maxBytes: 8 << 20 })); // hub asks for more than the cap
    const f = h.frames()[0] as Extract<AgentFrame, { t: "run_tx_reply" }>;
    if (f.ok && f.source === "live") {
      const bytes = f.entries.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e)) + 1, 0);
      expect(bytes).toBeLessThanOrEqual(RUN_TX.maxBytes);
      expect(f.truncated).toBe(true);
      expect(f.entries.at(-1)!.id).toBe("e59");
    } else {
      expect.unreachable();
    }
  });

  it("page with before slices strictly older entries; unknown before ⇒ E_NOT_FOUND/leaf_missing", () => {
    const branch = [msgEntry("e1", null), msgEntry("e2", "e1"), msgEntry("e3", "e2"), msgEntry("e4", "e3")];
    const h = harness({ infos: { [RUN]: liveRun }, branches: { [RUN]: branch } });
    h.rt.onReq(req(RUN, { before: "e3", limit: 10 }));
    const f = h.frames()[0] as Extract<AgentFrame, { t: "run_tx_reply" }>;
    if (f.ok && f.source === "live") {
      expect(f.entries.map((e) => e.id)).toEqual(["e1", "e2"]);
      expect(f.hasMore).toBe(false);
    } else {
      expect.unreachable();
    }
    h.rt.onReq(req(RUN, { before: "nope", rid: "rid-2" }));
    expect(h.frames()[1]).toMatchObject({ rid: "rid-2", ok: false, code: "E_NOT_FOUND", reason: "leaf_missing" });
  });

  it("branch() undefined ⇒ re-reads info once and takes the terminal path (settle race)", () => {
    let reads = 0;
    const port: RunTranscriptPort = {
      info: () => {
        reads += 1;
        return reads === 1 ? liveRun : termRun({ sessionFile: "/tmp/s.jsonl", finalLeafId: "L" });
      },
      branch: () => undefined,
      observe: () => ({ kind: "unknown" }),
    };
    const sent: AgentFrame[] = [];
    const rt = createRunTranscripts({
      port: () => port,
      trySend: (f) => {
        sent.push(f);
        return "written";
      },
      enabled: () => true,
      now: () => 0,
      setTimer: () => ({ cancel: () => undefined }),
    });
    rt.onReq(req());
    expect(reads).toBe(2);
    expect(sent[0]).toMatchObject({ ok: true, source: "file", sessionFile: "/tmp/s.jsonl" });
  });

  it("branch() undefined while still running ⇒ empty live snapshot (nothing persisted yet)", () => {
    const h = harness({ infos: { [RUN]: liveRun }, branches: {} });
    h.rt.onReq(req());
    const f = h.frames()[0] as Extract<AgentFrame, { t: "run_tx_reply" }>;
    expect(f).toMatchObject({ ok: true, source: "live", watching: false, hasMore: false, truncated: false });
    if (f.ok && f.source === "live") expect(f.entries).toEqual([]);
  });
});

// ------------------------------------------------------------------ watch / taps

describe("onWatch — tap lifecycle", () => {
  it("attaches once (idempotent) and streams events with seq from 1", () => {
    const bag: { l?: Listener } = {};
    const h = harness({
      infos: { [RUN]: liveRun },
      observe: (_id, l) => {
        bag.l = l;
        return { kind: "attached", detach: () => h.detaches.push(_id) };
      },
    });
    h.rt.onWatch(RUN, true);
    h.rt.onWatch(RUN, true);
    expect(h.observeCalls).toEqual([RUN]);
    bag.l!.onEvent({ type: "turn_start", turnIndex: 1 });
    bag.l!.onEvent({ type: "turn_end", turnIndex: 1 });
    const evs = h.frames().filter((f) => f.t === "run_ev") as Array<Extract<AgentFrame, { t: "run_ev" }>>;
    expect(evs.map((f) => f.seq)).toEqual([1, 2]);
    expect(evs[0]!.e.type).toBe("turn_start");
    expect(evs.every((f) => typeof f.tapId === "string" && f.tapId.length >= 8)).toBe(true);
    expect(h.sent.every((s) => s.droppable === false)).toBe(true);
  });

  it("droppable deltas flow with the droppable flag set", () => {
    const bag: { l?: Listener } = {};
    const h = harness({
      infos: { [RUN]: liveRun },
      observe: (_id, l) => {
        bag.l = l;
        return { kind: "attached", detach: () => undefined };
      },
    });
    h.rt.onWatch(RUN, true);
    bag.l!.onEvent({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi" },
    });
    h.timers.fireByMs(50); // event-tap's delta coalescing window
    const ev = h.frames().find((f) => f.t === "run_ev");
    expect(ev).toBeDefined();
    expect(h.sent.find((s) => s.frame === ev)?.droppable).toBe(true);
  });

  it("terminal / no_session / unknown observe verdicts create no tap; snapshot tells the truth", () => {
    for (const kind of ["terminal", "no_session", "unknown"] as const) {
      const h = harness({
        infos: { [RUN]: liveRun },
        branches: { [RUN]: [msgEntry("e1", null)] },
        observe: () => (kind === "terminal" ? { kind, status: "completed" } : { kind }),
      });
      h.rt.onWatch(RUN, true);
      h.rt.onReq(req());
      const f = h.frames()[0] as Extract<AgentFrame, { t: "run_tx_reply" }>;
      expect(f, kind).toMatchObject({ ok: true, source: "live", watching: false, seq: 0 });
    }
  });

  it("tap cap (tapsPerAgent) ⇒ the 9th watch attaches nothing and snapshots say watching:false", () => {
    const h = harness({
      infos: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`r_RUN000${i}`, liveRun])),
      branches: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`r_RUN000${i}`, []])),
      observe: () => ({ kind: "attached", detach: () => undefined }),
    });
    for (let i = 0; i < 9; i++) h.rt.onWatch(`r_RUN000${i}`, true);
    expect(h.observeCalls).toHaveLength(RUN_TX.tapsPerAgent); // 8 attached, 9th refused
    h.rt.onReq(req("r_RUN0008"));
    expect(h.frames()[0]).toMatchObject({ ok: true, watching: false });
  });

  it("watch(false) detaches + disposes the tap and drops its pending end", () => {
    const bag: { l?: Listener } = {};
    const h = harness({
      infos: { [RUN]: liveRun },
      observe: (_id, l) => {
        bag.l = l;
        return { kind: "attached", detach: () => h.detaches.push(_id) };
      },
    });
    h.rt.onWatch(RUN, true);
    h.setResult("not_live");
    bag.l!.onEnd("completed"); // end cannot be delivered ⇒ parked
    h.setResult("written");
    h.rt.onWatch(RUN, false);
    expect(h.detaches).toEqual([RUN]);
    const before = h.sent.length;
    h.rt.tick(); // the parked end for this run was dropped with the unwatch
    expect(h.sent.length).toBe(before);
  });

  it("resetForSession() detaches every tap; old taps stay dead but the service answers again (P1: reset, not kill)", () => {
    const bags: Array<{ l?: Listener }> = [];
    const h = harness({
      infos: { [RUN]: liveRun },
      branches: { [RUN]: [msgEntry("e1", null)] },
      observe: (_id, l) => {
        bags.push({ l });
        return { kind: "attached", detach: () => h.detaches.push(_id) };
      },
    });
    h.rt.onWatch(RUN, true);
    h.rt.resetForSession(); // session_shutdown of /new・/resume・/fork inside the same activation
    expect(h.detaches).toEqual([RUN]);
    bags[0]!.l!.onEvent({ type: "turn_start", turnIndex: 99 }); // stale tap: dropped
    bags[0]!.l!.onEnd("completed");
    expect(h.sent).toEqual([]);
    // …and the NEXT session's watch/req work normally (the P1 regression was a permanent kill):
    h.rt.onWatch(RUN, true);
    expect(h.observeCalls).toEqual([RUN, RUN]);
    bags[1]!.l!.onEvent({ type: "turn_start", turnIndex: 1 });
    h.rt.onReq(req());
    expect(h.types()).toEqual(["run_ev", "run_tx_reply"]);
    expect(h.frames()[1]).toMatchObject({ ok: true, source: "live", watching: true, seq: 1 });
  });
});

// ------------------------------------------------------------------ seq / gap

describe("seq/gap protocol (§3.3, agent half of S1–S3)", () => {
  function watched(h: ReturnType<typeof harness>, bag: { l?: Listener }): void {
    void bag;
    h.rt.onWatch(RUN, true);
  }

  function turn(bag: { l?: Listener }, n: number): void {
    bag.l!.onEvent({ type: "turn_start", turnIndex: n });
  }

  it("a lost event folds into firstMissing; the next send is preceded by run_gap (min-merge)", () => {
    const bag: { l?: Listener } = {};
    const h = harness({
      infos: { [RUN]: liveRun },
      observe: (_id, l) => {
        bag.l = l;
        return { kind: "attached", detach: () => undefined };
      },
    });
    watched(h, bag);
    turn(bag, 1); // seq 1, written
    h.scripted.push("not_live"); // seq 2 lost
    turn(bag, 2);
    h.scripted.push("not_live"); // gap retry (before seq 3) also lost
    h.scripted.push("dropped"); // seq 3 lost too
    turn(bag, 3);
    h.scripted.push("written"); // gap before seq 4 succeeds
    turn(bag, 4);
    expect(h.types()).toEqual(["run_ev", "run_ev", "run_gap", "run_ev", "run_gap", "run_ev"]);
    const gaps = h.frames().filter((f) => f.t === "run_gap") as Array<Extract<AgentFrame, { t: "run_gap" }>>;
    expect(gaps.map((g) => g.fromSeq)).toEqual([2, 2]); // min-merged, never the later loss
    expect(h.sent.filter((s) => s.frame.t === "run_gap").every((s) => s.droppable === false)).toBe(true);
  });

  it("tick and link-up retry an outstanding gap until it is written", () => {
    const bag: { l?: Listener } = {};
    const h = harness({
      infos: { [RUN]: liveRun },
      observe: (_id, l) => {
        bag.l = l;
        return { kind: "attached", detach: () => undefined };
      },
    });
    h.rt.onWatch(RUN, true);
    h.scripted.push("not_live");
    turn(bag, 1); // seq 1 lost ⇒ firstMissing=1
    h.scripted.push("not_live");
    h.rt.tick(); // gap attempt fails
    h.scripted.push("not_live");
    h.rt.onLink(true); // link-up attempt fails
    h.rt.tick(); // unscripted ⇒ written
    expect(h.types()).toEqual(["run_ev", "run_gap", "run_gap", "run_gap"]);
    // cleared: no more gaps on subsequent ticks
    h.rt.tick();
    expect(h.types()).toHaveLength(4);
  });
});

// ------------------------------------------------------------------ end (§3.3 #4)

describe("run_end delivery (agent half of S4–S6)", () => {
  function endable(infos: Record<string, RunTxRunInfo> = { [RUN]: liveRun }) {
    const bag: { l?: Listener } = {};
    const h = harness({
      infos,
      observe: (_id, l) => {
        bag.l = l;
        return { kind: "attached", detach: () => h.detaches.push(_id) };
      },
    });
    return { h, bag };
  }

  it("end: flush → gap → run_end(lastSeq = final counter); tap leaves the map", () => {
    const { h, bag } = endable();
    h.rt.onWatch(RUN, true);
    bag.l!.onEvent({ type: "turn_start", turnIndex: 1 });
    bag.l!.onEnd("completed");
    const end = h.frames().at(-1) as Extract<AgentFrame, { t: "run_end" }>;
    expect(end).toMatchObject({ t: "run_end", runId: RUN, lastSeq: 1, status: "completed" });
    expect(h.detaches).toEqual([RUN]);
    h.rt.tick(); // nothing pending afterwards
    expect(h.frames().at(-1)).toBe(end);
  });

  it("end flushes pending deltas first — they occupy seqs BELOW lastSeq", () => {
    const { h, bag } = endable();
    h.rt.onWatch(RUN, true);
    bag.l!.onEvent({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "tail" },
    });
    bag.l!.onEnd("completed"); // flush() inside endTap sends the delta as seq 1
    const types = h.types();
    expect(types).toEqual(["run_ev", "run_end"]);
    const end = h.frames()[1] as Extract<AgentFrame, { t: "run_end" }>;
    expect(end.lastSeq).toBe(1);
  });

  it("end never overtakes an unsent gap; parked end retries gap-first on tick (S5)", () => {
    const { h, bag } = endable();
    h.rt.onWatch(RUN, true);
    h.scripted.push("not_live");
    bag.l!.onEvent({ type: "turn_start", turnIndex: 1 }); // seq 1 lost
    h.scripted.push("not_live"); // gap at end-time fails too
    bag.l!.onEnd("failed"); // parked with firstMissing=1, no run_end yet
    expect(h.types()).toEqual(["run_ev", "run_gap"]);
    h.scripted.push("written", "written");
    h.rt.tick(); // gap, then end — in that order
    expect(h.types()).toEqual(["run_ev", "run_gap", "run_gap", "run_end"]);
    const end = h.frames().at(-1) as Extract<AgentFrame, { t: "run_end" }>;
    expect(end).toMatchObject({ lastSeq: 1, status: "failed" });
  });

  it("a lost run_end is retried from endedPending on link-up (S5)", () => {
    const { h, bag } = endable();
    h.rt.onWatch(RUN, true);
    bag.l!.onEvent({ type: "turn_start", turnIndex: 1 });
    h.scripted.push("not_live"); // run_end lost (link down)
    bag.l!.onEnd("completed");
    h.rt.onLink(true);
    expect(h.types()).toEqual(["run_ev", "run_end", "run_end"]);
  });

  it("endedPending TTL: entries older than endPendingTtlMs are evicted, never retried", () => {
    const { h, bag } = endable();
    h.rt.onWatch(RUN, true);
    h.scripted.push("not_live");
    bag.l!.onEnd("completed");
    h.advance(RUN_TX.endPendingTtlMs + 1);
    h.rt.tick();
    h.rt.onLink(true);
    expect(h.types()).toEqual(["run_end"]); // only the original failed attempt
  });

  it("TTL boundary (P2): age EXACTLY endPendingTtlMs is kept (eviction is strict `>`), +1ms evicts", () => {
    // Semantics: `retryEndedPending` evicts only when `now - since > endPendingTtlMs`, so an
    // entry whose age equals the TTL exactly is still inside its redelivery window and MUST
    // be retried; one millisecond later it is stale and dropped without another attempt.
    const { h, bag } = endable();
    h.rt.onWatch(RUN, true);
    h.scripted.push("not_live"); // the original run_end attempt fails ⇒ parked
    bag.l!.onEnd("completed");
    h.advance(RUN_TX.endPendingTtlMs); // age == TTL exactly ⇒ still retained
    h.scripted.push("not_live");
    h.rt.tick();
    expect(h.types()).toEqual(["run_end", "run_end"]); // the retry DID happen
    h.advance(1); // age == TTL + 1 ⇒ over the line
    h.rt.tick();
    h.rt.onLink(true);
    expect(h.types()).toEqual(["run_end", "run_end"]); // no third attempt
  });

  it("endedPending is FIFO-capped at endPendingMax", () => {
    const bags: Array<{ l?: Listener }> = [];
    const h = harness({
      observe: (_id, l) => {
        const bag: { l?: Listener } = { l };
        bags.push(bag);
        return { kind: "attached", detach: () => undefined };
      },
    });
    const total = RUN_TX.endPendingMax + 1;
    h.setResult("not_live");
    for (let i = 0; i < total; i++) {
      const runId = `r_RUNEND${String(i).padStart(2, "0")}`;
      h.rt.onWatch(runId, true);
      bags[i]!.l!.onEnd("completed"); // parked; tap leaves the map, so the 8-tap cap never trips
    }
    h.setResult("written");
    const before = h.frames().length;
    h.rt.tick();
    const retried = h.frames().slice(before);
    const ends = retried.filter((f) => f.t === "run_end") as Array<Extract<AgentFrame, { t: "run_end" }>>;
    expect(ends.map((f) => f.runId)).not.toContain("r_RUNEND00"); // oldest evicted at the cap
    expect(ends).toHaveLength(RUN_TX.endPendingMax);
  });

  it("a duplicate onEnd is ignored (exactly-once)", () => {
    const { h, bag } = endable();
    h.rt.onWatch(RUN, true);
    bag.l!.onEnd("completed");
    bag.l!.onEnd("completed");
    expect(h.frames().filter((f) => f.t === "run_end")).toHaveLength(1);
  });
});

// --------------------------------------------------------------- snapshot + tap

describe("live snapshot with an attached tap (§3.3 #5)", () => {
  it("flush → watermark → branch → inflight in the same tick; reply carries tapId + inflight", () => {
    const bag: { l?: Listener } = {};
    const h = harness({
      infos: { [RUN]: liveRun },
      branches: { [RUN]: [msgEntry("e1", null), msgEntry("e2", "e1")] },
      observe: (_id, l) => {
        bag.l = l;
        return { kind: "attached", detach: () => undefined };
      },
    });
    h.rt.onWatch(RUN, true);
    bag.l!.onEvent({ type: "turn_start", turnIndex: 1 }); // seq 1 on the wire
    bag.l!.onEvent({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } }); // seq 2
    // a still-coalesced delta: only the snapshot's flush() puts it on the wire
    bag.l!.onEvent({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "pending" },
    });
    h.rt.onReq(req());
    const frames = h.frames();
    const flushed = frames[2] as Extract<AgentFrame, { t: "run_ev" }>;
    expect(flushed).toMatchObject({ t: "run_ev", seq: 3 }); // the delta got its seq BEFORE the watermark was read
    const reply = frames[3] as Extract<AgentFrame, { t: "run_tx_reply" }>;
    expect(reply).toMatchObject({ ok: true, source: "live", seq: 3, watching: true });
    if (reply.ok && reply.source === "live") {
      expect(reply.tapId).toBe(flushed.tapId);
      expect(reply.entries.map((e) => e.id)).toEqual(["e1", "e2"]);
      expect(reply.inflight?.tools.map((t) => t.toolCallId)).toEqual(["c1"]);
    }
  });

  it("unwatch between watch and snapshot ⇒ watching:false, seq 0, no tapId", () => {
    const h = harness({
      infos: { [RUN]: liveRun },
      branches: { [RUN]: [] },
      observe: () => ({ kind: "attached", detach: () => undefined }),
    });
    h.rt.onWatch(RUN, true);
    h.rt.onWatch(RUN, false);
    h.rt.onReq(req());
    const f = h.frames()[0] as Extract<AgentFrame, { t: "run_tx_reply" }>;
    expect(f).toMatchObject({ ok: true, watching: false, seq: 0 });
    expect(f).not.toHaveProperty("tapId");
  });
});

// ------------------------------------------------------------------------ misc

describe("robustness", () => {
  it("a throwing port is contained (no frames, no throw)", () => {
    const rt = createRunTranscripts({
      port: () => {
        throw new Error("stale stack");
      },
      trySend: () => "written",
      enabled: () => true,
      now: () => 0,
      setTimer: () => ({ cancel: () => undefined }),
    });
    expect(() => rt.onWatch(RUN, true)).not.toThrow();
    expect(() => rt.onReq(req())).not.toThrow();
    expect(() => rt.tick()).not.toThrow();
    expect(() => rt.resetForSession()).not.toThrow();
  });

  it("new tapIds are random per attach (TAP_ID_PATTERN shape)", () => {
    const bags: Array<{ l?: Listener }> = [];
    const h = harness({
      observe: (_id, l) => {
        bags.push({ l });
        return { kind: "attached", detach: () => undefined };
      },
    });
    for (let i = 0; i < 4; i++) {
      h.rt.onWatch(RUN, true);
      bags[i]!.l!.onEvent({ type: "turn_start", turnIndex: i });
      h.rt.onWatch(RUN, false);
    }
    const tapIds = h
      .frames()
      .map((f) => (f.t === "run_ev" ? f.tapId : ""))
      .filter((t) => t !== "");
    expect(new Set(tapIds).size).toBe(4);
    for (const id of tapIds) expect(id).toMatch(/^[A-Za-z0-9_-]{8,32}$/);
  });
});
