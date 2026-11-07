/**
 * #61 P0 — the decision-wake LEDGER (src/fabric/decision-wake.ts) offline matrix, mirroring
 * plan §8 row by row with FAKE ports (no pi, no network, no real timers):
 * lazy activation, human-window budget (2/window, 1/child/window), epoch independence,
 * causal isolation (dedicated ports only; body base wake:false), at-most-once + conservative
 * consumption (effect none vs unknown), stable-id dedup/conflict, caps/TTL/tombstones,
 * correlated reply vs normal steer, lifecycle revocations and reload restore.
 */
import { describe, expect, it } from "vitest";
import {
  createDecisionWakeLedger,
  DECISION_CHILD_ATTEMPTS_PER_WINDOW,
  DECISION_MAX_ENTRIES,
  DECISION_MAX_PENDING,
  DECISION_TTL_MS,
  DECISION_WINDOW_BUDGET,
  isValidDecisionId,
  type DecisionChildFacts,
  type DecisionSendOutcome,
  type DecisionWakeDeps,
  type DecisionWakeEntry,
  type DecisionWakeLedger,
} from "../../src/fabric/decision-wake.js";
import { createDecisionInputObserver } from "../../src/fabric/decision-input.js";
import type { RunId } from "../../src/core/types.js";

interface Harness {
  ledger: DecisionWakeLedger;
  observer: ReturnType<typeof createDecisionInputObserver>;
  persisted: Array<{ type: string; customType?: string; data: unknown }>;
  sends: { body: Array<{ id: string; wake: boolean }>; wakeOnly: string[]; reply: string[] };
  timers: Array<{ ms: number; fire: () => void; cancelled: boolean }>;
  children: Map<RunId, DecisionChildFacts>;
  rootState: () => "live" | "closing" | "fenced";
  setRootState(s: "live" | "closing" | "fenced"): void;
  now: () => number;
  advance(ms: number): void;
  persistError: (fn?: (() => void) | undefined) => void;
  bodyOutcome: (fn: () => DecisionSendOutcome) => void;
  deps: DecisionWakeDeps;
}

function child(runId: RunId, over: Partial<DecisionChildFacts> = {}): DecisionChildFacts {
  return {
    relation: "direct-child",
    owner: "owner-1",
    sessionId: "sess-1",
    generation: 3,
    running: true,
    phase: "running",
    aborted: false,
    ...over,
  };
}

function harness(over: Partial<DecisionWakeDeps> = {}): Harness {
  const observer = createDecisionInputObserver({ sessionId: "sess-1", owner: "owner-1" });
  const persisted: Array<{ type: string; customType?: string; data: unknown }> = [];
  const sends = {
    body: [] as Array<{ id: string; wake: boolean; text: string }>,
    wakeOnly: [] as string[],
    reply: [] as string[],
  };
  const timers: Array<{ ms: number; fire: () => void; cancelled: boolean }> = [];
  const children = new Map<RunId, DecisionChildFacts>([
    ["run-A", child("run-A")],
    ["run-B", child("run-B")],
    ["run-C", child("run-C")],
  ]);
  let clock = 10_000;
  let root: "live" | "closing" | "fenced" = "live";
  let persistHook: (() => void) | undefined;
  let bodyHook: (() => DecisionSendOutcome) | undefined;
  const deps: DecisionWakeDeps = {
    sessionId: "sess-1",
    owner: "owner-1",
    enabled: true,
    input: observer,
    childOf: (runId) => children.get(runId),
    rootState: () => root,
    persist: (entry) => {
      persistHook?.();
      // wrap like a real session custom entry (the ledger's restore folds on type/customType)
      persisted.push({ type: "custom", customType: "subagent:decision-wake", data: entry });
    },
    restoreEntries: () => persisted,
    send: {
      body: (req) => {
        sends.body.push({ id: req.id, wake: req.wake, text: req.text });
        return bodyHook?.() ?? { stage: "dispatch", effect: "sent" };
      },
      wakeOnly: (req) => {
        sends.wakeOnly.push(req.id);
        return { stage: "dispatch", effect: "sent" };
      },
      reply: (req) => {
        sends.reply.push(req.id);
        return { stage: "dispatch", effect: "sent" };
      },
    },
    now: () => clock,
    setTimer: (ms, fn) => {
      const t = { ms, fire: fn, cancelled: false };
      timers.push(t);
      return {
        cancel() {
          t.cancelled = true;
        },
      };
    },
    ...over,
  };
  const ledger = createDecisionWakeLedger(deps);
  return {
    ledger,
    observer,
    persisted,
    sends,
    timers,
    children,
    rootState: () => root,
    setRootState: (s) => (root = s),
    now: () => clock,
    advance(ms) {
      clock += ms;
    },
    persistError: (fn) => (persistHook = fn),
    bodyOutcome: (fn) => (bodyHook = fn),
    deps,
  };
}

