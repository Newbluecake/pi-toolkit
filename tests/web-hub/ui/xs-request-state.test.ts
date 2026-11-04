// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  acceptXsStatus,
  forgetXsRemote,
  forgetXsSeeds,
  mergeReplyState,
  mergeXsRow,
  narrowMentionSession,
  narrowXsRequests,
  narrowXsRow,
  seedXsMention,
  seedXsActivationOutcome,
  xsActivateEligible,
  xsActivateGate,
  xsEntryIndex,
  xsMentionSeeds,
  xsQueryGate,
  xsRemoteRows,
  xsRequestRows,
  xsRowNoteKey,
  xsRowPhaseToken,
  xsRowReplyToken,
  xsRowWakeToken,
  type XsRowView,
} from "../../../src/web-hub/ui/src/logic/xsRequestState.js";

/**
 * `logic/xsRequestState.ts` (fabric-xs-activation plan §3 P4, arch §4.1/§4.9): the browser's
 * monotone merge of the request-progress axis + the activate/query gates. Pinned here:
 * cap gating, out-of-order/revision rules (phases never regress), generic-unconfirmed seeds,
 * wrong-session drops, entryId indexing and the eligibility/gate matrices.
 */

const CAPS = ["xs.v1", "xs.state.v1", "xs.activate.v1"] as const;

function row(over: Partial<XsRowView> & Pick<XsRowView, "messageId">): XsRowView {
  return {
    revision: 1,
    deliveryEffect: "unknown",
    observation: "live",
    wake: { requested: false, decision: "deliver_only" },
    ...over,
  } as XsRowView;
}

function snapshot(rows: readonly XsRowView[], sessionId = "s1", revision = 1) {
  return { sessionId, revision, rows };
}

describe("narrowXsRequests (cap gate + tolerance)", () => {
  it("no xs.state.v1 cap ⇒ undefined regardless of the slot (off/legacy byte-identity)", () => {
    const status = { xsRequests: snapshot([row({ messageId: "m1" })]) };
    expect(narrowXsRequests(status, ["cmd.v1", "xs.v1"])).toBeUndefined();
    expect(narrowXsRequests(status, [])).toBeUndefined();
    expect(narrowXsRequests(status, undefined)).toBeUndefined();
  });

  it("with the cap: a well-formed slot narrows; malformed pieces drop", () => {
    const status = {
      xsRequests: snapshot([
        row({ messageId: "m1", phase: "delivered", deliveryEffect: "applied", deliveredAt: 5 }),
        { messageId: "bad", deliveryEffect: "applied", observation: "live", wake: {} }, // no wake.requested
      ]),
    };
    const snap = narrowXsRequests(status, [...CAPS]);
    expect(snap?.sessionId).toBe("s1");
    expect(snap?.rows.map((r) => r.messageId)).toEqual(["m1"]);
  });

  it("missing sessionId/revision/rows or zero valid rows ⇒ undefined", () => {
    expect(narrowXsRequests({ xsRequests: { revision: 1, rows: [] } }, [...CAPS])).toBeUndefined();
    expect(
      narrowXsRequests({ xsRequests: { sessionId: "s1", rows: [{ messageId: "m" }] } }, [...CAPS]),
    ).toBeUndefined();
    expect(narrowXsRequests({ xsRequests: { sessionId: "s1", revision: 1, rows: [] } }, [...CAPS])).toBeUndefined();
    expect(narrowXsRequests({}, [...CAPS])).toBeUndefined();
  });

  it("narrowXsRow keeps only in-contract enum values", () => {
    expect(
      narrowXsRow({
        messageId: "m",
        revision: 2,
        deliveryEffect: "applied",
        observation: "bogus",
        phase: "queued",
        wake: { requested: true, decision: "downgraded", stage: "hub", reason: "pair_wake_rate" },
      }),
    ).toBeUndefined();
    const ok = narrowXsRow({
      messageId: "m",
      revision: 2,
      deliveryEffect: "applied",
      observation: "live",
      phase: "queued",
      replyState: "pending",
      activationKey: "k",
      entryId: "e9",
      wake: { requested: true, defaulted: true, decision: "downgraded", stage: "hub", reason: "pair_wake_rate" },
    });
    expect(ok).toMatchObject({
      messageId: "m",
      phase: "queued",
      replyState: "pending",
      activationKey: "k",
      entryId: "e9",
      wake: { reason: "pair_wake_rate", stage: "hub", defaulted: true },
    });
  });
});

