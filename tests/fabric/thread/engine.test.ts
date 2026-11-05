import { beforeEach, describe, expect, it } from "vitest";
import { flushMicrotasks, H1, H2, makeHarness, primeWorld, RUN_A, RUN_B, type Harness } from "./harness.js";

describe("ThreadEngine · decision rows (§6.3)", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it("R0: untrusted origin / no thread meta / invalid meta / header mismatch ⇒ native, no counters, no steers", () => {
    primeWorld(h);
    for (const patch of [
      { trustedOrigin: false },
      { hasThreadMeta: false },
      { threadMetaValid: false },
      { headerOk: false },
    ]) {
      const res = h.engine.handleEvent(h.event(patch));
      expect(res).toMatchObject({ action: "native", decision: { rule: "R0" } });
    }
    expect(h.steers.length).toBe(0);
    expect(h.engine.stats()).toMatchObject({ slow: 0, laneFull: 0, budget: 0, routed: 0 });
  });

  it("R1: bypass ⇒ native even with a live subscriber", () => {
    primeWorld(h);
    const res = h.engine.handleEvent(h.event({ bypass: true }));
    expect(res).toMatchObject({ action: "native", decision: { rule: "R1", reason: "bypass" } });
    expect(h.steers.length).toBe(0);
  });

  it("R2: no live subscriber ⇒ slow+1", () => {
    h.engine.noteThread(H1, "topic");
    const res = h.engine.handleEvent(h.event());
    expect(res).toMatchObject({ action: "native", decision: { rule: "R2" } });
    expect(h.engine.stats().slow).toBe(1);
  });

  it("R3: addressed_other ⇒ native (no counter)", () => {
    primeWorld(h);
    const res = h.engine.handleEvent(h.event({ addressedOther: true }));
    expect(res).toMatchObject({ action: "native", decision: { rule: "R3" } });
    expect(h.engine.stats().slow).toBe(0);
  });

  it("R6: short frame deadlines ⇒ native, budget+1, ZERO steer calls (S12)", () => {
    primeWorld(h);
    expect(h.engine.handleEvent(h.event({ frameDeadlineMs: 1500 }))).toMatchObject({
      decision: { rule: "R6" },
    });
    expect(h.engine.handleEvent(h.event({ frameDeadlineMs: 1900 }))).toMatchObject({
      decision: { rule: "R6" },
    });
    expect(h.steers.length).toBe(0);
    expect(h.engine.stats().budget).toBe(2);
  });

  it("R4: hourly cap reached ⇒ native + display hint once per hour", () => {
    h = makeHarness({ routedPerThreadPerHour: 0 });
    primeWorld(h);
    expect(h.engine.handleEvent(h.event())).toMatchObject({ decision: { rule: "R4" } });
    expect(h.engine.handleEvent(h.event())).toMatchObject({ decision: { rule: "R4" } });
    expect(h.hints.length).toBe(1); // ≤1/hour/thread
    expect(h.steers.length).toBe(0);
  });

  it("R5: lane wait full ⇒ lane_full+1 (laneWait=0)", () => {
    h = makeHarness({ laneWait: 0 });
    primeWorld(h);
    // event 1 enters fan-out (its steer hangs — never settled)
    expect(h.engine.handleEvent(h.event())).toMatchObject({ action: "lane" });
    expect(h.steers.length).toBe(1);
    // event 2 cannot even wait
    expect(h.engine.handleEvent(h.event())).toMatchObject({
      action: "native",
      decision: { rule: "R5", reason: "lane_wait_full" },
    });
    expect(h.engine.stats().laneFull).toBe(1);
  });
});