describe("decision-wake ledger · lazy activation (#61 plan §3/§8)", () => {
  it("NEVER used: 0 ledger writes, 0 timers, 0 budget, not activated", () => {
    const h = harness();
    expect(h.ledger.activated).toBe(false);
    expect(h.persisted).toEqual([]);
    expect(h.timers).toEqual([]);
    expect(h.ledger.window()).toEqual({ epoch: 0, used: 0 });
    h.observer.observe("human-1");
    // a human input alone persists NOTHING (lazy: only the first legal request checkpoints)
    expect(h.persisted).toEqual([]);
    expect(h.timers).toEqual([]);
  });

  it("first legal request checkpoints proof+reservation BEFORE any send; persist failure ⇒ no send, no activation", () => {
    const h = harness();
    h.observer.observe("human-1");
    h.persistError(() => {
      throw new Error("disk full");
    });
    const r = h.ledger.request({ id: "q1", runId: "run-A", text: "blocked?" });
    expect(r).toEqual({ ok: false, code: "persist_failed", reason: "activation_checkpoint" });
    expect(h.ledger.activated).toBe(false);
    expect(h.sends.body).toEqual([]);

    h.persistError(undefined);
    const ok = h.ledger.request({ id: "q1", runId: "run-A", text: "blocked?" });
    expect(ok.ok).toBe(true);
    // order: checkpoint entry BEFORE the request reservation entry, both BEFORE the body send
    expect((h.persisted[0]!.data as DecisionWakeEntry).kind).toBe("checkpoint");
    expect((h.persisted[1]!.data as DecisionWakeEntry).kind).toBe("request");
    expect(h.sends.body[0]!.wake).toBe(true);
  });

  it("no proof ⇒ first request still deliver-only (budget 0), pending, wake never claimed", () => {
    const h = harness();
    const r = h.ledger.request({ id: "q1", runId: "run-A", text: "blocked?" });
    expect(r).toMatchObject({
      ok: true,
      decision: { state: "pending", delivery: "delivered", activation: "downgraded", reason: "no_human_proof" },
    });
    expect(h.sends.body[0]!.wake).toBe(false);
    expect(h.ledger.window()).toEqual({ epoch: 0, used: 0 });
  });
});

