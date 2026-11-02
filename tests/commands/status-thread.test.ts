import { describe, expect, it } from "vitest";
import { renderStatus } from "../../src/commands/status.js";

/**
 * fabric-thread P4 (arch §6.7/§8.2 ③): the `/agent status` thread line — one line from the
 * stack's `ThreadStackSurface.statusLine()` (already carrying the ` · cfg clamped` suffix when
 * the shared window clamp changed a leaf), absent entirely while threads are off (G2a — the
 * pre-feature output stays byte-identical).
 */
const deps = () => ({
  query: { list: () => [] } as never,
  orphans: { totalCount: 0, recent: [], lateRecoveredCount: 0 } as never,
  notifier: {
    stats: { staged: 0, pending: 0, batched: 0, delivered: 0, consumed: 0, dropped: 0, abandoned: 0 },
    ackedSuppressions: 0,
    degraded: [],
  } as never,
});

describe("/agent status thread line (fabric-thread P4)", () => {
  it("is omitted when the port is absent or reports undefined (threads off) — byte-identical output", () => {
    const base = renderStatus(deps());
    expect(base).not.toMatch(/thread subs/);
    expect(renderStatus({ ...deps(), threads: () => undefined })).toBe(base);
  });

  it("is one extra line when threads are on, read live at render time", () => {
    const base = renderStatus(deps());
    let line = "thread subs 1 · routed 3 · slow 0 · handback 0 · unknown 0";
    const on = renderStatus({ ...deps(), threads: () => line });
    expect(on.split("\n")).toHaveLength(base.split("\n").length + 1);
    expect(on).toContain(line);
    // live read: a later poll sees the new counters without rebuilding anything
    line = "thread subs 0 · routed 9 · slow 1 · handback 2 · unknown 0 · cfg clamped";
    expect(renderStatus({ ...deps(), threads: () => line })).toContain("routed 9 · slow 1 · handback 2");
    expect(renderStatus({ ...deps(), threads: () => line })).toContain("cfg clamped");
  });
});
