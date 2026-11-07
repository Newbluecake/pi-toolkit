import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { FakeClock } from "../../src/core/clock.js";
import {
  XsProgressBag,
  xsEvidenceRank,
  xsPhaseRank,
  type XsClaimReserveResult,
  type XsClaimStepResult,
  type XsProgressFields,
} from "../../src/fabric/xs/progress.js";
import type {
  XsEvidence,
  XsObservation,
  XsPhase,
  XsProgress,
  XsReplyState,
} from "../../src/web-hub/protocol/xs-activation.js";

/**
 * fabric-xs-activation P1a — the pure cross-session progress state machine (plan §3 P1 "纯状态")
 * property suite. Pins arch §4.1/§4.2 merge lattice and §4.6 activation-claim state machine:
 *
 * - a snapshot's `revision` is monotone per messageId; a below-stored revision is dropped WHOLE
 *   (its timestamps are never adopted); out-of-order / duplicate / late writes never regress a
 *   phase, a delivery effect, a revision or an already-set immutable timestamp.
 * - `deliveryEffect` is `none < unknown < applied`: a transport timeout may restate `unknown`
 *   but never manufactures `none`, and `unknown` rises to `applied`.
 * - the phase keeps the FURTHEST proven fact (`queued < delivered < started < replied`): direct
 *   `delivered` is legal; a confirmed reply jumps to `replied` and never fabricates `startedAt`.
 * - the wake view: `requested` is monotone-OR, `defaulted` is SOURCE-private (remote merges can
 *   neither set nor clear it), the first real stopper is sticky, `retryAfterAt` is
 *   overwrite-if-present / keep-if-absent.
 * - claims: `available → reserved → dispatched | unknown → consumed`; `unknown` is query-only
 *   (never releasable); a settle is idempotent (double settle is a `dup` no-op); capacity is
 *   bounded and expiry is lazy (refuse-first, then prune; a later write opens a fresh epoch).
 *
 * The bag is instance-scoped (I4: no module-scope state) and never arms a timer (I5) — the
 * property runs below never touch `clock.setTimer`, and independent bags share nothing.
 */

const NO_EXPIRE = Number.MAX_SAFE_INTEGER;
const CAP = 256;

// ----------------------------------------------------------------- random-field plumbing

interface FieldParts {
  phase: XsPhase | undefined;
  effect: XsEvidence | undefined;
  queuedAt: number | undefined;
  deliveredAt: number | undefined;
  startedAt: number | undefined;
  repliedAt: number | undefined;
  requestId: string | undefined;
  replyState: XsReplyState | undefined;
  observation: XsObservation | undefined;
  activationKey: string | undefined;
  activationUntil: number | undefined;
  entryId: string | undefined;
}

const phaseArb = fc.constantFrom<XsPhase | undefined>(undefined, "queued", "delivered", "started", "replied");
const evidenceArb = fc.constantFrom<XsEvidence | undefined>(undefined, "none", "unknown", "applied");
const tsArb = fc.constantFrom<number | undefined>(undefined, 1, 2, 3, 4, 5);
const strArb = fc.constantFrom<string | undefined>(undefined, "q1", "q2");
const keyArb = fc.constantFrom<string | undefined>(undefined, "k1", "k2");
const observationArb = fc.constantFrom<XsObservation | undefined>(
  undefined,
  "live",
  "offline",
  "expired",
  "unavailable",
);
const replyStateArb = fc.constantFrom<XsReplyState | undefined>(
  undefined,
  "pending",
  "timed_out",
  "late",
  "invalidated",
);

const fieldsArb: fc.Arbitrary<FieldParts> = fc.record({
  phase: phaseArb,
  effect: evidenceArb,
  queuedAt: tsArb,
  deliveredAt: tsArb,
  startedAt: tsArb,
  repliedAt: tsArb,
  requestId: strArb,
  replyState: replyStateArb,
  observation: observationArb,
  activationKey: keyArb,
  activationUntil: tsArb,
  entryId: strArb,
});