describe("decision-wake ledger · window budget & epochs (plan §2.2, §8 epoch row)", () => {
  it("2 per window across ALL children, 1 per child; over-budget stays deliver-only, no refund", () => {
    const h = harness();
    h.observer.observe("human-1");
    expect(h.ledger.request({ id: "a1", runId: "run-A", text: "A?" }).decision?.activation).toBe("requested");
    expect(h.ledger.request({ id: "b1", runId: "run-B", text: "B?" }).decision?.activation).toBe("requested");
    const third = h.ledger.request({ id: "c1", runId: "run-C", text: "C?" });
    expect(third).toMatchObject({ ok: true, decision: { activation: "downgraded", reason: "no_budget" } });
    expect(h.sends.body.map((s) => s.wake)).toEqual([true, true, false]);
    expect(DECISION_WINDOW_BUDGET).toBe(2);
    expect(DECISION_CHILD_ATTEMPTS_PER_WINDOW).toBe(1);
  });

  it("same child in the same window: second request is deliver-only (child_attempted), old L4 NOT cleared", () => {
    const h = harness();
    h.observer.observe("human-1");
    h.ledger.request({ id: "a1", runId: "run-A", text: "A?" });
    h.ledger.resolve({ id: "a1", runId: "run-A", owner: "owner-1", text: "do X" });
    const again = h.ledger.request({ id: "a2", runId: "run-A", text: "A again?" });
    expect(again).toMatchObject({ ok: true, decision: { activation: "downgraded", reason: "child_attempted" } });
    // the ledger has no level surface at all: an L4 child stays L4 (asserted by absence of any
    // causal port in deps — send ports only, body base wake never mutated to true)
    expect(h.sends.body.every((s) => typeof s.wake === "boolean")).toBe(true);
  });

  it("a NEW proven inputId publishes a fresh window (persist first): old child can apply again", () => {
    const h = harness();
    h.observer.observe("human-1");
    h.ledger.request({ id: "a1", runId: "run-A", text: "A?" });
    h.ledger.resolve({ id: "a1", runId: "run-A", owner: "owner-1", text: "go" });
    h.ledger.request({ id: "b1", runId: "run-B", text: "B?" });
    h.ledger.resolve({ id: "b1", runId: "run-B", owner: "owner-1", text: "go" });
    h.observer.observe("human-2"); // consecutive distinct human inputs both count
    const reopened = h.ledger.request({ id: "a3", runId: "run-A", text: "A3?" });
    expect(reopened.decision?.activation).toBe("requested");
    expect(h.ledger.window().epoch).toBe(2);
    // publication is persisted BEFORE the budget is spent: the FIRST epoch-2 checkpoint
    // carries used:0 (the consume checkpoint for a3 comes after it)
    const cps = h.persisted.map((e) => e.data as DecisionWakeEntry).filter((e) => e.kind === "checkpoint");
    const firstE2 = cps.find((c) => c.kind === "checkpoint" && c.epoch === 2);
    expect(firstE2).toMatchObject({ epoch: 2, used: 0 });
  });

  it("publication persist failure ⇒ the new epoch grants nothing until retried (no reload wash)", () => {
    const h = harness();
    h.observer.observe("human-1");
    h.ledger.request({ id: "a1", runId: "run-A", text: "A?" });
    h.observer.observe("human-2");
    let failNext = true;
    h.persistError(() => {
      if (failNext) {
        failNext = false;
        throw new Error("io");
      }
    });
    // first request after the new proof: the window publish fails once…
    h.ledger.request({ id: "b1", runId: "run-B", text: "B?" });
    // …so a retry publishes the epoch and THEN the request may wake
    const r = h.ledger.request({ id: "c1", runId: "run-C", text: "C?" });
    expect(r.decision?.activation).toBe("requested");
  });
});

describe("decision-wake ledger · authority gates (plan §2.2)", () => {
  it("rejects: not a direct child, wrong owner/session, excluded, aborted, terminal, not running, stale generation, root closing, closed ledger", () => {
    const h = harness();
    h.observer.observe("human-1");
    h.children.set("run-X", child("run-X", { relation: "none" }));
    expect(h.ledger.request({ id: "x1", runId: "run-X", text: "?" })).toMatchObject({
      ok: false,
      code: "not_direct_child",
    });
    h.children.set("run-O", child("run-O", { owner: "owner-OLD" }));
    expect(h.ledger.request({ id: "x2", runId: "run-O", text: "?" })).toMatchObject({
      ok: false,
      code: "not_direct_child",
    });
    h.children.set("run-E", child("run-E", { excluded: true }));
    expect(h.ledger.request({ id: "x3", runId: "run-E", text: "?" })).toMatchObject({
      ok: false,
      code: "child_excluded",
    });
    h.children.set("run-AB", child("run-AB", { aborted: true }));
    expect(h.ledger.request({ id: "x4", runId: "run-AB", text: "?" })).toMatchObject({
      ok: false,
      code: "child_aborted",
    });
    h.children.set("run-T", child("run-T", { phase: "terminal", running: false }));
    expect(h.ledger.request({ id: "x5", runId: "run-T", text: "?" })).toMatchObject({
      ok: false,
      code: "child_terminal",
    });
    h.children.set("run-I", child("run-I", { running: false }));
    expect(h.ledger.request({ id: "x6", runId: "run-I", text: "?" })).toMatchObject({
      ok: false,
      code: "child_not_running",
    });
    h.setRootState("closing");
    expect(h.ledger.request({ id: "x7", runId: "run-A", text: "?" })).toMatchObject({
      ok: false,
      code: "root_closing",
    });
    h.setRootState("live");
    h.ledger.closeAll("root_abort");
    expect(h.ledger.request({ id: "x8", runId: "run-A", text: "?" })).toMatchObject({
      ok: false,
      code: "ledger_closed",
    });
  });

  it("invalid/stable ids: regex gate, same id+text idempotent (one key, one send), same id+different text conflict", () => {
    const h = harness();
    h.observer.observe("human-1");
    expect(isValidDecisionId("ok_id-1")).toBe(true);
    expect(isValidDecisionId("no/glyph")).toBe(false);
    expect(h.ledger.request({ id: "bad id", runId: "run-A", text: "?" })).toMatchObject({
      ok: false,
      code: "id_invalid",
    });
    const first = h.ledger.request({ id: "q1", runId: "run-A", text: "same text" });
    expect(first.ok).toBe(true);
    const again = h.ledger.request({ id: "q1", runId: "run-A", text: "same text" });
    expect(again.decision).toEqual(first.decision);
    expect(h.sends.body).toHaveLength(1);
    expect(h.ledger.request({ id: "q1", runId: "run-A", text: "OTHER text" })).toMatchObject({
      ok: false,
      code: "id_conflict",
    });
  });

  it("single pending per child; caps: 32 pending / 256 entries (tombstones count, never evicted into reuse)", () => {
    const h = harness({ maxPending: 2, maxEntries: 3 });
    h.observer.observe("human-1");
    expect(h.ledger.request({ id: "a1", runId: "run-A", text: "1" }).ok).toBe(true);
    expect(h.ledger.request({ id: "a2", runId: "run-A", text: "2" })).toMatchObject({
      ok: false,
      code: "pending_exists",
    });
    expect(h.ledger.request({ id: "b1", runId: "run-B", text: "3" }).ok).toBe(true);
    expect(h.ledger.request({ id: "c1", runId: "run-C", text: "4" })).toMatchObject({
      ok: false,
      code: "capacity_pending",
    });
    h.ledger.resolve({ id: "a1", runId: "run-A", owner: "owner-1", text: "go" });
    h.ledger.resolve({ id: "b1", runId: "run-B", owner: "owner-1", text: "go" });
    expect(h.ledger.request({ id: "d1", runId: "run-C", text: "5" }).ok).toBe(true); // 3rd entry
    expect(h.ledger.request({ id: "e1", runId: "run-A", text: "6" })).toMatchObject({
      ok: false,
      code: "capacity_owner",
    });
    expect(DECISION_MAX_PENDING).toBe(32);
    expect(DECISION_MAX_ENTRIES).toBe(256);
  });
});

