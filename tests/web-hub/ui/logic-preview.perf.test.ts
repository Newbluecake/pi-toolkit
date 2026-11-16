// @vitest-environment node
import { expect, it } from "vitest";
import { findPathRefs } from "../../../src/web-hub/ui/src/logic/preview.js";

// CPU-only sentinel stays independent of the deterministic charScans gates.
it("5 s wall-clock hang sentinel: the whole input × scope matrix completes", () => {
  const base = { agentKey: "A", sessionId: "s1", cwd: "/home/u/proj", uploads: true };
  const scopes = [base, { ...base, abs: true }, { ...base, dirs: true }, { ...base, abs: true, dirs: true }];
  const inputs = [
    "=/./".repeat(16_384),
    "/".repeat(1 << 20),
    "=/".repeat(1 << 19),
    "/a".repeat(1 << 19),
    "é/".repeat(1 << 19),
    "😀=/".repeat(1 << 18),
  ];
  const t0 = Date.now();
  for (const text of inputs) for (const scope of scopes) findPathRefs(text, scope);
  expect(Date.now() - t0).toBeLessThan(5_000);
});
