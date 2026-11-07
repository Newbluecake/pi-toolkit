import { describe, expect, it } from "vitest";
import {
  deliveryModeForFacts,
  SubscriptionRegistry,
  THREAD_SCOPE_MAX_CP,
  truncateCodePoints,
  type SubscribeContext,
} from "../../../src/fabric/thread/subscriptions.js";
import { DEFAULT_THREAD_ENGINE_SETTINGS, type ThreadRunFacts } from "../../../src/fabric/thread/types.js";

const H = "fs:handle00001";
const H2 = "fs:handle00002";
const RUN = "r_ABCDEFGH";
const RUN2 = "r_JKLMNPQR";
const RUN3 = "r_STUVWXYZ";

function makeCtx(overrides?: Partial<SubscribeContext>): SubscribeContext {
  const facts = new Map<string, ThreadRunFacts>();
  facts.set(RUN, { direct: true, status: "running", steerable: true });
  facts.set(RUN2, { direct: true, status: "queued", steerable: false });
  facts.set(RUN3, { direct: false, status: "running", steerable: true });
  return {
    now: 0,
    settings: { ...DEFAULT_THREAD_ENGINE_SETTINGS },
    directory: {
      state: (h) => (h === H ? "open" : h === H2 ? "closed" : "unknown"),
    },
    runFacts: (runId) => facts.get(runId),
    hubCapable: () => true,
    newSubId: (() => {
      let n = 0;
      return () => `t${++n}`;
    })(),
    ...overrides,
  };
}

describe("admission (§5.1)", () => {
  it("admits a direct, non-terminal run on an open thread", () => {
    const reg = new SubscriptionRegistry();
    const res = reg.subscribe({ runId: RUN, h: H, label: "worker-a", scope: "按钮颜色", createdBy: "root" }, makeCtx());
    expect(res).toEqual({ ok: true, subId: "t1", created: true });
  });

  it("rejects each deny reason", () => {
    const reg = new SubscriptionRegistry();
    const base = { h: H, label: "w", scope: "s", createdBy: "root" as const };
    expect(reg.subscribe({ ...base, runId: "r_MISSING" }, makeCtx())).toEqual({ ok: false, reason: "run_not_found" });
    expect(reg.subscribe({ ...base, runId: RUN3 }, makeCtx())).toEqual({ ok: false, reason: "run_not_direct" });
    expect(reg.subscribe({ ...base, runId: RUN, h: "fs:whoever0001" }, makeCtx())).toEqual({
      ok: false,
      reason: "thread_unknown",
    });
    expect(reg.subscribe({ ...base, runId: RUN, h: H2 }, makeCtx())).toEqual({ ok: false, reason: "thread_closed" });
    expect(reg.subscribe({ ...base, runId: RUN }, makeCtx({ hubCapable: () => false }))).toEqual({
      ok: false,
      reason: "hub_unsupported",
    });

    const stoppingFacts = new Map([[RUN, { direct: true, status: "stopping", steerable: false }]] as const);
    expect(reg.subscribe({ ...base, runId: RUN }, makeCtx({ runFacts: (id) => stoppingFacts.get(id) }))).toEqual({
      ok: false,
      reason: "run_status",
    });
    const terminalFacts = new Map([[RUN, { direct: true, status: "completed", steerable: false }]] as const);
    expect(reg.subscribe({ ...base, runId: RUN }, makeCtx({ runFacts: (id) => terminalFacts.get(id) }))).toEqual({
      ok: false,
      reason: "run_status",
    });
  });

  it("idempotent (run, h): same subId back, scope updated, limits NOT re-checked", () => {
    const reg = new SubscriptionRegistry();
    const openAny = { state: () => "open" as const };
    const ctx = makeCtx({
      settings: { ...DEFAULT_THREAD_ENGINE_SETTINGS, maxSubsPerRun: 1 },
      directory: openAny,
    });
    const first = reg.subscribe({ runId: RUN, h: H, label: "w", scope: "old", createdBy: "root" }, ctx);
    expect(first).toEqual({ ok: true, subId: "t1", created: true });
    const again = reg.subscribe({ runId: RUN, h: H, label: "w", scope: "new scope" }, ctx);
    expect(again).toEqual({ ok: true, subId: "t1", created: false });
    expect(reg.get("t1")?.scope).toBe("new scope");
    // a DIFFERENT thread on the same run still hits the per-run ceiling
    expect(reg.subscribe({ runId: RUN, h: "fs:other000001", label: "w", scope: "s", createdBy: "root" }, ctx)).toEqual({
      ok: false,
      reason: "run_limit",
    });
  });

  it("three ceilings: per-run, per-thread, per-session", () => {
    const facts: Record<string, ThreadRunFacts> = {
      [RUN]: { direct: true, status: "running", steerable: true },
      [RUN2]: { direct: true, status: "queued", steerable: false },
      [RUN3]: { direct: true, status: "running", steerable: true },
    };
    let seq = 0; // ONE counter shared by every ctx — subIds must be globally unique
    const ctxWith = (settings: Partial<typeof DEFAULT_THREAD_ENGINE_SETTINGS>) =>
      makeCtx({
        settings: { ...DEFAULT_THREAD_ENGINE_SETTINGS, ...settings },
        directory: { state: () => "open" as const },
        runFacts: (id) => facts[id],
        newSubId: () => `t${++seq}`,
      });
    const block = (settings: Partial<typeof DEFAULT_THREAD_ENGINE_SETTINGS>) => {
      const reg = new SubscriptionRegistry(); // fresh registry per ceiling — counts start at zero
      const ctx = ctxWith(settings);
      const sub = (runId: string, h: string) =>
        reg.subscribe({ runId, h, label: "w", scope: "s", createdBy: "root" }, ctx);
      return { reg, sub };
    };

    const runB = block({ maxSubsPerRun: 2 });
    expect(runB.sub(RUN, "fs:a0000000001").ok).toBe(true);
    expect(runB.sub(RUN, "fs:b0000000001").ok).toBe(true);
    expect(runB.sub(RUN, "fs:c0000000001")).toEqual({ ok: false, reason: "run_limit" });

    const threadB = block({ maxSubsPerThread: 2 });
    expect(threadB.sub(RUN, "fs:a0000000001").ok).toBe(true);
    expect(threadB.sub(RUN2, "fs:a0000000001").ok).toBe(true);
    expect(threadB.sub(RUN3, "fs:a0000000001")).toEqual({ ok: false, reason: "thread_limit" });

    const sessionB = block({ maxSubs: 2 });
    expect(sessionB.sub(RUN, "fs:a0000000001").ok).toBe(true);
    expect(sessionB.sub(RUN2, "fs:b0000000001").ok).toBe(true);
    expect(sessionB.sub(RUN3, "fs:c0000000001")).toEqual({ ok: false, reason: "session_limit" });
  });

  it("ended subscriptions free their ceiling slots and never match idempotently", () => {
    const reg = new SubscriptionRegistry();
    const ctx = makeCtx({ settings: { ...DEFAULT_THREAD_ENGINE_SETTINGS, maxSubsPerRun: 1 } });
    const open = { state: () => "open" as const };
    const ctxOpen = { ...ctx, directory: open };
    reg.subscribe({ runId: RUN, h: H, label: "w", scope: "s", createdBy: "root" }, ctxOpen);
    expect(reg.end("t1", "unsubscribed", 10)).toBeDefined();
    const reSub = reg.subscribe({ runId: RUN, h: H, label: "w", scope: "s2", createdBy: "root" }, ctxOpen);
    expect(reSub).toEqual({ ok: true, subId: "t2", created: true }); // ENDED 不复活 ⇒ 新 subId
  });
});