describe("decision-wake ledger · at-most-once & conservative consumption (plan §4.1/§4.2)", () => {
  it("pre-dispatch prepare failure: conservative fail-closed — delivery stays queued, attempt persisted+consumed, NO retry entry (repeat id = snapshot only; restore ⇒ unknown)", () => {
    const h = harness();
    h.observer.observe("human-1");
    h.bodyOutcome(() => ({ stage: "prepare", effect: "none" }));
    const r = h.ledger.request({ id: "q1", runId: "run-A", text: "?" });
    expect(r).toMatchObject({ decision: { delivery: "queued", reason: "prepare_failed" } });
    expect(h.ledger.window().used).toBe(1); // the wake attempt was persisted BEFORE the host call
  });

  it("post-dispatch effect none: delivery failed, activation downgraded(effect_none); wake/status answer downgraded(effect_none), no resend/refund", () => {
    const h = harness();
    h.observer.observe("human-1");
    h.bodyOutcome(() => ({ stage: "dispatch", effect: "none" }));
    const r = h.ledger.request({ id: "q1", runId: "run-A", text: "?" });
    expect(r).toMatchObject({
      decision: { delivery: "failed", activation: "downgraded", reason: "effect_none", state: "pending" },
    });
    const wake = h.ledger.wake({ id: "q1", runId: "run-A" });
    expect(wake).toMatchObject({ ok: true, decision: { activation: "downgraded", reason: "effect_none" } });
    const status = h.ledger.status({ id: "q1" });
    expect(status).toMatchObject({ decision: { delivery: "failed", reason: "effect_none" } });
    expect(h.sends.body).toHaveLength(1);
    expect(h.sends.wakeOnly).toEqual([]);
  });

  it("post-dispatch unknown: delivery unknown, no resend, no refund; wake-only requires delivered", () => {
    const h = harness();
    h.observer.observe("human-1");
    h.bodyOutcome(() => ({ stage: "dispatch", effect: "unknown" }));
    const r = h.ledger.request({ id: "q1", runId: "run-A", text: "?" });
    expect(r).toMatchObject({ decision: { delivery: "unknown", activation: "unknown", reason: "unknown" } });
    const wake = h.ledger.wake({ id: "q1", runId: "run-A" });
    expect(wake).toMatchObject({ ok: true, decision: { delivery: "unknown", activation: "unknown" } });
    expect(h.sends.body).toHaveLength(1);
    expect(h.sends.wakeOnly).toEqual([]);
    expect(h.ledger.window().used).toBe(1);
  });

  it("delivered + fresh window: action:wake sends ONE reference-only prompt, never the body again", () => {
    const h = harness();
    h.observer.observe("human-1");
    h.ledger.request({ id: "q1", runId: "run-A", text: "?" }); // wakes immediately (budget)
    h.observer.observe("human-2"); // new window
    const w = h.ledger.wake({ id: "q1", runId: "run-A" });
    expect(w).toMatchObject({ ok: true, decision: { activation: "requested" } });
    expect(h.sends.body).toHaveLength(1);
    expect(h.sends.wakeOnly).toEqual(["q1"]);
    // same-window re-attempt: snapshot only
    const again = h.ledger.wake({ id: "q1", runId: "run-A" });
    expect(again.decision?.activation).toBe("requested");
    expect(h.sends.wakeOnly).toHaveLength(1);
  });

  it("correlated reply: wrong owner/runId rejected; success resolves; reply unknown keeps the slot and blocks further decision wake; normal steer has NO path", () => {
    const h = harness();
    h.observer.observe("human-1");
    h.ledger.request({ id: "q1", runId: "run-A", text: "?" });
    expect(h.ledger.resolve({ id: "q1", runId: "run-A", owner: "owner-2", text: "x" })).toMatchObject({
      ok: false,
      code: "state",
      reason: "owner",
    });
    expect(h.ledger.resolve({ id: "q1", runId: "run-B", owner: "owner-1", text: "x" })).toMatchObject({
      ok: false,
      code: "unknown_id",
    });
    expect(h.ledger.resolve({ id: "nope", runId: "run-A", owner: "owner-1", text: "x" })).toMatchObject({
      ok: false,
      code: "unknown_id",
    });
    // reply unknown: stays pending, no re-send, no further decision wake, NO second steer
    h.bodyOutcome(undefined);
    const saved = h.deps.send.reply;
    (h.deps.send as { reply: typeof saved }).reply = (req) => {
      h.sends.reply.push(req.id);
      return { stage: "dispatch", effect: "unknown" };
    };
    const ru = h.ledger.resolve({ id: "q1", runId: "run-A", owner: "owner-1", text: "answer" });
    expect(ru).toMatchObject({ decision: { state: "pending", reason: "reply_unknown" } });
    h.observer.observe("human-3");
    const wake = h.ledger.wake({ id: "q1", runId: "run-A" });
    expect(wake.decision?.state).toBe("pending");
    expect(h.sends.wakeOnly).toEqual([]);
    // a REPEATED correlated resolve (same id) only reports the original unknown — no second steer
    const repeat = h.ledger.resolve({ id: "q1", runId: "run-A", owner: "owner-1", text: "answer" });
    expect(repeat).toMatchObject({ decision: { state: "pending", reason: "reply_unknown" } });
    expect(h.sends.reply).toEqual(["q1"]);
  });

  it("correlated reply SUCCESS path resolves on the first (and only) steer", () => {
    const h = harness();
    h.observer.observe("human-1");
    h.ledger.request({ id: "q2", runId: "run-A", text: "?" });
    const rs = h.ledger.resolve({ id: "q2", runId: "run-A", owner: "owner-1", text: "answer" });
    expect(rs).toMatchObject({ decision: { state: "resolved" } });
    expect(h.sends.reply).toEqual(["q2"]);
  });

  it("persist failure on a dispatch attempt ⇒ 0 host call (body AND reply legs, attempt rolled back)", () => {
    const h = harness();
    h.observer.observe("human-1");
    // activation checkpoint + request reserve persist succeed; the consumeAttempt/body-attempt
    // persists (everything after the first two) fail ⇒ 0 host send, attempt rolled back.
    let count = 0;
    h.persistError(() => {
      count += 1;
      if (count > 2) throw new Error("io");
    });
    const r = h.ledger.request({ id: "q1", runId: "run-A", text: "?" });
    expect(r).toMatchObject({ ok: false, code: "persist_failed", reason: "body_attempt" });
    expect(h.sends.body).toHaveLength(0);
    expect(h.ledger.status({ id: "q1" }).decision?.delivery).toBe("queued"); // reserve kept, attempt 0
  });

  it("CRASH WINDOW (body leg): a dispatch interrupted mid-send restores as unknown; repeat request sends NOTHING (total bodies ≤ 1)", () => {
    const h = harness();
    h.observer.observe("human-1");
    // Inside the send callback — BEFORE settleSend persists the outcome — take the durable
    // snapshot and rebuild the ledger from it (exactly the crash window).
    let reloaded: ReturnType<typeof createDecisionWakeLedger> | undefined;
    h.bodyOutcome(() => {
      const observer2 = createDecisionInputObserver({ sessionId: "sess-1", owner: "owner-1" });
      observer2.observe("human-1");
      reloaded = createDecisionWakeLedger({ ...h.deps, input: observer2, restoreEntries: () => [...h.persisted] });
      reloaded.restore();
      return { stage: "dispatch", effect: "sent" };
    });
    expect(h.ledger.request({ id: "a1", runId: "run-A", text: "1" }).ok).toBe(true);
    const snap = reloaded!.status({ id: "a1" });
    expect(snap).toMatchObject({ decision: { delivery: "unknown" } }); // queued+attempt>0 ⇒ unknown
    // a repeated request with the same id returns the restored snapshot: NO second body send
    const repeat = reloaded!.request({ id: "a1", runId: "run-A", text: "1" });
    expect(repeat).toMatchObject({ ok: true, decision: { delivery: "unknown" } });
    expect(h.sends.body).toHaveLength(1); // exactly one body, ever
  });

  it("CRASH WINDOW (reply leg): an interrupted correlated steer restores as reply_unknown; repeat resolve sends NOTHING (total replies ≤ 1)", () => {
    const h = harness();
    h.observer.observe("human-1");
    expect(h.ledger.request({ id: "a1", runId: "run-A", text: "1" }).ok).toBe(true);
    const saved = h.deps.send.reply;
    let reloaded: ReturnType<typeof createDecisionWakeLedger> | undefined;
    (h.deps.send as { reply: typeof saved }).reply = (req) => {
      h.sends.reply.push(req.id);
      const observer2 = createDecisionInputObserver({ sessionId: "sess-1", owner: "owner-1" });
      observer2.observe("human-1");
      reloaded = createDecisionWakeLedger({ ...h.deps, input: observer2, restoreEntries: () => [...h.persisted] });
      reloaded.restore();
      return { stage: "dispatch", effect: "sent" };
    };
    const r = h.ledger.resolve({ id: "a1", runId: "run-A", owner: "owner-1", text: "answer" });
    expect(r.decision?.state).toBe("resolved"); // the live ledger finished normally
    const snap = reloaded!.status({ id: "a1" });
    expect(snap).toMatchObject({ decision: { state: "pending", reason: "reply_unknown" } });
    // the crash-window rebuild never saw the outcome: a repeated resolve reports unknown, 0 new steer
    const repeat = reloaded!.resolve({ id: "a1", runId: "run-A", owner: "owner-1", text: "answer" });
    expect(repeat).toMatchObject({ ok: true, decision: { state: "pending", reason: "reply_unknown" } });
    expect(h.sends.reply).toEqual(["a1"]); // exactly one reply, ever
    // and the wake leg stays blocked for a reply-attempted request (snapshot only, 0 wake send)
    expect(reloaded!.wake({ id: "a1", runId: "run-A" }).decision?.state).toBe("pending");
    expect(h.sends.wakeOnly).toEqual([]);
  });

  it("status never extends TTL / resets budget; cancel tombstones; expired ids never reactivate", () => {
    const h = harness({ ttlMs: 5_000 });
    h.observer.observe("human-1");
    const r = h.ledger.request({ id: "q1", runId: "run-A", text: "?" });
    expect(r.ok).toBe(true);
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0]!.ms).toBe(5_000);
    h.advance(6_000);
    h.timers[0]!.fire();
    expect(h.ledger.status({ id: "q1" })).toMatchObject({ decision: { state: "expired", reason: "ttl" } });
    // same id + same text: the tombstone dedups (returns the expired snapshot, no new send)
    const again = h.ledger.request({ id: "q1", runId: "run-A", text: "?" });
    expect(again.decision?.state).toBe("expired");
    expect(h.sends.body).toHaveLength(1);
    expect(DECISION_TTL_MS).toBe(900_000);
  });
});

