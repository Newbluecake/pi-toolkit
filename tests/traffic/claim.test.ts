/**
 * traffic-merge plan §2.4（Blocker 2）认领协议单测：发布 / 身份校验释放 / 存活端口 /
 * external-active 让位判定 / enabled=false 永不发布（由 assemble 的 gating 保证，这里钉端口语义）。
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  claimIsOurs,
  externalActiveInProcess,
  publishExternalActiveForTest,
  publishToolkitClaim,
  releaseToolkitClaim,
  resetTrafficClaimForTest,
  toolkitClaimIsLive,
} from "../../src/traffic/claim.js";

afterEach(() => {
  resetTrafficClaimForTest();
});

describe("toolkit claim publish/release", () => {
  it("publish makes the claim live with owner identity = the token object", () => {
    const token = {};
    const claim = publishToolkitClaim(token);
    expect(toolkitClaimIsLive()).toBe(true);
    expect(claim.owner).toBe("pi-toolkit");
    expect(claim.pid).toBe(process.pid);
    expect(claim.token).toBe(token);
    expect(claim.isLive()).toBe(true);
  });

  it("release flips isLive and deletes the symbol (authoritative for the tombstone version)", () => {
    const claim = publishToolkitClaim({});
    expect(releaseToolkitClaim(claim)).toBe(true);
    expect(toolkitClaimIsLive()).toBe(false);
    expect(claim.isLive()).toBe(false);
    // idempotent: a second release is a no-op returning false
    expect(releaseToolkitClaim(claim)).toBe(false);
  });

  it("identity check: a stale/other claim cannot release the live one", () => {
    const live = publishToolkitClaim({});
    const stale = publishToolkitClaim({}); // overwrite publish (defensive path)
    const current = publishToolkitClaim({});
    expect(releaseToolkitClaim(live)).toBe(false); // no longer the symbol's claim
    expect(releaseToolkitClaim(stale)).toBe(false);
    expect(toolkitClaimIsLive()).toBe(true);
    expect(releaseToolkitClaim(current)).toBe(true);
    expect(toolkitClaimIsLive()).toBe(false);
  });

  it("a foreign/malformed value on the symbol is not treated as a live toolkit claim", () => {
    (globalThis as Record<symbol, unknown>)[Symbol.for("pi-traffic-record:claim")] = { v: 2 };
    expect(toolkitClaimIsLive()).toBe(false);
    resetTrafficClaimForTest();
    (globalThis as Record<symbol, unknown>)[Symbol.for("pi-traffic-record:claim")] = {
      v: 1,
      owner: "someone-else",
    };
    expect(toolkitClaimIsLive()).toBe(false);
  });

  // ── 安全评审 #4：isLive/token 形状与存活校验 + 主会话自身身份 ──

  it("a RELEASED claim re-attached onto the symbol is no longer live (isLive() flipped false)", () => {
    const claim = publishToolkitClaim({});
    expect(releaseToolkitClaim(claim)).toBe(true);
    // 旧持有者把已释放的 claim 对象挂回符号
    (globalThis as Record<symbol, unknown>)[Symbol.for("pi-traffic-record:claim")] = claim;
    expect(toolkitClaimIsLive()).toBe(false);
    expect(claimIsOurs(claim)).toBe(false);
  });

  it("shapes without token / without isLive / isLive not a function / isLive() false or throwing are rejected", () => {
    const key = Symbol.for("pi-traffic-record:claim");
    const bag = globalThis as Record<symbol, unknown>;
    const pid = process.pid;
    const cases: unknown[] = [
      { v: 1, owner: "pi-toolkit", pid, isLive: () => true }, // 缺 token
      { v: 1, owner: "pi-toolkit", pid, token: {} }, // 缺 isLive
      { v: 1, owner: "pi-toolkit", pid, token: {}, isLive: "yes" }, // isLive 非函数
      { v: 1, owner: "pi-toolkit", pid, token: {}, isLive: () => false }, // 已死
      {
        v: 1,
        owner: "pi-toolkit",
        pid,
        token: {},
        isLive: () => {
          throw new Error("forged");
        },
      }, // 抛错 ⇒ fail closed
      { v: 1, owner: "pi-toolkit", pid, token: null, isLive: () => true }, // token 非对象
    ];
    for (const value of cases) {
      bag[key] = value;
      expect(toolkitClaimIsLive(), JSON.stringify(value)).toBe(false);
    }
    resetTrafficClaimForTest();
  });

  it("claimIsOurs binds the HOST's isActive to its own claim object: a different claim on the symbol defeats it", () => {
    const mine = publishToolkitClaim({});
    expect(claimIsOurs(mine)).toBe(true);
    const other = publishToolkitClaim({}); // 覆盖发布（防御路径/伪造替换）
    expect(claimIsOurs(mine)).toBe(false); // 符号上已不是 mine
    expect(claimIsOurs(other)).toBe(true);
    releaseToolkitClaim(other);
    expect(claimIsOurs(other)).toBe(false);
    expect(claimIsOurs(mine)).toBe(false);
  });
});

describe("external-active marker", () => {
  it("absent by default; present (same pid) after the tombstone version publishes it", () => {
    expect(externalActiveInProcess()).toBe(false);
    publishExternalActiveForTest();
    expect(externalActiveInProcess()).toBe(true);
  });

  it("a marker from another pid or wrong shape is ignored", () => {
    (globalThis as Record<symbol, unknown>)[Symbol.for("pi-traffic-record:external-active")] = {
      v: 1,
      pid: -1,
    };
    expect(externalActiveInProcess()).toBe(false);
    resetTrafficClaimForTest();
    (globalThis as Record<symbol, unknown>)[Symbol.for("pi-traffic-record:external-active")] = {
      v: 3,
      pid: process.pid,
    };
    expect(externalActiveInProcess()).toBe(false);
  });
});