describe("ThreadEngine · R7 happy path (§6.4/§6.7)", () => {
  it("steers with the remaining budget; queued ⇒ early routed reply with runs", async () => {
    const h = makeHarness();
    primeWorld(h);
    const e = h.event();
    const res = h.engine.handleEvent(e);
    expect(res).toMatchObject({ action: "lane", deadlineAt: 4000 });
    expect(h.steers.length).toBe(1);
    expect(h.steers[0]).toMatchObject({ runId: RUN_A, text: "wrapper-1", capMs: 4000 });
    h.settleAll("queued");
    await flushMicrotasks();
    expect(h.routed).toEqual([{ eventId: e.eventId, runs: [{ runId: RUN_A, label: "worker-a" }] }]);
    expect(h.native).toEqual([]);
    const stats = h.engine.stats();
    expect(stats.routed).toBe(1);
    expect(stats.unknown).toBe(0);
    const record = h.engine.inspectRecord(e.eventId);
    expect(record?.replyKind).toBe("routed");
    expect(record?.perSub.get("t1")).toBe("queued");
    expect(record?.judged).toBe(true);
  });

  it("handled ⇒ unknown (r3-3): routed reply, never a native release", async () => {
    const h = makeHarness();
    primeWorld(h);
    h.engine.handleEvent(h.event());
    h.settleAll("handled");
    await flushMicrotasks();
    expect(h.routed.length).toBe(1);
    expect(h.native).toEqual([]);
    expect(h.engine.stats().unknown).toBe(1);
    expect(h.engine.inspectRecord(h.routed[0]!.eventId)?.perSub.get("t1")).toBe("unknown");
  });

  it("steer rejection ⇒ unknown ⇒ routed reply", async () => {
    const h = makeHarness();
    primeWorld(h);
    h.engine.handleEvent(h.event());
    h.steers[0]!.reject(new Error("boom"));
    await flushMicrotasks();
    expect(h.routed.length).toBe(1);
    expect(h.native).toEqual([]);
    expect(h.engine.stats().unknown).toBe(1);
    expect(h.audits.some((a) => a.kind === "steer-error")).toBe(true);
  });

  it("dedup: a duplicate eventId answers from the record, never re-fans-out (§6.5)", async () => {
    const h = makeHarness();
    primeWorld(h);
    const first = h.event();
    h.engine.handleEvent(first);
    const dup = h.engine.handleEvent(first);
    expect(dup).toMatchObject({ action: "deduped", replied: false });
    expect(h.steers.length).toBe(1);
    expect(h.engine.stats().deduped).toBe(1);
    h.settleAll("queued");
    await flushMicrotasks();
    const after = h.engine.handleEvent(first);
    expect(after).toMatchObject({ action: "deduped", replied: true, replyKind: "routed" });
    expect(h.steers.length).toBe(1);
    expect(h.routed.length).toBe(1);
  });
});

describe("ThreadEngine · S11 lane queue over budget", () => {
  it("event 2 removed at ITS deadline ⇒ native; event 1 late ⇒ unknown ⇒ routed", async () => {
    const h = makeHarness();
    primeWorld(h);
    const e1 = h.event();
    const e2 = h.event();
    h.engine.handleEvent(e1); // steer hangs (we never settle)
    expect(h.steers.length).toBe(1);
    const res2 = h.engine.handleEvent(e2);
    expect(res2).toMatchObject({ action: "lane" }); // waits in the lane
    expect(h.steers.length).toBe(1);
    await h.tick(4000); // both deadlines fire (e1's timer first)
    expect(h.native).toEqual([e2.eventId]);
    expect(h.routed.map((r) => r.eventId)).toEqual([e1.eventId]);
    expect(h.engine.inspectRecord(e1.eventId)?.perSub.get("t1")).toBe("unknown");
    expect(h.engine.inspectRecord(e2.eventId)?.perSub.get("t1")).toBe("none");
    expect(h.engine.stats().laneTimeout).toBe(1);
    expect(h.steers.length).toBe(1); // e1's steer promise is still pending — abandoned, audit-only
    // a late settle now only upgrades the display state; the reply never changes (§6.5)
    h.settleAll("queued");
    await flushMicrotasks();
    expect(h.routed.length).toBe(1);
    expect(h.engine.inspectRecord(e1.eventId)?.perSub.get("t1")).toBe("unknown");
    expect(h.engine.inspectRecord(e1.eventId)?.displayUpgradedTo).toBe("queued");
    expect(h.audits.some((a) => a.kind === "late-steer")).toBe(true);
  });
});

