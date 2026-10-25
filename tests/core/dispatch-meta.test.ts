import { describe, expect, it } from "vitest";
import {
  DISPATCH_META_ID_RE,
  DISPATCH_META_KEYS,
  parseDispatchMeta,
  pickInheritableDispatchMeta,
} from "../../src/core/dispatch-meta.js";

describe("parseDispatchMeta", () => {
  it("maps undefined to meta:undefined", () => {
    expect(parseDispatchMeta(undefined)).toEqual({ ok: true, meta: undefined });
  });

  it("maps {} to meta:undefined (no fields ever written for an empty object)", () => {
    expect(parseDispatchMeta({})).toEqual({ ok: true, meta: undefined });
  });

  it("accepts every individual field with a valid value", () => {
    expect(parseDispatchMeta({ lane: "L2" })).toEqual({ ok: true, meta: { lane: "L2" } });
    expect(parseDispatchMeta({ packageId: "pkg-1" })).toEqual({ ok: true, meta: { packageId: "pkg-1" } });
    expect(parseDispatchMeta({ feature: "auth.v2" })).toEqual({ ok: true, meta: { feature: "auth.v2" } });
  });

  it("accepts all three fields together", () => {
    const raw = { lane: "L3", packageId: "pkg-9", feature: "f1" };
    expect(parseDispatchMeta(raw)).toEqual({ ok: true, meta: raw });
  });

  it("rejects an unknown key, listing the allowed keys in the error", () => {
    const result = parseDispatchMeta({ lane: "L1", bogus: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("bogus");
      for (const key of DISPATCH_META_KEYS) expect(result.error).toContain(key);
    }
  });

  it("rejects multiple unknown keys at once", () => {
    const result = parseDispatchMeta({ foo: 1, bar: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("foo");
      expect(result.error).toContain("bar");
    }
  });

  it("rejects a non-plain-object raw value (array, string, number, null)", () => {
    for (const bad of [[], "x", 1, null, true]) {
      const result = parseDispatchMeta(bad);
      expect(result.ok).toBe(false);
    }
  });

  it("rejects an invalid lane value", () => {
    const result = parseDispatchMeta({ lane: "L9" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("lane");
  });

  it("rejects the removed abArm key as unknown (#40), with or without packageId", () => {
    for (const raw of [{ packageId: "p1", abArm: "control" }, { abArm: "experts" }]) {
      const result = parseDispatchMeta(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("unknown key(s): abArm");
        expect(result.error).not.toContain("abArm,");
      }
    }
    expect(DISPATCH_META_KEYS).toEqual(["lane", "packageId", "feature"]);
  });

  it("rejects packageId/feature that fail the shared id regex", () => {
    for (const bad of ["", "-leading-dash", "has space", "a".repeat(65)]) {
      expect(DISPATCH_META_ID_RE.test(bad)).toBe(false);
      const r1 = parseDispatchMeta({ packageId: bad });
      expect(r1.ok).toBe(false);
      const r2 = parseDispatchMeta({ feature: bad });
      expect(r2.ok).toBe(false);
    }
  });

  it("accepts the full id charset at the max length boundary", () => {
    const id64 = "a" + "Z9._:/#-".repeat(8); // 1 + 64 = 65 chars... keep exactly 64
    const exact64 = id64.slice(0, 64);
    expect(exact64).toHaveLength(64);
    expect(parseDispatchMeta({ packageId: exact64 })).toEqual({ ok: true, meta: { packageId: exact64 } });
  });

  it("rejects a non-string value for a known field", () => {
    expect(parseDispatchMeta({ lane: 2 }).ok).toBe(false);
    expect(parseDispatchMeta({ packageId: 123 }).ok).toBe(false);
    expect(parseDispatchMeta({ feature: null }).ok).toBe(false);
  });

  describe("plain-object check (review §8 M2): Date / class instances / custom prototypes are rejected, only own fields are read", () => {
    it("rejects a Date", () => {
      const result = parseDispatchMeta(new Date());
      expect(result.ok).toBe(false);
    });

    it("rejects a class instance even when it carries allowed-looking own fields", () => {
      class Meta {
        packageId = "pkg-1";
        lane = "L1" as const;
      }
      const result = parseDispatchMeta(new Meta());
      expect(result.ok).toBe(false);
    });

    it("rejects an object whose prototype exposes an inherited field — never treats it as provided", () => {
      const proto = { packageId: "inherited" };
      const obj = Object.create(proto);
      obj.lane = "L1";
      const result = parseDispatchMeta(obj);
      // Custom (non-Object.prototype, non-null) prototype ⇒ rejected outright —
      // the inherited packageId is never read as if it were an own field.
      expect(result.ok).toBe(false);
    });

    it("rejects other common non-plain-object shapes (Map, RegExp, function)", () => {
      expect(parseDispatchMeta(new Map()).ok).toBe(false);
      expect(parseDispatchMeta(/x/).ok).toBe(false);
      expect(parseDispatchMeta(() => undefined).ok).toBe(false);
    });

    it("accepts a literal object literal and an Object.create(null) dictionary with only own fields", () => {
      expect(parseDispatchMeta({ packageId: "pkg-1" })).toEqual({ ok: true, meta: { packageId: "pkg-1" } });
      const dict = Object.create(null) as Record<string, unknown>;
      dict.packageId = "pkg-2";
      expect(parseDispatchMeta(dict)).toEqual({ ok: true, meta: { packageId: "pkg-2" } });
    });

    it("never reads a field through a polluted Object.prototype — own-fields-only defense", () => {
      const POLLUTED_KEY = "packageId";
      // eslint-disable-next-line no-extend-native
      Object.defineProperty(Object.prototype, POLLUTED_KEY, {
        value: "polluted",
        configurable: true,
        enumerable: true,
        writable: true,
      });
      try {
        const plain = {}; // proto === Object.prototype, but packageId itself is NOT an own field
        const result = parseDispatchMeta(plain);
        // No own fields at all ⇒ treated exactly like {} (meta: undefined), never "polluted".
        expect(result).toEqual({ ok: true, meta: undefined });
      } finally {
        delete (Object.prototype as Record<string, unknown>).packageId;
      }
    });
  });
});

describe("pickInheritableDispatchMeta (resume inheritance, #40)", () => {
  it("copies lane/packageId/feature and drops a legacy persisted abArm", () => {
    expect(pickInheritableDispatchMeta({ lane: "L2", packageId: "p", feature: "f", abArm: "experts" })).toEqual({
      lane: "L2",
      packageId: "p",
      feature: "f",
    });
  });

  it("returns undefined when nothing inheritable remains (abArm-only, empty, absent, non-object)", () => {
    expect(pickInheritableDispatchMeta({ abArm: "control" })).toBeUndefined();
    expect(pickInheritableDispatchMeta({})).toBeUndefined();
    expect(pickInheritableDispatchMeta(undefined)).toBeUndefined();
    expect(pickInheritableDispatchMeta("x")).toBeUndefined();
  });

  it("does not mutate its input", () => {
    const prev = { packageId: "p", abArm: "experts" };
    pickInheritableDispatchMeta(prev);
    expect(prev).toEqual({ packageId: "p", abArm: "experts" });
  });
});