describe("mergeXsRow (monotone, arch §4.1)", () => {
  it("phases never regress: a queued replay after delivered keeps delivered", () => {
    const delivered = row({ messageId: "m", revision: 2, phase: "delivered", deliveryEffect: "applied" });
    const replay = row({ messageId: "m", revision: 1, phase: "queued", deliveryEffect: "unknown" });
    expect(mergeXsRow(delivered, replay, true)).toMatchObject({ phase: "delivered", deliveryEffect: "applied" });
  });

  it("a same-revision later snapshot may advance phase/evidence", () => {
    const queued = row({ messageId: "m", revision: 3, phase: "queued", deliveryEffect: "unknown" });
    const started = row({ messageId: "m", revision: 3, phase: "started", deliveryEffect: "applied", startedAt: 9 });
    expect(mergeXsRow(queued, started, true)).toMatchObject({
      phase: "started",
      deliveryEffect: "applied",
      startedAt: 9,
    });
  });

  it("unknown may rise to applied; a timeout NEVER rewrites evidence to none", () => {
    const unknown = row({ messageId: "m", revision: 1, deliveryEffect: "unknown", reason: "deliver_deadline" });
    const risen = mergeXsRow(unknown, row({ messageId: "m", revision: 2, deliveryEffect: "applied" }), true);
    expect(risen.deliveryEffect).toBe("applied");
    const none = mergeXsRow(risen, row({ messageId: "m", revision: 3, deliveryEffect: "none" }), true);
    expect(none.deliveryEffect).toBe("applied"); // monotone — none is a PRE-send refusal only
  });

  it("direct delivered is legal (no queued step required); replied may skip startedAt", () => {
    const direct = mergeXsRow(
      undefined,
      row({ messageId: "m", phase: "delivered", deliveryEffect: "applied", revision: 1 }),
      true,
    );
    expect(direct.phase).toBe("delivered");
    const replied = mergeXsRow(
      direct,
      row({ messageId: "m", phase: "replied", deliveryEffect: "applied", revision: 2, repliedAt: 9 }),
      true,
    );
    expect(replied.phase).toBe("replied");
    expect(replied.startedAt).toBeUndefined(); // replied may skip without back-filling startedAt
  });

  it("the FIRST real wake stopper is kept — a later reason never overwrites it", () => {
    const first = row({
      messageId: "m",
      revision: 1,
      wake: { requested: true, stage: "hub", decision: "downgraded", reason: "pair_wake_rate" },
    });
    const later = row({
      messageId: "m",
      revision: 5,
      wake: { requested: true, stage: "receiver", decision: "downgraded", reason: "busy" },
    });
    const merged = mergeXsRow(first, later, true);
    expect(merged.wake).toMatchObject({ stage: "hub", reason: "pair_wake_rate" });
  });

  it("`defaulted` and `requested` are sticky (source-private facts)", () => {
    const seed = row({
      messageId: "m",
      revision: 0,
      wake: { requested: true, defaulted: true, decision: "unknown" },
      seeded: true,
    });
    const remote = row({
      messageId: "m",
      revision: 2,
      wake: { requested: false, decision: "deliver_only" },
    });
    const merged = mergeXsRow(seed, remote, true);
    expect(merged.wake.requested).toBe(true);
    expect(merged.wake.defaulted).toBe(true);
    expect(merged.seeded).toBeUndefined(); // remote proof promoted the row
  });

  it("a generic seed never overrides remote proof (identity adopt-if-absent only)", () => {
    const remote = row({
      messageId: "m",
      revision: 4,
      phase: "delivered",
      deliveryEffect: "applied",
      wake: { requested: false, decision: "deliver_only" },
    });
    const seedRow = row({
      messageId: "m",
      revision: 9,
      phase: "replied",
      deliveryEffect: "applied",
      activationKey: "k1",
      seeded: true,
    });
    const merged = mergeXsRow(remote, seedRow, false);
    expect(merged.phase).toBe("delivered"); // seed's phase claim ignored
    expect(merged.activationKey).toBe("k1"); // identity still adopted
  });

  it("a lower-revision remote replay contributes identity only", () => {
    const cur = row({ messageId: "m", revision: 7, phase: "started", deliveryEffect: "applied", requestId: "q1" });
    const stale = row({ messageId: "m", revision: 3, phase: "queued", deliveryEffect: "unknown" });
    const merged = mergeXsRow(cur, stale, true);
    expect(merged).toMatchObject({ phase: "started", deliveryEffect: "applied", requestId: "q1" });
  });

  it("mergeReplyState port: terminal never re-pends; pending may advance (root fix #3)", () => {
    expect(mergeReplyState(undefined, "pending")).toBe("pending");
    expect(mergeReplyState("pending", undefined)).toBe("pending");
    expect(mergeReplyState("timed_out", "pending")).toBe("timed_out"); // terminal sticks
    expect(mergeReplyState("late", "pending")).toBe("late");
    expect(mergeReplyState("invalidated", "pending")).toBe("invalidated");
    expect(mergeReplyState("pending", "timed_out")).toBe("timed_out"); // pending advances
    expect(mergeReplyState("timed_out", "late")).toBe("late"); // terminal → later terminal
    const viaRow = mergeXsRow(
      row({ messageId: "m", revision: 2, replyState: "timed_out" }),
      row({ messageId: "m", revision: 3, replyState: "pending" }),
      true,
    );
    expect(viaRow.replyState).toBe("timed_out"); // the lattice holds through mergeXsRow too
  });

  it("wake sticky port: dispatch_accepted is itself sticky — a later downgrade never rewrites (root fix #5)", () => {
    const accepted = row({
      messageId: "m",
      revision: 1,
      wake: { requested: true, decision: "dispatch_accepted", authorizedAt: 10 },
    });
    const laterDowngrade = row({
      messageId: "m",
      revision: 5,
      wake: { requested: true, stage: "receiver", decision: "downgraded", reason: "busy" },
    });
    const merged = mergeXsRow(accepted, laterDowngrade, true);
    expect(merged.wake.decision).toBe("dispatch_accepted");
    expect(merged.wake.reason).toBeUndefined();
    expect(merged.wake.authorizedAt).toBe(10); // adopt-if-absent run facts survive
  });

  it("wake sticky port: ANY stored reason is sticky regardless of the stored decision", () => {
    // progress.ts: sticky = stored.reason !== undefined || dispatch_accepted — even a
    // non-downgraded view that carries a reason keeps its story.
    const withReason = row({
      messageId: "m",
      revision: 1,
      wake: { requested: true, decision: "unknown", reason: "deliver_deadline" },
    });
    const later = row({
      messageId: "m",
      revision: 2,
      wake: { requested: true, stage: "hub", decision: "downgraded", reason: "pair_wake_rate" },
    });
    expect(mergeXsRow(withReason, later, true).wake).toMatchObject({ reason: "deliver_deadline" });
  });

  it("wake retryAfterAt: overwrite-if-present, keep-if-absent (a non-quota frame never clears the floor)", () => {
    const floor = row({
      messageId: "m",
      revision: 1,
      wake: { requested: true, decision: "downgraded", reason: "pair_wake_rate", retryAfterAt: 50 },
    });
    const noQuota = row({
      messageId: "m",
      revision: 2,
      wake: { requested: true, decision: "downgraded", reason: "x" },
    });
    expect(mergeXsRow(floor, noQuota, true).wake.retryAfterAt).toBe(50);
    const newer = row({
      messageId: "m",
      revision: 3,
      wake: { requested: true, decision: "downgraded", reason: "x", retryAfterAt: 90 },
    });
    expect(mergeXsRow(floor, newer, true).wake.retryAfterAt).toBe(90);
  });
});