/** A LOCAL evidence patch: only present fields are statements (`exactOptionalPropertyTypes`). */
function toFields(p: FieldParts): XsProgressFields {
  const out: XsProgressFields = {};
  if (p.phase !== undefined) out.phase = p.phase;
  if (p.effect !== undefined) out.deliveryEffect = p.effect;
  if (p.queuedAt !== undefined) out.queuedAt = p.queuedAt;
  if (p.deliveredAt !== undefined) out.deliveredAt = p.deliveredAt;
  if (p.startedAt !== undefined) out.startedAt = p.startedAt;
  if (p.repliedAt !== undefined) out.repliedAt = p.repliedAt;
  if (p.requestId !== undefined) out.requestId = p.requestId;
  if (p.replyState !== undefined) out.replyState = p.replyState;
  if (p.observation !== undefined) out.observation = p.observation;
  if (p.activationKey !== undefined) out.activationKey = p.activationKey;
  if (p.activationUntil !== undefined) out.activationUntil = p.activationUntil;
  if (p.entryId !== undefined) out.entryId = p.entryId;
  return out;
}

/** A REMOTE `xs_state` snapshot (the source mirror input): every required field is present. */
function toSnapshot(id: string, revision: number, p: FieldParts): XsProgress {
  return {
    messageId: id,
    revision,
    deliveryEffect: p.effect ?? "unknown",
    ...(p.phase !== undefined ? { phase: p.phase } : {}),
    ...(p.queuedAt !== undefined ? { queuedAt: p.queuedAt } : {}),
    ...(p.deliveredAt !== undefined ? { deliveredAt: p.deliveredAt } : {}),
    ...(p.startedAt !== undefined ? { startedAt: p.startedAt } : {}),
    ...(p.repliedAt !== undefined ? { repliedAt: p.repliedAt } : {}),
    ...(p.requestId !== undefined ? { requestId: p.requestId } : {}),
    ...(p.replyState !== undefined ? { replyState: p.replyState } : {}),
    observation: p.observation ?? "live",
    ...(p.activationKey !== undefined ? { activationKey: p.activationKey } : {}),
    ...(p.activationUntil !== undefined ? { activationUntil: p.activationUntil } : {}),
    ...(p.entryId !== undefined ? { entryId: p.entryId } : {}),
    wake: { requested: false, decision: "deliver_only" },
  };
}

interface Op {
  kind: "observe" | "merge";
  id: string;
  rev: number;
  fields: FieldParts;
}

const opArb: fc.Arbitrary<Op> = fc.record({
  kind: fc.constantFrom("observe", "merge"),
  id: fc.integer({ min: 0, max: 4 }).map((n) => `m${n}`),
  rev: fc.integer({ min: 0, max: 30 }),
  fields: fieldsArb,
});

function applyOp(bag: XsProgressBag, op: Op, now: number): void {
  if (op.kind === "observe") bag.observe(op.id, toFields(op.fields), now);
  else bag.merge(toSnapshot(op.id, op.rev, op.fields), now);
}

function newBag(now = 0): XsProgressBag {
  return new XsProgressBag(CAP, new FakeClock(now), NO_EXPIRE);
}

// ----------------------------------------------------------------- never-regress history

type ImmutableField =
  | "queuedAt"
  | "deliveredAt"
  | "startedAt"
  | "repliedAt"
  | "requestId"
  | "activationKey"
  | "activationUntil"
  | "entryId";

const IMMUTABLE: readonly ImmutableField[] = [
  "queuedAt",
  "deliveredAt",
  "startedAt",
  "repliedAt",
  "requestId",
  "activationKey",
  "activationUntil",
  "entryId",
];

type ImmutableValues = { [K in ImmutableField]: number | string | undefined };

interface Hist {
  phaseRank: number;
  evidenceRank: number;
  revision: number;
  fields: ImmutableValues;
}

