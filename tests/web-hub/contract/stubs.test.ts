/**
 * Contract test ①（plan §11 表格）: every stub carved out by the W1 interface
 * package throws `E_NOT_IMPLEMENTED:<pkg>` (message includes the package
 * name) when called, and does nothing else observable. When W2/W3 fills in a
 * package, the corresponding `it(...)` below MUST be deleted — its continued
 * presence/pass would mean the stub was never replaced.
 *
 * S1-W3 LD has filled in `lan-assembly.ts`'s `defaultLanAssembly.build` —
 * every stub this file ever guarded has now been replaced, so there is
 * nothing left to assert here (an empty `describe` would just be dead
 * weight); see `hub-lan.test.ts` and `hub-lan-config.test.ts` for the real
 * coverage that replaced it.
 */
import { describe, it } from "vitest";

describe("W1 stubs throw E_NOT_IMPLEMENTED:<pkg> (contract ①)", () => {
  it("no stubs remain (S1-W2/W3 filled in LP, LC and LD)", () => {
    // Intentionally empty — see file header.
  });
});
