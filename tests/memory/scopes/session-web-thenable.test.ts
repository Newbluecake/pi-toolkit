import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/** A real Node process with strict unhandled rejections; Vitest cannot mask a crash. */
describe("session Web append thenable rejection observation", () => {
  it.each([
    ["resolved", "resolved Promise"],
    ["rejected-immediate", "immediately rejected Promise"],
    ["rejected-later", "Promise rejected after unknown was returned"],
  ] as const)("returns unknown and exits 0 for %s: %s", (mode) => {
    const child = spawnSync(
      process.execPath,
      ["--unhandled-rejections=strict", "--import", "tsx", "tests/memory/scopes/session-web-thenable-probe.ts", mode],
      { cwd: process.cwd(), encoding: "utf8", timeout: 15_000 },
    );
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.signal, child.stderr).toBeNull();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stderr).not.toContain("APPEND_REJECT_PROBE");
    expect(child.stderr).not.toContain("APPEND_LATE_REJECT_PROBE");
    expect(JSON.parse(child.stdout)).toMatchObject({
      mode,
      outcome: { ok: false, effect: "unknown", code: "E_PERSIST_UNKNOWN" },
      appends: 1,
      consumes: 1,
      poisoned: true,
      lateRejectionStarted: mode === "rejected-later",
    });
  });
});