describe("xsRequestRows + seeds + the persistent remote store (root fix #4)", () => {
  it("seeds surface with an empty store; a folded snapshot merges over them", () => {
    seedXsMention("a1", "s1", { messageId: "m1", activationKey: "k1" }, 100);
    expect(xsRequestRows(xsMentionSeeds("a1", "s1"), xsRemoteRows("a1", "s1")).map((r) => r.messageId)).toEqual(["m1"]);
    acceptXsStatus("a1", "s1", {
      sessionId: "s1",
      revision: 1,
      rows: [row({ messageId: "m1", revision: 2, phase: "delivered", deliveryEffect: "applied", activationKey: "k1" })],
    });
    const rows = xsRequestRows(xsMentionSeeds("a1", "s1"), xsRemoteRows("a1", "s1"));
    expect(rows[0]?.messageId).toBe("m1");
    expect(rows[0]?.phase).toBe("delivered");
    expect(rows[0]?.seeded).toBeUndefined(); // remote proof promoted the seed
    forgetXsSeeds("a1");
    forgetXsRemote("a1");
  });

  it("an OLDER snapshot frame after a newer one cannot regress the store (out-of-order guard)", () => {
    acceptXsStatus(
      "a4",
      "s1",
      snapshot([row({ messageId: "m", revision: 5, phase: "started", deliveryEffect: "applied", startedAt: 9 })]),
    );
    acceptXsStatus(
      "a4",
      "s1",
      snapshot([row({ messageId: "m", revision: 2, phase: "queued", deliveryEffect: "unknown" })]),
    );
    expect(xsRemoteRows("a4", "s1").get("m")).toMatchObject({ phase: "started", revision: 5 });
    forgetXsRemote("a4");
  });

  it("rows absent from a fresh snapshot are RETAINED as history; FIFO caps the store at 256", () => {
    acceptXsStatus(
      "a5",
      "s1",
      snapshot([row({ messageId: "m1", revision: 1, phase: "delivered", deliveryEffect: "applied" })]),
    );
    acceptXsStatus("a5", "s1", snapshot([])); // never happens (empty ⇒ no slot) — but retention holds
    expect(xsRemoteRows("a5", "s1").has("m1")).toBe(true);
    acceptXsStatus(
      "a5",
      "s1",
      snapshot(
        Array.from({ length: 300 }, (_, i) =>
          row({ messageId: `bulk${i}`, revision: 1, phase: "queued", queuedAt: i }),
        ),
      ),
    );
    expect(xsRemoteRows("a5", "s1").size).toBe(256);
    expect(xsRemoteRows("a5", "s1").has("m1")).toBe(false); // oldest evicted first
    forgetXsRemote("a5");
  });

  it("a session switch replaces the store wholesale (wrong-session reads empty)", () => {
    acceptXsStatus(
      "a6",
      "s1",
      snapshot([row({ messageId: "m", revision: 1, phase: "replied", deliveryEffect: "applied" })]),
    );
    expect(xsRemoteRows("a6", "s2").size).toBe(0); // wrong session
    acceptXsStatus("a6", "s2", snapshot([row({ messageId: "n", revision: 1, phase: "queued" })]));
    expect(xsRemoteRows("a6", "s1").size).toBe(0); // replaced — old rows never relabel
    expect(xsRemoteRows("a6", "s2").has("n")).toBe(true);
    forgetXsRemote("a6");
  });

  it("wrong-session seeds are invisible; forget drops the agent", () => {
    seedXsMention("a2", "sX", { messageId: "m2" }, 1);
    expect(xsMentionSeeds("a2", "s1").size).toBe(0);
    seedXsMention("a2", "s1", { messageId: "m3" }, 1);
    expect(xsMentionSeeds("a2", "s1").size).toBe(1);
    forgetXsSeeds("a2");
    expect(xsMentionSeeds("a2", "s1").size).toBe(0);
  });

  it("rows sort newest-activity first", () => {
    const remote = new Map<string, XsRowView>([
      ["old", row({ messageId: "old", queuedAt: 1, phase: "queued" })],
      ["new", row({ messageId: "new", deliveredAt: 9, phase: "delivered", deliveryEffect: "applied" })],
    ]);
    expect(xsRequestRows(xsMentionSeeds("none", "s"), remote).map((r) => r.messageId)).toEqual(["new", "old"]);
  });

  it("entryId index attaches only real entry ids (first row wins on collision)", () => {
    const idx = xsEntryIndex([
      row({ messageId: "a", entryId: "e1" }),
      row({ messageId: "b", entryId: "e1" }),
      row({ messageId: "c" }),
    ]);
    expect(idx.size).toBe(1);
    expect(idx.get("e1")?.messageId).toBe("a");
  });
});

