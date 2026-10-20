import { describe, expect, it } from "vitest";
import { renderStatus } from "../../src/commands/status.js";
import type { WakeStatusView } from "../../src/fabric/wake.js";

/** Gate G (plan §7): the `/agent status` wake line — absent when wake is off (byte-identical), present when on. */
const deps = () => ({
  query: { list: () => [] } as never,
  orphans: { totalCount: 0, recent: [], lateRecoveredCount: 0 } as never,
  notifier: {
    stats: { staged: 0, pending: 0, batched: 0, delivered: 0, consumed: 0, dropped: 0, abandoned: 0 },
    ackedSuppressions: 0,
    degraded: [],
  } as never,
});
const view: WakeStatusView = {
  maxLevel: 2,
  rootLevel: 0,
  resumesPerHour: 6,
  durability: "session-memory",
  resumesLastHour: 0,
  parked: 1,
  reserved: 0,
  quarantined: 0,
  unverified: 0,
  wakeResults: 0,
  wakeResultsSkipped: 0,
  deadLetters: { target_gone: 2 },
};

describe("/agent status wake line", () => {
  it("is omitted when the port is absent or reports undefined (wake off) — output identical to no port", () => {
    const base = renderStatus(deps());
    expect(base).not.toMatch(/wake on/);
    expect(renderStatus({ ...deps(), wake: () => undefined })).toBe(base);
  });
  it("is one extra line when wake is on, read live at render time", () => {
    const base = renderStatus(deps());
    let v = view;
    const on = renderStatus({ ...deps(), wake: () => v });
    expect(on.split("\n")).toHaveLength(base.split("\n").length + 1);
    expect(on).toContain(
      "wake on · lvl≤2 · root L0 · resumes 0/6h · parked 1 · reserved 0 · unverified 0 · quarantined 0 · durability session-memory · results 0 (skipped 0) · dead target_gone=2",
    );
    v = { ...view, parked: 5 };
    expect(renderStatus({ ...deps(), wake: () => v })).toContain("parked 5");
  });
});
