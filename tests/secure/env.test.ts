/**
 * private-plan §2.4 (N3): the new `PI_SECURE_NS` env key rides the existing PI_SECURE_*
 * contract. `hubSafeEnv`'s semantics are UNCHANGED (freeze: existing meaning intact) — the
 * prefix strip already covers the new key; this suite pins exactly that, plus that the
 * restored-key logic never treats the hint as a session marker.
 *
 * (The parity-fixture append for `PI_SECURE_NS` + `parsePrivateRecord` lands with N1, which owns
 * the helper-side copy; see docs/dev/data-encryption/N3-report.md.)
 */
import { describe, expect, it } from "vitest";
import { hubSafeEnv, PI_SECURE_NS, PI_SECURE_PREFIX } from "../../src/secure/env.js";

describe("hubSafeEnv — PI_SECURE_NS (private-plan §2.4)", () => {
  it("PI_SECURE_NS never leaks: stripped like every PI_SECURE_* key", () => {
    const out = hubSafeEnv({
      HOME: "/home/u",
      PI_SECURE_NS: "1",
      PI_SECURE_VAULT: "acme",
      PI_SECURE_SESSION: "1",
    });
    expect(out).toEqual({ HOME: "/home/u" });
    expect(Object.keys(out).some((k) => k.startsWith(PI_SECURE_PREFIX))).toBe(false);
  });

  it("PI_SECURE_NS alone does NOT delete TMPDIR (it is a hint, not a session marker)", () => {
    // only PI_SECURE_SESSION=1 (or an ORIG snapshot) directs the restore logic — the ns hint
    // must not change hubSafeEnv's existing semantics in any other way.
    const env = { TMPDIR: "/tmp", PI_SECURE_NS: "1" };
    const out = hubSafeEnv(env);
    expect(out).toEqual({ TMPDIR: "/tmp" });
  });

  it("const spelling: the key carries the PI_SECURE_ prefix", () => {
    expect(PI_SECURE_NS).toBe("PI_SECURE_NS");
    expect(PI_SECURE_NS.startsWith(PI_SECURE_PREFIX)).toBe(true);
  });
});