function snapFields(snap: XsProgress): ImmutableValues {
  return {
    queuedAt: snap.queuedAt,
    deliveredAt: snap.deliveredAt,
    startedAt: snap.startedAt,
    repliedAt: snap.repliedAt,
    requestId: snap.requestId,
    activationKey: snap.activationKey,
    activationUntil: snap.activationUntil,
    entryId: snap.entryId,
  };
}

function checkHist(id: string, snap: XsProgress, hist: Map<string, Hist>): void {
  const phaseRank = xsPhaseRank(snap.phase);
  const evidenceRank = xsEvidenceRank(snap.deliveryEffect);
  const existing = hist.get(id);
  if (existing === undefined) {
    hist.set(id, { phaseRank, evidenceRank, revision: snap.revision, fields: snapFields(snap) });
    return;
  }
  expect(phaseRank, `${id} phase regressed`).toBeGreaterThanOrEqual(existing.phaseRank);
  expect(evidenceRank, `${id} evidence regressed`).toBeGreaterThanOrEqual(existing.evidenceRank);
  expect(snap.revision, `${id} revision regressed`).toBeGreaterThanOrEqual(existing.revision);
  for (const f of IMMUTABLE) {
    const prev = existing.fields[f];
    if (prev !== undefined) expect(snap[f], `${id}.${f} changed`).toBe(prev);
  }
  existing.phaseRank = Math.max(existing.phaseRank, phaseRank);
  existing.evidenceRank = Math.max(existing.evidenceRank, evidenceRank);
  existing.revision = Math.max(existing.revision, snap.revision);
  for (const f of IMMUTABLE) {
    if (existing.fields[f] === undefined && snap[f] !== undefined) existing.fields[f] = snap[f];
  }
}

// ----------------------------------------------------------------- claim reference model

type RefState = "available" | "reserved" | "dispatched" | "unknown" | "consumed";
interface RefClaim {
  state: RefState;
  key: string | undefined;
  notBefore: number;
  attempts: number;
}

type RefStep = "ok" | "already_active" | "already_consumed" | "key_mismatch" | "not_before" | "state";

/** Tiny independent encoding of the SPEC (arch §4.6), not a copy of the implementation. */
function refStep(r: RefClaim, op: number, key: string, notBefore: number, now: number): RefStep {
  switch (op) {
    case 0: {
      // reserve
      if (r.state === "consumed") return "already_consumed";
      if (r.state !== "available") return "already_active";
      if (r.key !== undefined && r.key !== key) return "key_mismatch";
      if (now < r.notBefore) return "not_before";
      r.state = "reserved";
      r.key = key;
      r.attempts += 1;
      return "ok";
    }
    case 1: // dispatch
      if (r.state !== "reserved") return "state";
      r.state = "dispatched";
      return "ok";
    case 2: // markUnknown
      if (r.state !== "reserved" && r.state !== "dispatched") return "state";
      r.state = "unknown";
      return "ok";
    case 3: // release (proven-none only — never from `unknown`)
      if (r.state !== "reserved" && r.state !== "dispatched") return "state";
      r.state = "available";
      r.notBefore = Math.max(r.notBefore, notBefore);
      return "ok";
    case 4: // settle (idempotent)
      if (r.state === "consumed") return "ok";
      if (r.state !== "dispatched" && r.state !== "unknown") return "state";
      r.state = "consumed";
      return "ok";
    default:
      throw new Error("bad op");
  }
}

// ----------------------------------------------------------------- suites