describe("tokens + note keys", () => {
  it("phase token: four phases / unknown / not delivered", () => {
    expect(xsRowPhaseToken(row({ messageId: "m", phase: "queued" }))).toBe("queued");
    expect(xsRowPhaseToken(row({ messageId: "m", phase: "replied" }))).toBe("replied");
    expect(xsRowPhaseToken(row({ messageId: "m" }))).toBe("unknown");
    expect(xsRowPhaseToken(row({ messageId: "m", deliveryEffect: "none" }))).toBe("not delivered");
  });

  it("wake + reply tokens", () => {
    expect(
      xsRowWakeToken(
        row({ messageId: "m", wake: { requested: true, decision: "downgraded", reason: "pair_wake_rate" } }),
      ),
    ).toBe("wake↓ pair_wake_rate");
    expect(xsRowWakeToken(row({ messageId: "m", wake: { requested: true, decision: "dispatch_accepted" } }))).toBe(
      "wake·dispatch",
    );
    expect(xsRowWakeToken(row({ messageId: "m", wake: { requested: true, decision: "unknown" } }))).toBe("wake?");
    expect(
      xsRowWakeToken(row({ messageId: "m", wake: { requested: false, decision: "deliver_only" } })),
    ).toBeUndefined();
    expect(xsRowReplyToken(row({ messageId: "m", replyState: "pending" }))).toBe("reply pending");
    expect(xsRowReplyToken(row({ messageId: "m" }))).toBeUndefined();
  });

  it("note key precedence: none > observation > phase > unknown", () => {
    expect(xsRowNoteKey(row({ messageId: "m", deliveryEffect: "none" }))).toBe("xs.noteNotDelivered");
    expect(xsRowNoteKey(row({ messageId: "m", observation: "unavailable" }))).toBe("xs.noteUnavailable");
    expect(xsRowNoteKey(row({ messageId: "m", observation: "offline", phase: "delivered" }))).toBe("xs.noteOffline");
    expect(xsRowNoteKey(row({ messageId: "m", phase: "delivered", deliveryEffect: "applied" }))).toBe(
      "xs.noteDelivered",
    );
    expect(xsRowNoteKey(row({ messageId: "m", phase: "started", deliveryEffect: "applied" }))).toBe("xs.noteStarted");
    expect(xsRowNoteKey(row({ messageId: "m" }))).toBe("xs.noteUnknown");
  });
});