describe("state machine (§5.2)", () => {
  it("ACTIVE → ENDED is one-way; end returns the sub once and records reason+time", () => {
    const reg = new SubscriptionRegistry();
    reg.subscribe({ runId: RUN, h: H, label: "w", scope: "s", createdBy: "human" }, makeCtx());
    const sub = reg.end("t1", "start_timeout", 1234);
    expect(sub?.state).toBe("ended");
    expect(sub?.endReason).toBe("start_timeout");
    expect(sub?.endedAt).toBe(1234);
    expect(reg.end("t1", "unsubscribed", 2000)).toBeUndefined(); // absorbing
    expect(reg.get("t1")?.endReason).toBe("start_timeout");
  });

  it("activeSubsOfThread returns creation order (§6.6 扇出顺序)", () => {
    const reg = new SubscriptionRegistry();
    const open = { state: () => "open" as const };
    const facts: Record<string, ThreadRunFacts> = {
      [RUN]: { direct: true, status: "running", steerable: true },
      [RUN2]: { direct: true, status: "running", steerable: true },
      [RUN3]: { direct: true, status: "running", steerable: true },
    };
    const ctx = { ...makeCtx(), directory: open, runFacts: (id: string) => facts[id] };
    reg.subscribe({ runId: RUN, h: H, label: "a", scope: "s", createdBy: "root" }, ctx);
    reg.subscribe({ runId: RUN2, h: H, label: "b", scope: "s", createdBy: "root" }, ctx);
    reg.subscribe({ runId: RUN3, h: H, label: "c", scope: "s", createdBy: "root" }, ctx);
    expect(reg.activeSubsOfThread(H).map((s) => s.label)).toEqual(["a", "b", "c"]);
    reg.end("t2", "unsubscribed", 5);
    expect(reg.activeSubsOfThread(H).map((s) => s.label)).toEqual(["a", "c"]);
  });

  it("scope and label are clamped defensively at admission", () => {
    expect(THREAD_SCOPE_MAX_CP).toBe(200);
    expect(truncateCodePoints("abc", 200)).toBe("abc");
    expect(truncateCodePoints("x".repeat(210), 200).length).toBe(200);
    const astral = "𝐀".repeat(201); // 201 code points, 402 UTF-16 units
    expect(truncateCodePoints(astral, 200)).toBe("𝐀".repeat(200));
    const reg = new SubscriptionRegistry();
    const res = reg.subscribe(
      { runId: RUN, h: H, label: "L".repeat(50), scope: "S".repeat(500), createdBy: "root" },
      makeCtx(),
    );
    expect(res.ok).toBe(true);
    const sub = reg.get((res as { subId: string }).subId)!;
    expect(sub.scope.length).toBe(200);
    expect(sub.label.length).toBe(32);
  });
});

describe("deliveryModeForFacts (§6.4 pre-call table)", () => {
  it("queued/starting ⇒ buffer; running+steerable ⇒ steer; anything else ⇒ none", () => {
    expect(deliveryModeForFacts({ direct: true, status: "queued", steerable: false })).toBe("buffer");
    expect(deliveryModeForFacts({ direct: true, status: "starting", steerable: false })).toBe("buffer");
    expect(deliveryModeForFacts({ direct: true, status: "running", steerable: true })).toBe("steer");
    expect(deliveryModeForFacts({ direct: true, status: "running", steerable: false })).toBe("none");
    expect(deliveryModeForFacts({ direct: true, status: "stopping", steerable: true })).toBe("none");
    expect(deliveryModeForFacts({ direct: true, status: "completed", steerable: false })).toBe("none");
  });
});
