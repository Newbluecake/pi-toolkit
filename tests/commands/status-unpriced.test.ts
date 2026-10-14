import { describe, expect, it } from "vitest";
import { renderCosts, renderRunDetail } from "../../src/commands/status.js";
import type { RunDiagnostics, RunSnapshot, UsageDelta } from "../../src/core/types.js";
import type { QueryService } from "../../src/service/query-service.js";

/**
 * external-agent plan §3.4 (P4c): `/agent costs` and the run-detail usage line
 * surface the sticky `UsageDelta.unpriced` marker — per-run rows render
 * `unpriced` / `$x.xxxx+?`, the usage line renders `cost:unpriced` /
 * `cost:$x.xxxx+unpriced`, and the grand total discloses `(+N unpriced runs)`.
 * Without the marker every output stays byte-identical to the legacy format.
 */

function snapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    runId: "r1",
    generation: 1,
    status: "completed",
    phase: "settled",
    deadlines: { enqueuedAt: 0, deadlineAt: undefined, queueDeadlineAt: undefined },
    diag: {
      createdAt: 0,
      phase: "settled",
      phaseEnteredAt: 0,
      pendingTools: 0,
      turns: 1,
      escalation: [],
      orphaned: false,
      generation: 1,
      degraded: [],
      staleInputs: 0,
      unkillable: [],
    },
    updatedAt: 0,
    ...overrides,
  };
}

function withUsage(runId: string, usage: UsageDelta, extraDiag: Partial<RunDiagnostics> = {}): RunSnapshot {
  return snapshot({
    runId,
    diag: {
      ...snapshot().diag,
      label: runId,
      settledAt: 10_000,
      usage,
      ...extraDiag,
    },
  });
}

const usage = (costUsd: number, unpriced?: "all" | "partial"): UsageDelta => ({
  input: 10,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  costUsd,
  ...(unpriced === undefined ? {} : { unpriced }),
});

function queryFor(runs: RunSnapshot[]): QueryService {
  return {
    get: () => undefined,
    list: () => runs,
    wait: async () => ({ ok: false, reason: "unknown_run" }),
    waitAll: async () => ({ settled: [], pending: [] }),
    steer: async () => undefined,
    stop: async () => false,
  };
}

describe("P4c /agent costs unpriced rendering", () => {
  it("renders an all-unpriced row as `unpriced` and counts it in the total suffix", () => {
    const priced = withUsage("priced-00", usage(1.5));
    const free = withUsage("droid-000", usage(0, "all"));
    const text = renderCosts(queryFor([priced, free]));
    const lines = text.split("\n");
    const unpricedRow = lines.find((l) => l.includes("droid-000"))!;
    expect(unpricedRow).toContain("unpriced");
    expect(unpricedRow).not.toContain("$0.0000");
    expect(lines.find((l) => l.includes("priced-00"))!).toContain("$1.5000");
    expect(text).toContain("Total: $1.5000");
    expect(text).toContain("(+1 unpriced runs)");
  });

  it("renders a partial row as `$x.xxxx+?`", () => {
    const partial = withUsage("droid-000", usage(0.25, "partial"));
    const text = renderCosts(queryFor([partial]));
    expect(text.split("\n").find((l) => l.includes("droid-000"))!).toContain("$0.2500+?");
    expect(text).toContain("(+1 unpriced runs)");
  });

  it("counts multiple unpriced runs and skips absorbed ones", () => {
    const parent = withUsage("parent-00", usage(0.8), { absorbedRunIds: ["child-000"] });
    const absorbedChild = withUsage("child-000", usage(0, "all"));
    const unpricedTop = withUsage("droid-000", usage(0, "all"));
    const text = renderCosts(queryFor([parent, absorbedChild, unpricedTop]));
    // The absorbed child still shows its row (marked), but the total's
    // unpriced count only covers runs included in the total (parent + droid).
    expect(text.split("\n").find((l) => l.includes("child-000"))!).toContain("(absorbed)");
    expect(text).toContain("Total: $0.8000");
    expect(text).toContain("(+1 unpriced runs)");
  });

  it("is byte-identical to the legacy output when no run is unpriced", () => {
    const a = withUsage("a-000000", usage(0.01));
    const b = withUsage("b-000000", usage(1.5));
    const text = renderCosts(queryFor([a, b]));
    expect(text).toContain("Total: $1.5100");
    expect(text).not.toContain("unpriced");
    expect(text).not.toContain("+?");
    expect(
      text
        .split("\n")
        .find((l) => l.includes("Total:"))!
        .trim(),
    ).toBe("Total: $1.5100 · in:20 out:4 cache_r:0");
  });
});

describe("P4c run-detail usage line", () => {
  it("renders cost:unpriced for an all-unpriced run", () => {
    const run = withUsage("droid-000", usage(0, "all"));
    const text = renderRunDetail(queryFor([run]), "droid-000");
    expect(text).toContain("cost:unpriced");
    expect(text).not.toContain("cost:$0.0000");
  });

  it("renders cost:$x.xxxx+unpriced for a partial run", () => {
    const run = withUsage("droid-000", usage(0.25, "partial"));
    const text = renderRunDetail(queryFor([run]), "droid-000");
    expect(text).toContain("cost:$0.2500+unpriced");
  });

  it("is byte-identical to the legacy usage line when unpriced is absent", () => {
    const run = withUsage("r1", usage(0.0055));
    const text = renderRunDetail(queryFor([run]), "r1");
    expect(text).toContain("Usage: usage=in:10 out:2 cache_r:0 cache_w:0 cost:$0.0055");
    expect(text).not.toContain("unpriced");
  });
});