describe("ThreadEngine · buffers & flush (§6.5)", () => {
  it("queued run ⇒ buffered; first reply at deadline (routed); first running snapshot flushes FIFO", async () => {
    const h = makeHarness();
    primeWorld(h, { runStatus: "queued" });
    const e1 = h.event();
    h.engine.handleEvent(e1);
    expect(h.steers.length).toBe(0); // buffered, not steered
    await h.tick(4000); // e1 deadline ⇒ routed reply (buffered ∈ observed)
    expect(h.routed.map((r) => r.eventId)).toEqual([e1.eventId]);
    expect(h.routed[0]!.runs).toEqual([{ runId: RUN_A, label: "worker-a" }]);
    const record = h.engine.inspectRecord(e1.eventId);
    expect(record?.perSub.get("t1")).toBe("buffered");
    expect(record?.deliveredAt).toBe(4000);
    // run reaches running ⇒ flush (single steer cap = steerTimeoutMs, no frame deadline)
    h.facts.set(RUN_A, { direct: true, status: "running", steerable: true });
    h.engine.onRunSnapshot(RUN_A, "running");
    expect(h.steers.length).toBe(1);
    expect(h.steers[0]).toMatchObject({ runId: RUN_A, text: "wrapper-1", capMs: 4000 });
    h.settleAll("queued");
    await flushMicrotasks();
    expect(h.engine.inspectRecord(e1.eventId)?.perSub.get("t1")).toBe("queued");
    expect(h.routed.length).toBe(1); // no second reply
  });

  it("buffer overflow (5th event) ⇒ none for that subscriber ⇒ fallback native (§6.5)", async () => {
    const h = makeHarness();
    primeWorld(h, { runStatus: "queued" });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const e = h.event();
      ids.push(e.eventId);
      h.engine.handleEvent(e);
      await h.tick(4000); // each gets its routed reply and frees the lane
    }
    const fifth = h.engine.inspectRecord(ids[4]!)!;
    expect(fifth.perSub.get("t1")).toBe("none");
    expect(fifth.replyKind).toBe("fallback");
    expect(h.native).toEqual([ids[4]]);
    // the first four are still buffered (custody at the buffer)
    for (let i = 0; i < 4; i++) {
      expect(h.engine.inspectRecord(ids[i]!)?.perSub.get("t1")).toBe("buffered");
    }
  });

  it("buffer TTL: earliest deliveredAt + startTimeoutMin ⇒ start_timeout + all buffered none + auto-return", async () => {
    const h = makeHarness({ startTimeoutMin: 8 });
    primeWorld(h, { runStatus: "queued" });
    const e1 = h.event();
    h.engine.handleEvent(e1);
    await h.tick(4000); // routed reply ⇒ deliveredAt=4000 anchors the TTL
    expect(h.autoReturns).toEqual([]); // buffered ⇒ await_pending
    await h.tick(8 * 60_000); // TTL fires (FakeClock: exactly at expiry)
    const sub = h.engine.inspectSubscriptions()[0]!;
    expect(sub.state).toBe("ended");
    expect(sub.endReason).toBe("start_timeout");
    const record = h.engine.inspectRecord(e1.eventId);
    expect(record?.perSub.get("t1")).toBe("none");
    // routed event whose ONLY subscriber became none ⇒ exactly ONE system auto-return
    expect(h.autoReturns.map((a) => a.eventId)).toEqual([e1.eventId]);
    expect(h.autoReturns[0]!.outcomesSnapshot).toEqual(["none"]);
    expect(h.engine.stats().autoReturned).toBe(1);
  });

  it("run terminal mid-buffer ⇒ buffered none, no auto-return while another subscriber observed", async () => {
    const h = makeHarness();
    h.engine.noteThread(H1, "topic");
    h.facts.set(RUN_A, { direct: true, status: "queued", steerable: false });
    h.facts.set(RUN_B, { direct: true, status: "running", steerable: true });
    h.engine.subscribe({ runId: RUN_A, h: H1, label: "buffered-worker", scope: "s", createdBy: "root" });
    h.engine.subscribe({ runId: RUN_B, h: H1, label: "live-worker", scope: "s", createdBy: "root" });
    const e = h.event();
    h.engine.handleEvent(e);
    expect(h.steers.length).toBe(1); // RUN_B steered; RUN_A buffered
    h.settleAll("queued");
    await flushMicrotasks();
    await h.tick(4000); // t1 still buffered ⇒ the reply fires at the deadline (routed)
    expect(h.routed.length).toBe(1);
    // RUN_A fails to start
    h.facts.set(RUN_A, { direct: true, status: "failed", steerable: false });
    h.engine.onRunSnapshot(RUN_A, "failed");
    const record = h.engine.inspectRecord(e.eventId);
    expect(record?.perSub.get("t1")).toBe("none");
    expect(record?.perSub.get("t2")).toBe("queued");
    expect(h.autoReturns).toEqual([]); // blocked_observed — §6.7 hard rule
    expect(h.display.length).toBe(1);
    expect(h.display[0]).toContain("已由 @live-worker");
  });

  it("flush blocked by full run gate ⇒ the flushed event records none (§6.5 复用 per-run 串行)", async () => {
    const h = makeHarness();
    primeWorld(h, { runStatus: "queued" });
    // four buffered events on RUN_A (per-sub buffer cap 4)
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const e = h.event();
      ids.push(e.eventId);
      h.engine.handleEvent(e);
      await h.tick(4000);
    }
    // an unrelated thread steers RUN_A first and hangs… simpler: occupy the gate via a 5th path —
    // instead: run A reaches running with steerable=true; the flush enqueues 4 tasks; the first
    // hangs; tasks 2–4 wait; run terminal cancels the waiters pre-call.
    h.facts.set(RUN_A, { direct: true, status: "running", steerable: true });
    h.engine.onRunSnapshot(RUN_A, "running");
    expect(h.steers.length).toBe(1); // first flush steer in flight (hangs)
    expect(h.engine.inspectRecord(ids[0]!)?.perSub.get("t1")).toBe("flushing");
    h.facts.set(RUN_A, { direct: true, status: "aborted", steerable: false });
    h.engine.onRunSnapshot(RUN_A, "aborted");
    for (const id of ids.slice(1)) {
      expect(h.engine.inspectRecord(id)?.perSub.get("t1")).toBe("none"); // cancelled pre-call
    }
    expect(h.engine.inspectRecord(ids[0]!)?.perSub.get("t1")).toBe("flushing"); // in-flight keeps its real result path
    h.settleAll("queued");
    await flushMicrotasks();
    expect(h.engine.inspectRecord(ids[0]!)?.perSub.get("t1")).toBe("queued");
  });
});