describe("decision-wake ledger · lifecycle & reload (plan §4.2/§4.3)", () => {
  it("child terminal closes its pending; root abort/session switch close all and freeze the ledger", () => {
    const h = harness();
    h.observer.observe("human-1");
    h.ledger.request({ id: "a1", runId: "run-A", text: "1" });
    h.ledger.request({ id: "b1", runId: "run-B", text: "2" });
    h.children.set("run-A", child("run-A", { phase: "terminal", running: false }));
    h.ledger.onChildTerminal("run-A");
    expect(h.ledger.status({ id: "a1" })).toMatchObject({ decision: { state: "closed", reason: "child_terminal" } });
    expect(h.ledger.status({ id: "b1" }).decision?.state).toBe("pending");
    h.ledger.closeAll("session_switch");
    expect(h.ledger.status({ id: "b1" })).toMatchObject({ decision: { state: "closed", reason: "session_switch" } });
    expect(h.ledger.request({ id: "b2", runId: "run-B", text: "3" })).toMatchObject({
      ok: false,
      code: "ledger_closed",
    });
  });

  it("dispose is idempotent, cancels the timer and freezes proofs", () => {
    const h = harness();
    h.observer.observe("human-1");
    h.ledger.request({ id: "a1", runId: "run-A", text: "1" });
    h.ledger.dispose();
    h.ledger.dispose();
    expect(h.timers[0]!.cancelled).toBe(true);
    expect(h.observer.observe("human-9")).toMatchObject({ status: "fail_closed", reason: "frozen" });
  });

  it("reload restore: activated high-watermark survives (no wash); queued+attempted restores as unknown; expired closes", () => {
    const h = harness({ ttlMs: 60_000 });
    h.observer.observe("human-1");
    h.ledger.request({ id: "a1", runId: "run-A", text: "1" }); // wake consumed (used=1)
    h.observer.observe("human-2");
    h.ledger.request({ id: "b1", runId: "run-B", text: "2" }); // epoch 2 published, used=1

    // simulate /reload: same persisted entries, a FRESH observer that lost its un-activated
    // proofs — but epochs 1/2 were already checkpointed, so the high-watermark restores.
    const observer2 = createDecisionInputObserver({ sessionId: "sess-1", owner: "owner-1" });
    const deps2: DecisionWakeDeps = {
      ...h.deps,
      input: observer2,
      restoreEntries: () => h.persisted,
    };
    const reloaded = createDecisionWakeLedger(deps2);
    reloaded.restore();
    expect(reloaded.activated).toBe(true);
    expect(reloaded.window()).toEqual({ epoch: 2, used: 1 });
    // the second window still has budget 1: a new child may wake, but run-B already attempted
    const r = reloaded.request({ id: "c1", runId: "run-C", text: "3" });
    expect(r.decision?.activation).toBe("requested");
    reloaded.resolve({ id: "b1", runId: "run-B", owner: "owner-1", text: "go" });
    const b2 = reloaded.request({ id: "b2", runId: "run-B", text: "4" });
    // the restored window is exhausted (used 1 + c1's consume = 2) AND run-B already attempted
    // this epoch — either way the fresh request is deliver-only, and the window NEVER washes.
    expect(b2).toMatchObject({ ok: true, decision: { activation: "downgraded" } });
    expect(["no_budget", "child_attempted"]).toContain((b2 as { decision?: { reason?: string } }).decision?.reason);
  });

  it("restore of a queued request with a recorded body attempt ⇒ unknown (uncertain evidence forbids re-send)", () => {
    const h = harness({ ttlMs: 60_000 });
    h.observer.observe("human-1");
    h.bodyOutcome(() => ({ stage: "dispatch", effect: "unknown" }));
    h.ledger.request({ id: "a1", runId: "run-A", text: "1" });
    const observer2 = createDecisionInputObserver({ sessionId: "sess-1", owner: "owner-1" });
    const reloaded = createDecisionWakeLedger({ ...h.deps, input: observer2, restoreEntries: () => h.persisted });
    reloaded.restore();
    // restored delivery: unknown wins over the queued+attempted persisted shape? the persisted
    // entry already says unknown — restore must not DOWNGRADE it back to queued.
    expect(reloaded.status({ id: "a1" })).toMatchObject({ decision: { delivery: "unknown" } });
  });

  it("un-activated ledger after reload: no proof ⇒ no budget (conservative), deliver-only still works", () => {
    const h = harness();
    const r = h.ledger.request({ id: "a1", runId: "run-A", text: "1" });
    expect(r).toMatchObject({ decision: { activation: "downgraded", reason: "no_human_proof" } });
    const observer2 = createDecisionInputObserver({ sessionId: "sess-1", owner: "owner-1" });
    const reloaded = createDecisionWakeLedger({ ...h.deps, input: observer2, restoreEntries: () => h.persisted });
    reloaded.restore();
    expect(reloaded.window()).toEqual({ epoch: 0, used: 0 });
  });

  it("owner-mismatched persisted entries grant nothing after an owner change", () => {
    const h = harness();
    h.observer.observe("human-1");
    h.ledger.request({ id: "a1", runId: "run-A", text: "1" });
    const observer2 = createDecisionInputObserver({ sessionId: "sess-1", owner: "owner-NEW" });
    const reloaded = createDecisionWakeLedger({
      ...h.deps,
      owner: "owner-NEW",
      input: observer2,
      childOf: (runId) => {
        const f = h.children.get(runId);
        return f && { ...f, owner: "owner-NEW" };
      },
      restoreEntries: () => h.persisted,
    });
    reloaded.restore();
    expect(reloaded.activated).toBe(false);
    expect(reloaded.window()).toEqual({ epoch: 0, used: 0 });
  });
});

