import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSecureConfig, vaultMountState } from "../../src/secure/config.js";
import { hubSafeEnv } from "../../src/secure/env.js";

/**
 * P1↔P2 contract parity (data-encryption plan r4 §2.4 「与 helper 同源，parity 测试」). The launcher's
 * own tests run the SAME fixture against `src/secure/bin/helper.mjs`; the two implementations never
 * import each other.
 */
interface Fixture {
  home: string;
  settings: Array<{ name: string; input: unknown; expect: unknown; probe?: string[] }>;
  mountinfo: Array<{ name: string; mountinfo: string; realMnt: string; realCipher: string; expect: string }>;
  hubSafeEnv: Array<{
    name: string;
    input: Record<string, string>;
    expect: Record<string, string>;
    identity?: boolean;
  }>;
}

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/secure-contract-parity.json", import.meta.url), "utf8"),
) as Fixture;

describe("secure contract parity — settings `secure` section", () => {
  it("fixture is non-trivial", () => {
    expect(fixture.settings.length).toBeGreaterThanOrEqual(10);
    expect(fixture.mountinfo.length).toBeGreaterThanOrEqual(8);
    expect(fixture.hubSafeEnv.length).toBeGreaterThanOrEqual(6);
  });
  for (const c of fixture.settings) {
    it(c.name, () => {
      const io = { legacyMntDir: (mnt: string) => (c.probe ?? []).includes(mnt) };
      expect(JSON.parse(JSON.stringify(parseSecureConfig(c.input, fixture.home, io)))).toEqual(c.expect);
    });
  }
});

describe("secure contract parity — mountinfo", () => {
  for (const c of fixture.mountinfo) {
    it(c.name, () => {
      expect(vaultMountState(c.mountinfo, c.realMnt, c.realCipher)).toBe(c.expect);
    });
  }
});

describe("secure contract parity — hubSafeEnv", () => {
  for (const c of fixture.hubSafeEnv) {
    it(c.name, () => {
      const input = { ...c.input };
      const out = hubSafeEnv(input);
      expect(out).toEqual(c.expect);
      if (c.identity) expect(out).toBe(input);
      else expect(out).not.toBe(input);
      expect(input).toEqual(c.input); // never mutates its argument
      expect(Object.keys(out).some((k) => k.startsWith("PI_SECURE_"))).toBe(false);
    });
  }
});