describe("ThreadEngine · handback admission (§5.5)", () => {
  async function routedEvent(h: Harness) {
    primeWorld(h);
    const e = h.event();
    h.engine.handleEvent(e);
    h.settleAll("queued");
    await flushMicrotasks();
    return e;
  }

  it("ok within the window: ends the sub (handback), marks the record pending", async () => {
    const h = makeHarness();
    const e = await routedEvent(h);
    const res = h.engine.requestHandback({ runId: RUN_A, eventId: e.eventId });
    expect(res).toEqual({ ok: true, subId: "t1" });
    expect(h.engine.inspectSubscriptions()[0]!.endReason).toBe("handback");
    expect(h.engine.inspectRecord(e.eventId)?.handback).toBe("pending");
    expect(h.engine.stats().handback).toBe(1);
    expect(h.engine.markHandback(e.eventId, "gone")).toEqual({ degrade: "report" });
    expect(h.engine.markHandback(e.eventId, "done")).toEqual({ degrade: "none" });
  });

  it("window_expired past H=10min; not_delivered when the outcome is none", async () => {
    const h = makeHarness();
    const e = await routedEvent(h);
    h.clock.advance(10 * 60_000 + 1);
    expect(h.engine.requestHandback({ runId: RUN_A, eventId: e.eventId })).toMatchObject({
      ok: false,
      reason: "window_expired",
    });
    // all-none event: lane-timeout style — make a fresh engine world
    const h2 = makeHarness();
    h2.engine.noteThread(H1, "topic");
    h2.facts.set(RUN_A, { direct: true, status: "running", steerable: false }); // no handle ⇒ pre-call none
    h2.engine.subscribe({ runId: RUN_A, h: H1, label: "a", scope: "s", createdBy: "root" });
    const e2 = h2.event();
    h2.engine.handleEvent(e2);
    await h2.tick(4000);
    expect(h2.native).toEqual([e2.eventId]);
    expect(h2.engine.requestHandback({ runId: RUN_A, eventId: e2.eventId })).toMatchObject({
      ok: false,
      reason: "not_delivered",
    });
  });

  it("sub_ended after unsubscribe; hub_unsupported when the hub lost the cap; event_unknown for unseen ids", async () => {
    const h = makeHarness();
    const e = await routedEvent(h);
    expect(h.engine.requestHandback({ runId: RUN_A, eventId: "fs_missing" })).toMatchObject({
      ok: false,
      reason: "event_unknown",
    });
    h.hubOnline.value = false;
    expect(h.engine.requestHandback({ runId: RUN_A, eventId: e.eventId })).toMatchObject({
      ok: false,
      reason: "hub_unsupported",
    });
    h.hubOnline.value = true;
    h.engine.unsubscribe("t1");
    expect(h.engine.requestHandback({ runId: RUN_A, eventId: e.eventId })).toMatchObject({
      ok: false,
      reason: "sub_ended",
    });
  });
});