describe("xs progress — merge lattice (property)", () => {
  it("random out-of-order / duplicate / late / stale-revision writes never regress a fact", () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 50, maxLength: 300 }), (ops) => {
        const bag = newBag();
        const hist = new Map<string, Hist>();
        for (const op of ops) {
          applyOp(bag, op, 0);
          const snap = bag.snapshot(op.id, 0);
          if (snap !== undefined) checkHist(op.id, snap, hist);
        }
      }),
      { numRuns: 150 },
    );
  });

  it("multi-messageId isolation: each id equals a bag that only saw that id's writes", () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 30, maxLength: 150 }), (ops) => {
        const ids = [...new Set(ops.map((op) => op.id))];
        const bag = newBag();
        const shadows = new Map<string, XsProgressBag>(ids.map((id) => [id, newBag()]));
        for (const op of ops) {
          applyOp(bag, op, 0);
          applyOp(shadows.get(op.id)!, op, 0);
        }
        for (const id of ids) {
          expect(bag.snapshot(id, 0)).toEqual(shadows.get(id)!.snapshot(id, 0));
        }
        expect(bag.size).toBe(ids.length);
      }),
      { numRuns: 150 },
    );
  });
});

describe("xs progress — activation claims (property)", () => {
  it("claim state machine matches the spec across random ops (idempotent consume, at-most-once)", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            op: fc.integer({ min: 0, max: 4 }),
            key: fc.constantFrom("k1", "k2"),
            notBefore: fc.integer({ min: 0, max: 8 }),
            now: fc.integer({ min: 0, max: 12 }),
          }),
          { minLength: 25, maxLength: 120 },
        ),
        (ops) => {
          const bag = newBag();
          const id = "m";
          bag.observe(id, { phase: "delivered" }, 0);
          const ref: RefClaim = { state: "available", key: undefined, notBefore: 0, attempts: 0 };
          for (const op of ops) {
            const wasConsumed = ref.state === "consumed";
            const expected = refStep(ref, op.op, op.key, op.notBefore, op.now);
            let real: XsClaimReserveResult | XsClaimStepResult;
            switch (op.op) {
              case 0:
                real = bag.claimReserve(id, op.key, op.now);
                break;
              case 1:
                real = bag.claimDispatch(id, op.now);
                break;
              case 2:
                real = bag.claimMarkUnknown(id, op.now);
                break;
              case 3:
                real = bag.claimRelease(id, op.notBefore, op.now);
                break;
              default:
                real = bag.claimSettle(id, op.now);
                break;
            }
            expect(real.ok, `op ${op.op} @ now ${op.now}`).toBe(expected === "ok");
            if (!real.ok) {
              expect((real as { reason: string }).reason).toBe(expected);
            } else if (op.op === 4 && wasConsumed) {
              expect((real as XsClaimStepResult).dup).toBe(true);
            }
            const view = bag.claimView(id);
            expect(view?.state ?? "available").toBe(ref.state);
            expect(view?.activationKey).toBe(ref.key);
            expect(view?.notBefore ?? 0).toBe(ref.notBefore);
            expect(view?.attempts ?? 0).toBe(ref.attempts);
          }
        },
      ),
      { numRuns: 150 },
    );
  });
});

