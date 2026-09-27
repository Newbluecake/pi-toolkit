import { describe, expect, it } from "vitest";
import {
  childActivationAdvanced,
  childActivationSnapshot,
  markChildExtensionActivated,
} from "../../src/child/activation-signal.js";

/**
 * todo #27 (child-extension-missing diagnostic): pure unit coverage for the
 * process-wide activation counter itself, isolated from session-driver.ts /
 * createAgentSession so it doesn't need any pi mocking. The counter lives on
 * a `Symbol.for` global (survives module reload) and is monotonic for the
 * lifetime of the process, so every test here only ever compares deltas
 * against a snapshot taken at the START of that test — never an absolute
 * value — to stay independent of test execution order.
 */
describe("child/activation-signal: process-wide child activation counter", () => {
  it("advanced() is false when nothing marked activation since the snapshot", () => {
    const before = childActivationSnapshot();
    expect(childActivationAdvanced(before)).toBe(false);
  });

  it("advanced() becomes true after markChildExtensionActivated() runs", () => {
    const before = childActivationSnapshot();
    markChildExtensionActivated();
    expect(childActivationAdvanced(before)).toBe(true);
  });

  it("the counter is monotonic: multiple marks all count, snapshot always non-decreasing", () => {
    const s1 = childActivationSnapshot();
    markChildExtensionActivated();
    const s2 = childActivationSnapshot();
    markChildExtensionActivated();
    markChildExtensionActivated();
    const s3 = childActivationSnapshot();
    expect(s2).toBeGreaterThan(s1);
    expect(s3).toBeGreaterThan(s2);
    // A snapshot taken AFTER a mark never itself looks "advanced" relative to itself.
    expect(childActivationAdvanced(s3)).toBe(false);
  });

  it("a snapshot taken before several concurrent-looking marks sees advancement from ANY of them (process-wide, not per-call, semantics)", () => {
    const before = childActivationSnapshot();
    markChildExtensionActivated(); // simulates a sibling concurrent spawn's own activation
    markChildExtensionActivated();
    expect(childActivationAdvanced(before)).toBe(true);
  });
});