describe("ThreadEngine · all-none release refusal (§6.7 复检失败)", () => {
  it("releaseToNative refused ⇒ the ENGINE replies E_STALE_CTX (nothing was re-dispatched)", () => {
    const h = makeHarness();
    h.engine.noteThread(H1, "topic");
    h.facts.set(RUN_A, { direct: true, status: "running", steerable: false }); // pre-call none
    h.engine.subscribe({ runId: RUN_A, h: H1, label: "a", scope: "s", createdBy: "root" });
    h.nativeOk.value = false;
    const e = h.event();
    h.engine.handleEvent(e); // all-none judged ⇒ early fallback ⇒ release refused
    expect(h.nativeAttempts).toEqual([e.eventId]);
    expect(h.native).toEqual([]); // refused — NOT delivered to the slow path
    expect(h.staleCtx).toEqual([e.eventId]); // §6.7: the engine owes and pays the reply
    expect(h.audits.some((a) => a.kind === "native-release-refused")).toBe(true);
    // exactly one reply for the event in total (no routed, no second stale)
    expect(h.routed).toEqual([]);
  });

  it("buffered entries carry the event's sentAt (§3.1 ThreadEvent.sentAt)", () => {
    const h = makeHarness();
    primeWorld(h, { runStatus: "queued" });
    h.engine.handleEvent(h.event({ sentAt: 1_700_000_000 }));
    const sub = h.engine.inspectSubscriptions()[0]!;
    expect(sub.bufferedSentAt).toEqual([1_700_000_000]);
  });
});

describe("ThreadEngine · lifecycle hooks (§5.3)", () => {
  it("run terminal: subs ended (run_terminal), summary frozen and read ONCE", async () => {
    const h = makeHarness();
    primeWorld(h);
    const e = h.event();
    h.engine.handleEvent(e);
    h.settleAll("queued");
    await flushMicrotasks();
    h.engine.onRunSnapshot(RUN_A, "completed");
    const sub = h.engine.inspectSubscriptions()[0]!;
    expect(sub.endReason).toBe("run_terminal");
    const summary = h.engine.threadSummary(RUN_A);
    expect(summary).toMatchObject({ runId: RUN_A, subs: 1, routed: 1, replies: 0, handbacks: 0 });
    expect(h.engine.threadSummary(RUN_A)).toBeUndefined(); // read-once
  });

  it("onRunReaped ends leftover subs as stale (兜底)", () => {
    const h = makeHarness();
    primeWorld(h);
    h.engine.onRunReaped(RUN_A);
    expect(h.engine.inspectSubscriptions()[0]!.endReason).toBe("stale");
  });

  it("threadClosed ends subs and closes the directory entry (§5.4)", () => {
    const h = makeHarness();
    primeWorld(h);
    const affected = h.engine.threadClosed(H1, "unbound");
    expect(affected).toEqual([{ runId: RUN_A, label: "worker-a" }]);
    expect(h.engine.inspectSubscriptions()[0]!.endReason).toBe("thread_closed");
    expect(h.engine.subscribe({ runId: RUN_A, h: H1, label: "a", scope: "s", createdBy: "root" }).reason).toBe(
      "thread_closed",
    );
  });

  it("lazy validation: a dead run's sub ends before the R2 check (§5.3 最后一道兜底)", () => {
    const h = makeHarness();
    primeWorld(h);
    h.facts.set(RUN_A, { direct: true, status: "completed", steerable: false });
    const res = h.engine.handleEvent(h.event());
    expect(res).toMatchObject({ decision: { rule: "R2" } }); // lazy sweep ran first ⇒ no live sub
    expect(h.engine.inspectSubscriptions()[0]!.endReason).toBe("run_terminal");
  });
});