describe("activate/query gates (plan §3 P4: 未宣告不得显示/可点)", () => {
  const eligibleRow = () =>
    row({
      messageId: "m",
      revision: 2,
      phase: "delivered",
      deliveryEffect: "applied",
      observation: "live",
      activationKey: "k1",
      activationUntil: 10_000,
      wake: { requested: true, decision: "downgraded", reason: "pair_wake_rate" },
    });

  it("eligibility matrix: key/window/delivered-not-started/live", () => {
    expect(xsActivateEligible(eligibleRow(), 5_000)).toBe(true);
    expect(xsActivateEligible({ ...eligibleRow(), activationKey: undefined }, 5_000)).toBe(false);
    expect(xsActivateEligible({ ...eligibleRow(), activationUntil: 4_000 }, 5_000)).toBe(false); // expired window
    expect(xsActivateEligible({ ...eligibleRow(), phase: "started", startedAt: 1 }, 5_000)).toBe(false);
    expect(xsActivateEligible({ ...eligibleRow(), phase: "replied", repliedAt: 1 }, 5_000)).toBe(false);
    expect(xsActivateEligible({ ...eligibleRow(), deliveryEffect: "unknown" }, 5_000)).toBe(false);
    expect(xsActivateEligible({ ...eligibleRow(), observation: "offline" }, 5_000)).toBe(false);
  });

  it("the full gate (root fix #1): caps ∧ surface ∧ online ∧ eligibility — nothing else", () => {
    const base = { row: eligibleRow(), now: 5_000, hasSurface: true, online: true };
    expect(xsActivateGate({ ...base, hubCaps: [...CAPS] }).visible).toBe(true);
    expect(xsActivateGate({ ...base, hubCaps: ["xs.v1", "xs.state.v1"] }).visible).toBe(false); // no activate cap
    expect(xsActivateGate({ ...base, hubCaps: ["xs.v1", "xs.activate.v1"] }).visible).toBe(false); // no state cap
    expect(xsActivateGate({ ...base, hubCaps: [] }).visible).toBe(false);
    expect(xsActivateGate({ ...base, hubCaps: [...CAPS], hasSurface: false }).visible).toBe(false); // fail closed
    expect(xsActivateGate({ ...base, hubCaps: [...CAPS], online: false }).visible).toBe(false);
  });

  it("an authoritative retryAfterAt in the future rides the gate view (display, never auto-run)", () => {
    const r = eligibleRow();
    const wake = { ...r.wake, retryAfterAt: 9_000 };
    const view = xsActivateGate({
      hubCaps: [...CAPS],
      row: { ...r, wake },
      now: 5_000,
      hasSurface: true,
      online: true,
    });
    expect(view).toEqual({ visible: true, retryAfterAt: 9_000 });
  });

  it("unknown rows: query gate on (state cap ∧ surface), activate never", () => {
    const unknown = row({ messageId: "m", deliveryEffect: "unknown" });
    expect(xsQueryGate([...CAPS], true, unknown)).toBe(true);
    expect(xsQueryGate(["xs.v1"], true, unknown)).toBe(false);
    expect(xsQueryGate([...CAPS], false, unknown)).toBe(false);
    expect(xsQueryGate([...CAPS], true, row({ messageId: "m", deliveryEffect: "applied", phase: "delivered" }))).toBe(
      false,
    );
  });
});