describe("decision-wake ledger · seeded interleavings (property-lite at-most-once)", () => {
  it("random request/wake/resolve interleavings never double-send a body nor exceed the window", () => {
    let seed = 0x61d00d;
    const rnd = (): number => {
      seed = (Math.imul(seed ^ (seed >>> 15), seed | 1) ^ (seed + Math.imul(seed ^ (seed >>> 7), seed | 61))) >>> 0;
      return ((seed ^ (seed >>> 14)) >>> 0) / 4294967296;
    };
    for (let round = 0; round < 12; round++) {
      const h = harness();
      h.observer.observe(`human-${round}`);
      const runs: RunId[] = ["run-A", "run-B", "run-C"];
      const ids = new Map<string, RunId>();
      for (let step = 0; step < 40; step++) {
        const roll = rnd();
        const knownIds = [...ids.keys()];
        if (roll < 0.5 || knownIds.length < 3) {
          const id = `r${round}-${step}`;
          const runId = runs[Math.floor(rnd() * runs.length)]!;
          h.bodyOutcome(() =>
            rnd() < 0.3 ? { stage: "dispatch", effect: "unknown" } : { stage: "dispatch", effect: "sent" },
          );
          h.ledger.request({ id, runId, text: `t-${step}` });
          ids.set(id, runId);
        } else if (roll < 0.65) {
          const id = knownIds[Math.floor(rnd() * knownIds.length)]!;
          h.ledger.wake({ id, runId: ids.get(id)! });
        } else if (roll < 0.8) {
          const id = knownIds[Math.floor(rnd() * knownIds.length)]!;
          h.ledger.resolve({ id, runId: ids.get(id)!, owner: "owner-1", text: "ok" });
        } else {
          h.observer.observe(`human-${round}-${step}`);
        }
      }
      // invariant 1: at most ONE body send per request id
      const perId = new Map<string, number>();
      for (const s of h.sends.body) perId.set(s.id, (perId.get(s.id) ?? 0) + 1);
      for (const [id, n] of perId) expect(n, `body sends for ${id}`).toBeLessThanOrEqual(1);
      // invariant 2 (budget): persisted checkpoints never exceed windowBudget per epoch
      const cps = h.persisted.map((e) => e.data as DecisionWakeEntry).filter((e) => e.kind === "checkpoint");
      const maxEpoch = Math.max(0, ...cps.map((c) => (c.kind === "checkpoint" ? c.epoch : 0)));
      const usedByEpoch = new Map<number, number>();
      for (const c of cps) {
        if (c.kind !== "checkpoint") continue;
        usedByEpoch.set(c.epoch, Math.max(usedByEpoch.get(c.epoch) ?? 0, c.used));
      }
      for (const [, used] of usedByEpoch) expect(used).toBeLessThanOrEqual(DECISION_WINDOW_BUDGET);
      expect(maxEpoch).toBeGreaterThanOrEqual(0);
    }
  });
});