describe("ThreadEngine · dispose (§5.3/§6.5/§9.4 C4)", () => {
  it("unreplied uncalled event ⇒ E_STALE_CTX; subs end stack_disposed; late settles discarded by generation", async () => {
    const h = makeHarness();
    primeWorld(h);
    const e = h.event();
    h.engine.handleEvent(e);
    expect(h.steers.length).toBe(1); // called but pending
    const e2 = h.event();
    h.engine.handleEvent(e2); // queued behind e1 in the same lane… e1 in flight ⇒ e2 lane_wait
    h.engine.dispose();
    // e1: called ⇒ unknown ⇒ routed reply; e2: never called, never replied ⇒ E_STALE_CTX
    await flushMicrotasks();
    expect(h.routed.map((r) => r.eventId)).toEqual([e.eventId]);
    expect(h.staleCtx).toEqual([e2.eventId]);
    expect(h.engine.inspectSubscriptions()[0]!.endReason).toBe("stack_disposed");
    expect(h.engine.stats().disposed).toBe(true);
    // late settle of e1's steer: generation bumped ⇒ discarded wholesale, no audit even
    h.settleAll("queued");
    await flushMicrotasks();
    expect(h.routed.length).toBe(1);
    // post-dispose: everything is a native no-op
    expect(h.engine.handleEvent(h.event())).toMatchObject({ action: "native", decision: { rule: "R0" } });
    expect(h.engine.subscribe({ runId: RUN_A, h: H1, label: "a", scope: "s", createdBy: "root" }).ok).toBe(false);
  });

  it("dispose: a MIXED event (called steer + still-buffered subscriber) replies per the aggregate (§6.5)", async () => {
    const h = makeHarness();
    h.engine.noteThread(H1, "topic");
    h.facts.set(RUN_A, { direct: true, status: "running", steerable: true });
    h.facts.set(RUN_B, { direct: true, status: "queued", steerable: false });
    h.engine.subscribe({ runId: RUN_A, h: H1, label: "live", scope: "s", createdBy: "root" });
    h.engine.subscribe({ runId: RUN_B, h: H1, label: "buf", scope: "s", createdBy: "root" });
    const e = h.event();
    h.engine.handleEvent(e);
    expect(h.steers.length).toBe(1); // RUN_A called (hangs); RUN_B buffered
    const rec = h.engine.inspectRecord(e.eventId)!;
    expect(rec.perSub.get("t2")).toBe("buffered");
    h.engine.dispose(); // BEFORE the deadline ⇒ the event is still unreplied here
    // aggregate at dispose: t1=unknown (called), t2=none (buffer swept) ⇒ ROUTED, not silence
    expect(h.routed.map((r) => r.eventId)).toEqual([e.eventId]);
    expect(h.routed[0]!.runs).toEqual([{ runId: RUN_A, label: "live" }]);
    expect(h.staleCtx).toEqual([]);
    expect(rec.perSub.get("t1")).toBe("unknown");
    expect(rec.perSub.get("t2")).toBe("none");
    expect(h.autoReturns).toEqual([]); // C4: never during drain
  });

  it("dispose suppresses the system auto-return even when all-none completes (C4: no auto flow-back in drain)", async () => {
    const h = makeHarness();
    primeWorld(h, { runStatus: "queued" });
    const e = h.event();
    h.engine.handleEvent(e);
    await h.tick(4000); // routed via buffered
    h.engine.dispose();
    // buffered sweep to none happens INSIDE dispose — but auto-return must stay suppressed
    expect(h.autoReturns).toEqual([]);
    expect(h.engine.inspectRecord(e.eventId)?.perSub.get("t1")).toBe("none");
  });
});
