import { describe, expect, it } from "vitest";
import { MemoryOutboxStore } from "../../src/core/store.js";
import type { FabricRecord } from "../../src/core/message.js";
import { createDeliveryEngine } from "../../src/delivery/engine.js";
import { FabricTree } from "../../src/fabric/tree.js";
import { FabricThrottle } from "../../src/fabric/throttle.js";
import { FabricRouter, type FabricRouterConfig, type WakePolicy } from "../../src/fabric/router.js";

/** fabric-cross-session plan §3.1 (root matrix) + §3.3 L2/L5 at admission (W1). */
const S = "r_ABCDEFGH"; // sender, direct child of root
const T = "r_12345678"; // sibling target
const base: FabricRouterConfig = {
  maxPerRun: 5,
  findingQuota: 10,
  directiveQuota: 10,
  deadLetterQuota: 1,
  maxChars: 100,
  progressTtlMs: 100,
  reconcileTtlMs: 100,
  rootInboxCap: 10,
  progressChannel: "context",
};
function setup(
  wake?: { level: number; maxLevel?: number; perRunQuota?: number } | undefined,
  config: Partial<FabricRouterConfig> = {},
) {
  const engine = createDeliveryEngine<FabricRecord, FabricRecord["state"]>({
    store: new MemoryOutboxStore<FabricRecord>(),
    allowed: {
      pending: ["claimed", "consumed", "dropped", "abandoned"],
      claimed: ["pending", "delivered", "consumed", "dropped"],
      delivered: [],
      consumed: [],
      dropped: [],
      abandoned: [],
    },
    memoryOnly: new Set(["claimed"]),
    memoryOnlyFields: ["claimToken"],
    now: () => 1,
  });
  const tree = new FabricTree();
  tree.append("root", S);
  tree.append("root", T);
  tree.markRunning(S);
  tree.markRunning(T);
  const levels: Record<string, number> = { [S]: wake?.level ?? 0 };
  const maxLevel = wake?.maxLevel ?? 2;
  const policy: WakePolicy | undefined = wake
    ? {
        levelOf: (n) => levels[n] ?? 0,
        hopAllowed: (l) => l + 1 <= maxLevel,
        perRunQuota: wake.perRunQuota ?? 3,
      }
    : undefined;
  const router = new FabricRouter(
    engine,
    tree,
    new FabricThrottle({ minIntervalMs: 0, rootMinIntervalMs: 0, backoffMs: 0 }),
    { ...base, ...config, ...(policy ? { wakePolicy: policy } : {}) },
    () => 1,
  );
  const stored = (key: string) => engine.get(key)!;
  return { router, engine, stored, levels };
}
const send = (router: FabricRouter, over: Partial<Parameters<FabricRouter["admit"]>[1]> = {}) =>
  router.admit(S, { to: "root", kind: "finding", text: "t", generation: 1, canMessage: ["parent"], ...over });