describe("narrowMentionSession (P2's frozen two-branch port shape)", () => {
  const track = { messageId: "m7", activationKey: "k7" };

  it("branch 1 — the sync web cmd_result (delivery observed, behavior steer)", () => {
    const seed = narrowMentionSession({
      mention: {
        action: "session",
        label: "beta",
        effect: "unknown",
        requestId: "q9",
        track,
        progress: {
          messageId: "m7",
          revision: 0,
          deliveryEffect: "unknown",
          observation: "live",
          phase: "queued",
          wake: { requested: true, defaulted: true, decision: "unknown" },
        },
      },
    });
    expect(seed?.messageId).toBe("m7");
    expect(seed?.activationKey).toBe("k7");
    expect(seed?.requestId).toBeUndefined();
    expect(seed?.row).toMatchObject({ phase: "queued" });
  });

  it("branch 2 — the onSessionRouted settle (behavior idle) narrows identically", () => {
    const seed = narrowMentionSession({
      mention: { action: "session", label: "beta", effect: "applied", track },
    });
    expect(seed).toMatchObject({ messageId: "m7", activationKey: "k7" });
  });

  it("legacy shapes are inert", () => {
    expect(narrowMentionSession({ mention: { action: "steer", label: "x" } })).toBeUndefined();
    expect(narrowMentionSession({ mention: { action: "resume", label: "x" } })).toBeUndefined();
    expect(narrowMentionSession({ mention: { action: "error", label: "x", error: "e" } })).toBeUndefined();
    expect(narrowMentionSession({ mention: { action: "session", label: "x" } })).toBeUndefined(); // no track/progress
    expect(narrowMentionSession({})).toBeUndefined();
    expect(narrowMentionSession(undefined)).toBeUndefined();
  });
});