describe("xs progress — directed invariants", () => {
  it("unknown rises to applied; a timeout statement never manufactures none", () => {
    const bag = newBag();
    bag.observe("m", { deliveryEffect: "unknown", phase: "queued" }, 0);
    expect(bag.snapshot("m", 0)?.deliveryEffect).toBe("unknown");
    bag.observe("m", { deliveryEffect: "applied" }, 0);
    expect(bag.snapshot("m", 0)?.deliveryEffect).toBe("applied");
    bag.observe("m", { deliveryEffect: "unknown" }, 0); // a transport timeout restates unknown
    expect(bag.snapshot("m", 0)?.deliveryEffect).toBe("applied");
    bag.observe("m", { deliveryEffect: "none" }, 0); // even an explicit none cannot regress
    expect(bag.snapshot("m", 0)?.deliveryEffect).toBe("applied");
  });

  it("offline / miss / stale revision never regress a phase; stale is dropped whole", () => {
    const bag = newBag();
    bag.observe("m", { phase: "queued" }, 0);
    bag.observe("m", { phase: "delivered", deliveredAt: 10 }, 0);
    bag.observe("m", { observation: "offline" }, 0);
    expect(bag.snapshot("m", 0)?.phase).toBe("delivered");
    expect(bag.snapshot("other", 0)).toBeUndefined(); // a miss changes nothing
    const res = bag.merge(
      {
        messageId: "m",
        revision: 0, // below the stored revision ⇒ dropped whole
        deliveryEffect: "applied",
        observation: "live",
        phase: "replied",
        repliedAt: 99,
        deliveredAt: 1,
        wake: { requested: false, decision: "deliver_only" },
      },
      0,
    );
    expect(res.kind).toBe("stale");
    const s = bag.snapshot("m", 0);
    expect(s?.phase).toBe("delivered");
    expect(s?.repliedAt).toBeUndefined(); // stale timestamps never adopted
    expect(s?.deliveredAt).toBe(10);
  });

  it("direct delivered is legal; a reply may jump to replied without fabricating startedAt", () => {
    const bag = newBag();
    bag.observe("m", { phase: "delivered", deliveryEffect: "applied", deliveredAt: 5 }, 0);
    bag.observe("m", { phase: "replied", repliedAt: 9 }, 0);
    const s = bag.snapshot("m", 0);
    expect(s?.phase).toBe("replied");
    expect(s?.startedAt).toBeUndefined();
    expect(s?.deliveredAt).toBe(5);
    expect(s?.repliedAt).toBe(9);
  });

  it("wake view: requested is monotone-OR, defaulted is source-private, first stopper sticks, retryAfterAt keeps-if-absent", () => {
    const bag = newBag();
    bag.observe("m", { wake: { requested: true, defaulted: true } }, 0);
    bag.observe("m", { wake: { requested: false } }, 0);
    let s = bag.snapshot("m", 0);
    expect(s?.wake.requested).toBe(true);
    expect(s?.wake.defaulted).toBe(true);
    // a remote merge can neither set nor clear defaulted
    bag.merge(
      {
        messageId: "m",
        revision: 10,
        deliveryEffect: "applied",
        observation: "live",
        wake: { requested: false, decision: "deliver_only", defaulted: false },
      },
      0,
    );
    s = bag.snapshot("m", 0);
    expect(s?.wake.defaulted).toBe(true);

    // a fresh remote mirror entry never adopts a remote defaulted
    const mirror = newBag();
    mirror.merge(
      {
        messageId: "m",
        revision: 1,
        deliveryEffect: "unknown",
        observation: "live",
        wake: { requested: true, defaulted: true, decision: "downgraded" },
      },
      0,
    );
    expect(mirror.snapshot("m", 0)?.wake.defaulted).toBeUndefined();
    expect(mirror.snapshot("m", 0)?.wake.requested).toBe(true);

    // first real stopper is sticky
    const sticky = newBag();
    sticky.observe(
      "m",
      { wake: { requested: true, stage: "hub", decision: "downgraded", reason: "pair_wake_rate" } },
      0,
    );
    sticky.observe("m", { wake: { requested: true, stage: "receiver", decision: "downgraded", reason: "busy" } }, 0);
    expect(sticky.snapshot("m", 0)?.wake.stage).toBe("hub");
    expect(sticky.snapshot("m", 0)?.wake.reason).toBe("pair_wake_rate");

    // retryAfterAt is overwrite-if-present / keep-if-absent
    const quota = newBag();
    quota.observe("m", { wake: { requested: true, retryAfterAt: 5000 } }, 0);
    quota.observe("m", { phase: "delivered" }, 0); // non-quota statement omits it
    expect(quota.snapshot("m", 0)?.wake.retryAfterAt).toBe(5000);
    quota.observe("m", { wake: { requested: true, retryAfterAt: 6000 } }, 0);
    expect(quota.snapshot("m", 0)?.wake.retryAfterAt).toBe(6000);
  });

  it("capacity: full refuses NEW messageIds and never evicts live entries", () => {
    const bag = new XsProgressBag(2, new FakeClock(0), NO_EXPIRE);
    expect(bag.observe("a", { phase: "queued" }, 0).kind).toBe("created");
    expect(bag.observe("b", { phase: "queued" }, 0).kind).toBe("created");
    expect(bag.observe("c", { phase: "queued" }, 0).kind).toBe("full");
    expect(
      bag.merge(
        {
          messageId: "d",
          revision: 0,
          deliveryEffect: "unknown",
          observation: "live",
          wake: { requested: false, decision: "deliver_only" },
        },
        0,
      ).kind,
    ).toBe("full");
    // existing entries stay writable
    expect(bag.observe("a", { phase: "delivered" }, 0).kind).toBe("merged");
    expect(bag.size).toBe(2);
  });

  it("expiry: refused first, then lazily pruned; a later write opens a fresh epoch", () => {
    const bag = new XsProgressBag(CAP, new FakeClock(0), 1000);
    bag.observe("m", { phase: "delivered", deliveredAt: 7 }, 0);
    const r = bag.claimReserve("m", "k", 1000);
    expect(r).toMatchObject({ ok: false, reason: "expired" });
    expect(bag.size).toBe(1); // refused before any cleanup
    const w = bag.observe("m", { phase: "queued" }, 1001);
    expect(w.kind).toBe("created");
    const s = bag.snapshot("m", 1001);
    expect(s?.phase).toBe("queued"); // the pre-expiry "delivered" did not resurrect
    expect(s?.revision).toBe(0);
    expect(s?.deliveredAt).toBeUndefined();
  });

  it("claim lifecycle: available → reserved → dispatched → consumed; double settle is a no-op", () => {
    const bag = newBag();
    bag.observe("m", { phase: "delivered" }, 0);
    expect(bag.claimReserve("m", "k", 0)).toMatchObject({ ok: true, view: { state: "reserved", attempts: 1 } });
    expect(bag.claimDispatch("m", 0)).toMatchObject({ ok: true, view: { state: "dispatched" } });
    expect(bag.claimDispatch("m", 0)).toMatchObject({ ok: false, reason: "state" }); // at-most-once dispatch
    expect(bag.claimSettle("m", 0)).toMatchObject({ ok: true, view: { state: "consumed" } });
    expect(bag.claimSettle("m", 0)).toMatchObject({ ok: true, dup: true, view: { state: "consumed" } });
    expect(bag.claimReserve("m", "k", 0)).toMatchObject({ ok: false, reason: "already_consumed" });
  });

  it("unknown is query-only: never releasable back to available (at-most-once)", () => {
    const bag = newBag();
    bag.observe("m", { phase: "delivered" }, 0);
    bag.claimReserve("m", "k", 0);
    bag.claimMarkUnknown("m", 0);
    expect(bag.claimView("m", 0)?.state).toBe("unknown");
    expect(bag.claimRelease("m", undefined, 0)).toMatchObject({ ok: false, reason: "state" });
    expect(bag.claimSettle("m", 0)).toMatchObject({ ok: true, view: { state: "consumed" } });
  });

  it("proven-none release returns to available, keeps the key binding and raises notBefore", () => {
    const bag = newBag();
    bag.observe("m", { phase: "delivered" }, 0);
    bag.claimReserve("m", "k", 0);
    bag.claimRelease("m", undefined, 10);
    const v = bag.claimView("m", 10);
    expect(v?.state).toBe("available");
    expect(v?.activationKey).toBe("k");
    expect(v?.notBefore).toBe(10);
    expect(bag.claimReserve("m", "k2", 10)).toMatchObject({ ok: false, reason: "key_mismatch" });
    expect(bag.claimReserve("m", "k", 5)).toMatchObject({ ok: false, reason: "not_before", notBefore: 10 });
    expect(bag.claimReserve("m", "k", 10)).toMatchObject({ ok: true, view: { state: "reserved", attempts: 2 } });
  });

  it("instances are independent — no module-scope mutable state", () => {
    const a = newBag();
    const b = newBag();
    a.observe("m", { phase: "delivered" }, 0);
    expect(b.snapshot("m", 0)).toBeUndefined();
    expect(a.snapshot("m", 0)?.phase).toBe("delivered");
  });
});