describe("router wake policy — root matrix (plan §3.1)", () => {
  it("omitted wake: legacy record shape + the sender's level stamped (no `wake` field)", () => {
    const { router, stored } = setup({ level: 1 });
    const r = send(router);
    expect(r).toMatchObject({ ok: true, status: "accepted" });
    expect(r).not.toHaveProperty("wake");
    expect(r).not.toHaveProperty("wakeDowngraded");
    const rec = stored((r as { key: string }).key);
    expect(rec.level).toBe(1);
    expect(rec).not.toHaveProperty("wake");
  });

  it("wake:false to root: stored deliver-only, no quota class spent", () => {
    const { router, stored } = setup({ level: 0, perRunQuota: 1 });
    const r = send(router, { wake: false });
    expect(r).toMatchObject({ ok: true, wake: false });
    expect(stored((r as { key: string }).key)).toMatchObject({ wake: false, level: 0 });
    expect(router.wakeUsed(S)).toBe(0);
    // deliver-only never consumed the expensive class: a wake:true still fits
    expect(send(router, { wake: true })).toMatchObject({ ok: true, wake: true });
  });

  it("wake:true to root within limits: stored effective wake, counted in the separate perRunQuota class", () => {
    const { router, stored } = setup({ level: 1, maxLevel: 2, perRunQuota: 3 });
    const r = send(router, { wake: true });
    expect(r).toMatchObject({ ok: true, status: "accepted", wake: true });
    expect(r).not.toHaveProperty("wakeDowngraded");
    expect(stored((r as { key: string }).key)).toMatchObject({ wake: true, level: 1 });
    expect(router.wakeUsed(S)).toBe(1);
  });

  it("hop limit: L+1 > maxLevel ⇒ downgraded to deliver-only (accepted, NOT rejected), flagged level_limit, not counted", () => {
    const { router, stored } = setup({ level: 2, maxLevel: 2 });
    const r = send(router, { wake: true });
    expect(r).toMatchObject({ ok: true, status: "accepted", wake: false, wakeDowngraded: "level_limit" });
    expect(stored((r as { key: string }).key)).toMatchObject({ wake: false, level: 2 });
    expect(router.wakeUsed(S)).toBe(0);
  });

  it("per-run quota: the (quota+1)-th wake:true is downgraded rate_limited; legacy/wake:false still flow", () => {
    const { router } = setup({ level: 0, perRunQuota: 2 });
    expect(send(router, { wake: true })).toMatchObject({ wake: true });
    expect(send(router, { wake: true })).toMatchObject({ wake: true });
    expect(send(router, { wake: true })).toMatchObject({ wake: false, wakeDowngraded: "rate_limited" });
    expect(send(router)).toMatchObject({ ok: true });
    expect(send(router, { wake: false })).toMatchObject({ ok: true, wake: false });
    expect(router.wakeUsed(S)).toBe(2);
  });

  it("a rejected (quota_exhausted / backpressure) wake:true is not counted against the wake class", () => {
    const { router } = setup({ level: 0, perRunQuota: 5 }, { findingQuota: 1 });
    expect(send(router, { wake: true })).toMatchObject({ ok: true, wake: true });
    expect(send(router, { wake: true })).toMatchObject({ ok: false, status: "quota_exhausted" });
    expect(router.wakeUsed(S)).toBe(1);
  });

  it("progress never wakes: wake:true ⇒ invalid_wake before any seq/quota/record is spent; wake:false is fine", () => {
    const { router, engine } = setup({ level: 0 });
    expect(send(router, { kind: "progress", wake: true })).toEqual({
      ok: false,
      status: "invalid_wake",
      reason: "progress_never_wakes",
    });
    expect(engine.select(() => true)).toHaveLength(0);
    expect(send(router, { kind: "progress", wake: false })).toMatchObject({ ok: true, wake: false });
  });

  it("wake:true to a RUNNING non-root target: intent kept verbatim, not gated, not counted (a steer is no wake)", () => {
    const { router, stored } = setup({ level: 2, maxLevel: 2, perRunQuota: 0 });
    const r = router.admit(S, {
      to: T,
      kind: "finding",
      text: "t",
      generation: 1,
      canMessage: ["sibling"],
      wake: true,
    });
    expect(r).toMatchObject({ ok: true, wake: true });
    expect(r).not.toHaveProperty("wakeDowngraded");
    expect(stored((r as { key: string }).key)).toMatchObject({ wake: true, level: 2 });
    expect(router.wakeUsed(S)).toBe(0);
  });

  it("hydrate restores the wake:true-to-root count (a /reload cannot reset the quota)", () => {
    const a = setup({ level: 0, perRunQuota: 1 });
    a.router.admit(S, { to: "root", kind: "finding", text: "t", generation: 1, canMessage: ["parent"], wake: true });
    const b = setup({ level: 0, perRunQuota: 1 });
    b.router.hydrate([...a.engine.select(() => true)]);
    expect(b.router.wakeUsed(S)).toBe(1);
    expect(send(b.router, { wake: true })).toMatchObject({ wake: false, wakeDowngraded: "rate_limited" });
  });
});

describe("router with wake OFF (no wakePolicy) is byte-identical", () => {
  it("never reads `wake`, never stamps level/wake, no result extras; progress+wake:true is NOT invalid_wake", () => {
    const { router, stored } = setup(undefined);
    const r = send(router, { wake: true });
    expect(r).toEqual({ ok: true, status: "accepted", key: expect.any(String), seq: 1 });
    const rec = stored((r as { key: string }).key);
    expect(rec).not.toHaveProperty("level");
    expect(rec).not.toHaveProperty("wake");
    expect(send(router, { kind: "progress", wake: true })).toMatchObject({ ok: true, status: "accepted" });
    expect(router.wakeUsed(S)).toBe(0);
  });
});