describe("P3b server control outcomes do not rewrite original body evidence", () => {
  it.each(["accepted", "already_active", "unknown", "unsupported"] as const)(
    "%s after a delivered body offers query only",
    (status) => {
      forgetXsSeeds("p3b");
      forgetXsRemote("p3b");
      const original = row({
        messageId: "m",
        phase: "delivered",
        deliveryEffect: "applied",
        activationKey: "k",
        entryId: "entry-original",
      });
      acceptXsStatus("p3b", "s", snapshot([original], "s"));
      seedXsActivationOutcome(
        "p3b",
        "s",
        { action: "activate", messageId: "m", activationKey: "k" },
        {
          ok: true,
          data: { xsActivation: { status, messageId: "m", effect: status === "unknown" ? "unknown" : "none" } },
        },
        10,
      );
      const current = xsRequestRows(xsMentionSeeds("p3b", "s"), xsRemoteRows("p3b", "s"))[0]!;
      expect(current).toMatchObject({
        deliveryEffect: "applied",
        phase: "delivered",
        revision: 1,
        entryId: "entry-original",
        activationStatus: status,
      });
      expect(xsActivateEligible(current, 20)).toBe(false);
      expect(xsQueryGate(CAPS, true, current)).toBe(true);
      expect(current.wake.authorizedAt).toBeUndefined(); // no fabricated authorization proof
    },
  );
  it("quota retryAfterAt is server-derived, no auto activation, and later accepted supersedes refused", () => {
    forgetXsSeeds("quota-p3b");
    forgetXsRemote("quota-p3b");
    const original = row({
      messageId: "m",
      phase: "delivered",
      deliveryEffect: "applied",
      activationKey: "k",
      wake: { requested: true, decision: "downgraded", stage: "hub", reason: "pair_wake_rate" },
    });
    acceptXsStatus("quota-p3b", "s", snapshot([original], "s"));
    const req = { action: "activate" as const, messageId: "m", activationKey: "k" };
    seedXsActivationOutcome(
      "quota-p3b",
      "s",
      req,
      { ok: true, data: { xsActivation: { status: "refused", messageId: "m", retryAfterAt: 100 } } },
      10,
    );
    const current = () => xsRequestRows(xsMentionSeeds("quota-p3b", "s"), xsRemoteRows("quota-p3b", "s"))[0]!;
    expect(xsActivateGate({ hubCaps: CAPS, row: current(), now: 50, hasSurface: true, online: true })).toEqual({
      visible: true,
      retryAfterAt: 100,
    });
    seedXsActivationOutcome(
      "quota-p3b",
      "s",
      req,
      { ok: true, data: { xsActivation: { status: "accepted", messageId: "m" } } },
      110,
    );
    expect(current().activationStatus).toBe("accepted");
    expect(current().wake.reason).toBe("pair_wake_rate");
    expect(xsActivateEligible(current(), 110)).toBe(false);
  });
  it("host deadline unknown is query-only; browser speculation and wrong scope cannot poison rows", () => {
    forgetXsSeeds("scope-p3b");
    forgetXsRemote("scope-p3b");
    const original = row({ messageId: "m", phase: "delivered", deliveryEffect: "applied", activationKey: "k" });
    acceptXsStatus("scope-p3b", "s", snapshot([original], "s"));
    const req = { action: "activate" as const, messageId: "m", activationKey: "k" };
    seedXsActivationOutcome("scope-p3b", "s", { ...req, activationKey: "bad" }, { ok: false, effect: "unknown" }, 1);
    seedXsActivationOutcome("scope-p3b", "other-session", req, { ok: false, effect: "unknown" }, 1);
    seedXsActivationOutcome(
      "scope-p3b",
      "s",
      req,
      { ok: true, data: { xsActivation: { status: "unknown", messageId: "wrong" } } },
      1,
    );
    expect(xsMentionSeeds("scope-p3b", "s").size).toBe(0);
    seedXsActivationOutcome("scope-p3b", "s", req, { ok: false, effect: "unknown", error: "E_NETWORK" }, 1);
    expect(xsMentionSeeds("scope-p3b", "s").size).toBe(0); // no synthetic server outcome from browser speculation
    seedXsActivationOutcome("scope-p3b", "s", req, { ok: false, effect: "unknown", message: "xs:query-only" }, 1);
    expect(xsMentionSeeds("scope-p3b", "s").get("m")!.activationStatus).toBe("unknown");
    seedXsActivationOutcome(
      "scope-p3b",
      "s",
      { ...req, action: "query" },
      { ok: true, data: { xsActivation: { status: "known", messageId: "m" } } },
      2,
    );
    expect(xsMentionSeeds("scope-p3b", "s").get("m")!.activationStatus).toBe("unknown"); // delivered receipt alone cannot prove unknown activation failed
  });
});
