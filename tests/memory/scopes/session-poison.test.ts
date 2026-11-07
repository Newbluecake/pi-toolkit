import { describe, expect, it } from "vitest";
import {
  createSessionPoisonRegistry,
  SESSION_POISON_CAPACITY,
  sharedSessionPoisonRegistry,
  type SessionRecoveryReceipt,
} from "../../../src/memory/scopes/session-poison.js";

describe("reload-stable content-free poison", () => {
  it("shared port retains identity across factory consumers; different sid/new/fork keys do not inherit failure", () => {
    const a = sharedSessionPoisonRegistry();
    a.mark("unit-poison-reload", "E_PERSIST_UNKNOWN");
    expect(sharedSessionPoisonRegistry().code("unit-poison-reload")).toBe("E_PERSIST_UNKNOWN");
    expect(a.code("unit-poison-new")).toBeUndefined();
    expect(a.code("unit-poison-fork")).toBeUndefined();
  });
  it("256 tombstones, no eviction/TTL forgiveness, saturation denies untracked identities", () => {
    const registry = createSessionPoisonRegistry();
    for (let i = 0; i < SESSION_POISON_CAPACITY; i++) registry.mark(`s${i}`, "E_PERSIST_UNKNOWN");
    expect(registry.code("s0")).toBe("E_PERSIST_UNKNOWN");
    expect(registry.code("untracked")).toBe("E_PERSIST_UNKNOWN");
    registry.mark("overflow", "E_PERSIST_UNKNOWN");
    expect(registry.code("s0")).toBe("E_PERSIST_UNKNOWN");
    expect(registry.code("overflow")).toBe("E_PERSIST_UNKNOWN");
    const recovery = registry.recoveryAuthority();
    expect(recovery.verify(recovery.recordReopen("s0", "reopen"), "s0", () => true)).toBe(false);
    expect(registry.code("overflow")).toBe("E_PERSIST_UNKNOWN");
  });
  it("full table can free a tracked slot only by explicit verified recovery before overflow", () => {
    const r = createSessionPoisonRegistry();
    for (let i = 0; i < SESSION_POISON_CAPACITY; i++) r.mark(`s${i}`, "E_PERSIST_UNKNOWN");
    const authority = r.recoveryAuthority();
    expect(authority.verify(authority.recordReopen("s0", "reopen"), "s0", () => true)).toBe(true);
    expect(r.code("s0")).toBeUndefined();
    expect(r.code("s1")).toBe("E_PERSIST_UNKNOWN");
  });
  it("receipt is opaque, identity-bound, one-shot, and issued after the observed failure", () => {
    const r = createSessionPoisonRegistry();
    const host = r.recoveryAuthority();
    const old = host.recordReopen("a", "reopen");
    r.mark("a", "E_PERSIST_UNKNOWN");
    expect(host.verify(old, "a", () => true)).toBe(false);
    expect(host.verify({} as SessionRecoveryReceipt, "a", () => true)).toBe(false);
    const wrong = host.recordReopen("a", "new");
    expect(host.verify(wrong, "b", () => true)).toBe(false);
    expect(host.verify(wrong, "a", () => true)).toBe(false);
    const receipt = host.recordReopen("a", "reopen");
    expect(host.verify(receipt, "a", () => true)).toBe(true);
    expect(r.code("a")).toBeUndefined();
    expect(host.verify(receipt, "a", () => true)).toBe(false);
  });
  it("throwing/failed verification and reentrant newer poison do not clear; no replay", () => {
    const r = createSessionPoisonRegistry();
    const host = r.recoveryAuthority();
    r.mark("a", "E_PERSIST_UNKNOWN");
    for (const verify of [
      () => false,
      () => {
        throw new Error("read");
      },
      () => {
        r.mark("a", "E_PERSIST_UNKNOWN");
        return true;
      },
    ]) {
      const token = host.recordReopen("a", "reopen");
      expect(host.verify(token, "a", verify)).toBe(false);
      expect(r.code("a")).toBe("E_PERSIST_UNKNOWN");
      expect(host.verify(token, "a", () => true)).toBe(false);
    }
  });
});
