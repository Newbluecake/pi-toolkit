import { describe, expect, it } from "vitest";
import {
  createSessionPoisonRegistry,
  SESSION_POISON_CAPACITY,
  sharedSessionPoisonRegistry,
  type SessionManagerIdentity,
  type SessionRecoveryReceipt,
} from "../../../src/memory/scopes/session-poison.js";

const forged = () => Object.freeze({}) as SessionRecoveryReceipt;
function poisoned() {
  const registry = createSessionPoisonRegistry();
  const failed = {};
  registry.mark("a", "E_PERSIST_UNKNOWN", registry.captureManager(failed));
  return { registry, failed, authority: registry.recoveryAuthority() };
}
describe("manager-qualified shared poison", () => {
  it("IDs are opaque stable per actual object, nonreusable across objects, registry-local", () => {
    const r = createSessionPoisonRegistry(),
      a = {},
      b = {};
    expect(r.captureManager(a)).toBe(r.captureManager(a));
    expect(r.captureManager(a)).not.toBe(r.captureManager(b));
    expect(Object.keys(r.captureManager(a)!)).toEqual([]);
    expect(r.captureManager(a)).not.toBe(createSessionPoisonRegistry().captureManager(a));
    expect(r.captureManager("caller ID" as unknown as object)).toBeUndefined();
    expect(r.captureManager(null as unknown as object)).toBeUndefined();
  });
  it("same manager reload/rebind and new/fork/tree/startup cannot issue", () => {
    const { registry, authority, failed } = poisoned();
    expect(authority.recordReopen("a", "resume", failed)).toBeUndefined();
    for (const reason of ["reload", "new", "fork", "tree", "startup"]) {
      expect(authority.recordReopen("a", reason as "resume", {})).toBeUndefined();
    }
    expect(registry.code("a")).toBe("E_PERSIST_UNKNOWN");
    expect(registry.code("new-sid")).toBeUndefined();
  });
  it("exact new actual manager + one receipt + tombstone CAS, never caller string", () => {
    const { registry, authority } = poisoned();
    const actual = {},
      foreign = {};
    expect(authority.recordReopen("a", "resume", "id" as unknown as object)).toBeUndefined();
    const receipt = authority.recordReopen("a", "resume", actual)!;
    expect(authority.verify(receipt, "a", foreign, () => true)).toBe(false);
    expect(authority.verify(receipt, "a", actual, () => true)).toBe(false);
    expect(authority.recordReopen("a", "resume", actual)).toBeUndefined();
    const next = {};
    const accepted = authority.recordReopen("a", "resume", next)!;
    expect(authority.verify(accepted, "a", next, () => true)).toBe(true);
    expect(registry.code("a")).toBeUndefined();
    expect(authority.verify(accepted, "a", next, () => true)).toBe(false);
  });
  it("first qualified manager attempt is sticky across authorities/activations and failed checks", () => {
    const { registry, authority } = poisoned();
    const manager = {};
    const token = authority.recordReopen("a", "resume", manager)!;
    expect(authority.verify(token, "a", manager, () => false)).toBe(false);
    authority.dispose();
    expect(registry.recoveryAuthority().recordReopen("a", "resume", manager)).toBeUndefined();
    const beforeFailure = {};
    expect(registry.recoveryAuthority().recordReopen("missing", "resume", beforeFailure)).toBeUndefined();
    expect(registry.recoveryAuthority().recordReopen("a", "resume", beforeFailure)).toBeUndefined();
    expect(registry.code("a")).toBe("E_PERSIST_UNKNOWN");
  });
  it("legacy/forged/foreign IDs cannot acquire recoverable failed-manager metadata", () => {
    for (const id of [undefined, {} as SessionManagerIdentity, createSessionPoisonRegistry().captureManager({})]) {
      const r = createSessionPoisonRegistry();
      r.mark("legacy", "E_PERSIST_UNKNOWN", id);
      expect(r.recoveryAuthority().recordReopen("legacy", "resume", {})).toBeUndefined();
      expect(r.code("legacy")).toBe("E_PERSIST_UNKNOWN");
    }
  });
  it("pre-failure, older tombstone, reentrant newer failure, disposed authority and foreign receipts deny", () => {
    const { registry, authority } = poisoned();
    const manager = {};
    const old = authority.recordReopen("a", "resume", manager)!;
    registry.mark("a", "E_PERSIST_UNKNOWN", registry.captureManager({}));
    expect(authority.verify(old, "a", manager, () => true)).toBe(false);
    const next = {},
      token = authority.recordReopen("a", "resume", next)!;
    expect(
      authority.verify(token, "a", next, () => {
        registry.mark("a", "E_PERSIST_UNKNOWN", registry.captureManager({}));
        return true;
      }),
    ).toBe(false);
    const last = {},
      disposed = authority.recordReopen("a", "resume", last)!;
    authority.dispose();
    expect(authority.verify(disposed, "a", last, () => true)).toBe(false);
    expect(authority.recordReopen("a", "resume", {})).toBeUndefined();
    expect(registry.recoveryAuthority().verify(forged(), "a", {}, () => true)).toBe(false);
    expect(registry.code("a")).toBe("E_PERSIST_UNKNOWN");
  });
  it("throwing branch/dispose during verify does not clear or replay", () => {
    const { registry, authority } = poisoned();
    for (const verify of [
      () => {
        throw new Error("read");
      },
      () => {
        authority.dispose();
        return true;
      },
    ]) {
      const manager = {},
        receipt = authority.recordReopen("a", "resume", manager)!;
      expect(authority.verify(receipt, "a", manager, verify)).toBe(false);
      expect(registry.code("a")).toBe("E_PERSIST_UNKNOWN");
    }
  });
  it("256 cap, explicit tracked recovery, no TTL/LRU; overflow stays fail-closed", () => {
    const r = createSessionPoisonRegistry(),
      failed = {};
    for (let i = 0; i < SESSION_POISON_CAPACITY; i++) r.mark(`s${i}`, "E_PERSIST_UNKNOWN", r.captureManager(failed));
    expect(r.code("extra")).toBe("E_PERSIST_UNKNOWN");
    const a = r.recoveryAuthority(),
      manager = {};
    expect(a.verify(a.recordReopen("s0", "resume", manager)!, "s0", manager, () => true)).toBe(true);
    expect(r.code("s0")).toBeUndefined();
    r.mark("s0", "E_PERSIST_UNKNOWN", r.captureManager(failed));
    r.mark("overflow", "E_PERSIST_UNKNOWN", r.captureManager(failed));
    expect(r.code("s0")).toBe("E_PERSIST_UNKNOWN");
    const other = {};
    expect(a.recordReopen("s0", "resume", other)).toBeUndefined();
    expect(r.code("overflow")).toBe("E_PERSIST_UNKNOWN");
  });
  it("shared global ordinary reload retains record and weak first-attempt metadata", () => {
    const r = sharedSessionPoisonRegistry(),
      failed = {},
      next = {};
    r.mark("shared-manager-unit", "E_PERSIST_UNKNOWN", r.captureManager(failed));
    const a = r.recoveryAuthority(),
      receipt = a.recordReopen("shared-manager-unit", "resume", next)!;
    expect(a.verify(receipt, "shared-manager-unit", next, () => false)).toBe(false);
    expect(sharedSessionPoisonRegistry()).toBe(r);
    expect(sharedSessionPoisonRegistry().code("shared-manager-unit")).toBe("E_PERSIST_UNKNOWN");
    expect(
      sharedSessionPoisonRegistry().recoveryAuthority().recordReopen("shared-manager-unit", "resume", next),
    ).toBeUndefined();
  });
  it("old-shaped global keeps original map/code, denies even late old-authority clearing; never resets", () => {
    const key = Symbol.for("pi-subagent:memory-session-poison");
    const host = globalThis as typeof globalThis & { [key: symbol]: unknown };
    const previous = host[key];
    const entries = new Map<string, "E_PERSIST" | "E_PERSIST_UNKNOWN">([["old", "E_PERSIST"]]);
    const legacy = {
      code: (identity: string) => entries.get(identity),
      mark: (identity: string, code: "E_PERSIST" | "E_PERSIST_UNKNOWN") => {
        entries.set(identity, code);
      },
    };
    try {
      host[key] = legacy; // only own isolated global fixture; no production reset API exists
      const preserved = sharedSessionPoisonRegistry();
      expect(preserved.diagnostic).toBe("legacy-shape-fail-closed");
      expect(preserved.code("old")).toBe("E_PERSIST");
      expect(entries.get("old")).toBe("E_PERSIST");
      expect(preserved.captureManager({})).toBeUndefined();
      expect(preserved.recoveryAuthority().recordReopen("old", "resume", {})).toBeUndefined();
      expect(sharedSessionPoisonRegistry()).toBe(preserved);
      expect(preserved.code("untracked")).toBe("E_PERSIST_UNKNOWN");
      entries.delete("old"); // simulate late v1 authority, not new-kernel global clear
      expect(preserved.code("old")).toBe("E_PERSIST_UNKNOWN");
    } finally {
      host[key] = previous;
    }
  });
});
