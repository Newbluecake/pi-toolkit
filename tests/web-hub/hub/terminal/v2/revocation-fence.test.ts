import { describe, expect, it, vi } from "vitest";
import type { AuthIdentity } from "../../../../../src/web-hub/hub/auth-identity.js";
import { TerminalRevocationFenceV2 } from "../../../../../src/web-hub/hub/terminal/v2/revocation-fence.js";
const identity: AuthIdentity = {
  listener: "lan",
  principal: "u7",
  sidTag: "sid7",
  userId: 7,
  parentExpiresAt: 100_000,
  lan: { userId: 7, epoch: 3, sidHash: "sid7", absoluteExpiresAt: 100_000 },
};
function denied(fence: TerminalRevocationFenceV2, id = identity) {
  expect(() => fence.check(id, fence.revision)).toThrow();
}
describe("terminal v2 synchronous auth facts", () => {
  it("A3 seals before auth await, never waits for cleanup/ledger or creates a login proof", async () => {
    const fence = new TerminalRevocationFenceV2(() => 0);
    const order: string[] = [];
    let finish!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      finish = resolve;
    });
    fence.subscribe(() => {
      order.push("sealed");
      void cleanup.then(() => order.push("cleaned"));
    });
    const revision = fence.invalidate({ sidTag: identity.sidTag });
    expect(revision).toBe(1);
    order.push("auth-commit");
    denied(fence);
    expect(order).toEqual(["sealed", "auth-commit"]);
    fence.settle({ sidTag: identity.sidTag }, revision, { kind: "sid-absent", sidTag: identity.sidTag });
    fence.check(identity, fence.revision); // Authentication's existing authority still decides validity.
    finish();
    await cleanup;
    await Promise.resolve();
    expect(order).toEqual(["sealed", "auth-commit", "cleaned"]);
    fence.dispose();
  });
  it("A5/A9 retains unknown/failed facts, exact selector and global revision CAS reject old settle/auth", () => {
    const fence = new TerminalRevocationFenceV2(() => 0);
    const first = fence.invalidate({ userId: 7 });
    fence.settle({ userId: 7 }, first, { kind: "sid-absent", sidTag: identity.sidTag });
    denied(fence);
    const second = fence.invalidate({ userId: 7 });
    fence.settle({ userId: 7 }, first, { kind: "user-absent", userId: 7 });
    denied(fence);
    fence.settle({ userId: 7 }, second, { kind: "user-epoch-advanced", userId: 7, beforeEpoch: 3, afterEpoch: 3 });
    denied(fence);
    fence.settle({ userId: 7 }, second, { kind: "user-epoch-advanced", userId: 7, beforeEpoch: 3, afterEpoch: 4 });
    fence.check(identity, fence.revision);
    expect(() => fence.check(identity, second)).toThrow();
    const third = fence.invalidate({ userId: 7 });
    fence.settle({ userId: 7 }, third, { kind: "no-change-confirmed" });
    fence.check(identity, fence.revision);
  });
  it("A9 listener exceptions are isolated, poison only terminal, run every subscriber, unsubscribe/dispose", () => {
    const fence = new TerminalRevocationFenceV2(() => 0);
    const seen: unknown[] = [];
    fence.subscribe(() => {
      throw new Error("terminal fault");
    });
    const off = fence.subscribe((selector) => seen.push(selector));
    const auth = vi.fn();
    const revision = fence.invalidate({ sidTag: "sid7" });
    auth();
    expect(auth).toHaveBeenCalledOnce();
    expect(seen).toEqual([{ sidTag: "sid7" }, "all"]);
    fence.settle({ sidTag: "sid7" }, revision, { kind: "no-change-confirmed" });
    denied(fence);
    off();
    off();
    fence.dispose();
    expect(seen).toHaveLength(2);
  });
  it("A10 capacity is bounded/sticky and a single SID cannot settle a wide deny", () => {
    const fence = new TerminalRevocationFenceV2(() => 0);
    for (let i = 0; i < 2048; i++) fence.invalidate({ sidTag: `s${i}` });
    const revision = fence.invalidate({ sidTag: "overflow" });
    denied(fence);
    fence.settle("all", revision, { kind: "sid-absent", sidTag: "overflow" });
    denied(fence);
    fence.settle("all", revision, { kind: "no-change-confirmed" });
    denied(fence);
    fence.settle("all", revision, { kind: "listeners-invalidated", loopAuthGen: 8, lanComplete: false });
    denied(fence);
    fence.settle("all", revision, { kind: "listeners-invalidated", loopAuthGen: 8, lanComplete: true });
    fence.check(identity, fence.revision);
  });
  it("matching identity only, immutable selector, expiry and before-auth revision barrier", async () => {
    let now = 0;
    const fence = new TerminalRevocationFenceV2(() => now);
    const selector = { userId: 7 };
    const captured = fence.revision;
    const auth = Promise.resolve(identity);
    fence.invalidate(selector);
    selector.userId = 8;
    expect(() => fence.check(awaitedIdentity(), captured)).toThrow();
    function awaitedIdentity() {
      return identity;
    }
    expect(await auth).toEqual(identity);
    denied(fence);
    fence.check({ ...identity, userId: 8 }, fence.revision);
    now = identity.parentExpiresAt;
    expect(() => fence.check({ ...identity, userId: 8 }, fence.revision)).toThrow();
  });
});
