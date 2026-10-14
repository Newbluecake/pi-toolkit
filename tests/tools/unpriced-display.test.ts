import { describe, expect, it } from "vitest";
import { buildFleetViewModel } from "../../src/ui/fleet-panel.js";
import { buildFleetWidgetLines, formatWidgetCost } from "../../src/ui/fleet-widget.js";
import { buildProgressLines, formatOutcomeSummary } from "../../src/tools/agent-tool.js";
import { createResultTool } from "../../src/tools/result-tool.js";
import type { QueryService } from "../../src/service/query-service.js";
import type { RunDiagnostics, RunOutcome, RunSnapshot, UsageDelta } from "../../src/core/types.js";

/**
 * external-agent plan §3.4 (P4c): the sticky `UsageDelta.unpriced` marker
 * ("all" | "partial") drives every cost rendering — display surfaces never
 * infer unpriced-ness from costUsd≈0. Every assertion pair pins BOTH the new
 * rendering and the byte-identical legacy output when the marker is absent.
 */

function diag(overrides: Partial<RunDiagnostics> = {}): RunDiagnostics {
  return {
    createdAt: 0,
    phase: "model_turn",
    phaseEnteredAt: 0,
    pendingTools: 0,
    turns: 2,
    escalation: [],
    orphaned: false,
    generation: 1,
    degraded: [],
    staleInputs: 0,
    unkillable: [],
    ...overrides,
  };
}

function snapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    runId: "run-1",
    generation: 1,
    status: "running",
    phase: "model_turn",
    deadlines: { enqueuedAt: 0, deadlineAt: undefined, queueDeadlineAt: undefined },
    diag: diag(),
    updatedAt: 0,
    ...overrides,
  };
}

function completedOutcome(overrides: Partial<RunOutcome> = {}): RunOutcome {
  return {
    runId: "run-1",
    status: "completed",
    text: "done",
    turns: 5,
    durationMs: 78_000,
    usage: { input: 4204, output: 590, cacheRead: 0, cacheWrite: 0, costUsd: 0.156 },
    diag: diag({ phase: "settled" }),
    ...overrides,
  };
}

const usage = (costUsd: number, unpriced?: "all" | "partial"): UsageDelta => ({
  input: 10,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  costUsd,
  ...(unpriced === undefined ? {} : { unpriced }),
});

const NOW = 10_000;
const OPTS = { now: NOW, idleBudgetMs: 1000 };

describe("P4c formatWidgetCost", () => {
  it("is byte-identical to the legacy rendering when unpriced is absent", () => {
    expect(formatWidgetCost(0)).toBe("$0.0000");
    expect(formatWidgetCost(0.000312)).toBe("$0.0003");
    expect(formatWidgetCost(0.005)).toBe("$0.01");
    expect(formatWidgetCost(1.05)).toBe("$1.05");
    // Explicit undefined must behave exactly like the old single-arg call.
    expect(formatWidgetCost(1.05, undefined)).toBe("$1.05");
  });

  it('renders "all" as the bare unpriced token, never "$0.0000"', () => {
    expect(formatWidgetCost(0, "all")).toBe("unpriced");
    // costUsd is structurally 0 for all-unpriced, but even a stray value is hidden.
    expect(formatWidgetCost(1.5, "all")).toBe("unpriced");
  });

  it('renders "partial" as the priced portion plus +?', () => {
    expect(formatWidgetCost(1.234, "partial")).toBe("$1.23+?");
    expect(formatWidgetCost(0.00412, "partial")).toBe("$0.0041+?");
  });

  it('keeps "$0.0000+?" when the priced portion of a partial rounds to zero', () => {
    // Acceptance ②: a partially-priced run whose billable part is sub-0.1¢
    // must NOT collapse to the bare "unpriced" token — part of it WAS priced.
    expect(formatWidgetCost(0, "partial")).toBe("$0.0000+?");
    expect(formatWidgetCost(0.00001, "partial")).toBe("$0.0000+?");
  });
});

describe("P4c agent-tool progress/summary lines", () => {
  it("buildProgressLines header reuses formatWidgetCost with usage.unpriced", () => {
    const priced = snapshot({ diag: diag({ usage: usage(0.0412) }) });
    expect(buildProgressLines(priced, 42_000)[0]).toBe("⏳ running · 🤔思考 · turn 3 · 42s · $0.04");
    const all = snapshot({ diag: diag({ usage: usage(0, "all") }) });
    expect(buildProgressLines(all, 42_000)[0]).toBe("⏳ running · 🤔思考 · turn 3 · 42s · unpriced");
    const partial = snapshot({ diag: diag({ usage: usage(0.0412, "partial") }) });
    expect(buildProgressLines(partial, 42_000)[0]).toBe("⏳ running · 🤔思考 · turn 3 · 42s · $0.04+?");
  });

  it("formatOutcomeSummary renders unpriced markers and stays byte-identical without them", () => {
    expect(formatOutcomeSummary(completedOutcome())).toContain("$0.16");
    expect(formatOutcomeSummary(completedOutcome())).not.toContain("+?");
    const all = completedOutcome({ usage: usage(0, "all") });
    expect(formatOutcomeSummary(all)).toContain("unpriced");
    expect(formatOutcomeSummary(all)).not.toContain("$0.0000");
    const partial = completedOutcome({ usage: usage(1.234, "partial") });
    expect(formatOutcomeSummary(partial)).toContain("$1.23+?");
  });
});

describe("P4c fleet-widget rows and header total", () => {
  it("run rows render unpriced/partial costs", () => {
    const all = snapshot({
      runId: "a-0000000",
      diag: diag({ createdAt: 9_000, lastEventAt: 9_900, usage: usage(0, "all") }),
    });
    const lines = buildFleetWidgetLines(buildFleetViewModel([all], OPTS))!;
    expect(lines.some((l) => l.includes("unpriced"))).toBe(true);
    expect(lines.some((l) => l.includes("$0.0000"))).toBe(false);
    const partial = snapshot({
      runId: "a-0000000",
      diag: diag({ createdAt: 9_000, lastEventAt: 9_900, usage: usage(1.5, "partial") }),
    });
    const partialLines = buildFleetWidgetLines(buildFleetViewModel([partial], OPTS))!;
    expect(partialLines.some((l) => l.includes("$1.50+?"))).toBe(true);
  });

  it("header active total gets +? when any active run is unpriced", () => {
    const pricedRun = snapshot({
      runId: "a-0000000",
      diag: diag({ createdAt: 9_000, lastEventAt: 9_900, usage: usage(0.003) }),
    });
    const unpricedRun = snapshot({
      runId: "b-0000000",
      diag: diag({ createdAt: 9_000, lastEventAt: 9_900, usage: usage(0, "all") }),
    });
    expect(buildFleetWidgetLines(buildFleetViewModel([pricedRun, unpricedRun], OPTS))![0]).toBe(
      "● 2 active Agents · $0.0030+?",
    );
    // Byte-identical legacy: no unpriced marker ⇒ no "+?" anywhere.
    const legacy = buildFleetWidgetLines(buildFleetViewModel([pricedRun], OPTS))!;
    expect(legacy[0]).toBe("● 1 active Agents · $0.0030");
  });

  it("header shows the bare token when the whole active fleet is unpriced", () => {
    const unpricedRun = snapshot({
      runId: "a-0000000",
      diag: diag({ createdAt: 9_000, lastEventAt: 9_900, usage: usage(0, "all") }),
    });
    expect(buildFleetWidgetLines(buildFleetViewModel([unpricedRun], OPTS))![0]).toBe("● 1 active Agents · unpriced");
  });
});

describe("P4c result-tool usage trailer", () => {
  function queryFor(snap: RunSnapshot): QueryService {
    return {
      get: () => snap,
      list: () => [],
      wait: async () => ({ ok: false, reason: "unknown_run" }),
      waitAll: async () => ({ settled: [], pending: [] }),
      steer: async () => undefined,
      stop: async () => false,
    };
  }

  function terminalSnapshot(usageDelta: UsageDelta, external?: RunDiagnostics["external"]): RunSnapshot {
    return {
      runId: "r1",
      generation: 1,
      status: "completed",
      phase: "settled",
      deadlines: { enqueuedAt: 0, deadlineAt: undefined, queueDeadlineAt: undefined },
      diag: diag({ phase: "settled", usage: usageDelta, ...(external === undefined ? {} : { external }) }),
      outcome: {
        runId: "r1",
        status: "completed",
        text: "done",
        turns: 1,
        durationMs: 10,
        usage: usageDelta,
        diag: diag({ phase: "settled", usage: usageDelta, ...(external === undefined ? {} : { external }) }),
      },
      updatedAt: 10,
    };
  }

  async function resultText(snap: RunSnapshot): Promise<string> {
    const tool = createResultTool({ query: queryFor(snap) });
    const result = await tool.execute("tc1", { run_id: "r1" }, undefined, () => undefined, {} as never);
    return (result.content[0] as { text: string }).text;
  }

  it("renders cost:unpriced for an all-unpriced run", async () => {
    const text = await resultText(terminalSnapshot(usage(0, "all")));
    expect(text).toContain("cost:unpriced");
    expect(text).not.toContain("cost:$0.0000");
  });

  it("renders cost:$x.xxxx+unpriced for a partial run", async () => {
    const text = await resultText(terminalSnapshot(usage(0.0055, "partial")));
    expect(text).toContain("cost:$0.0055+unpriced");
  });

  it("is byte-identical to the legacy trailer when unpriced is absent", async () => {
    const text = await resultText(terminalSnapshot(usage(0.0055)));
    expect(text).toContain("(duration: 10ms · usage: in:10 out:2 cache_r:0 cache_w:0 cost:$0.0055)");
    expect(text).not.toContain("unpriced");
  });

  it("appends the formatExternal line only for external runs", async () => {
    const external = {
      provider: "droid",
      sessionId: "1a2b3c4d5e6f",
      autonomy: "high",
      credits: 1800,
      pricing: { status: "priced" as const, source: "anthropic/claude-opus-5-5", basis: "upstream" as const },
    };
    const text = await resultText(terminalSnapshot(usage(0.0055), external));
    expect(text).toContain(
      "droid · session 1a2b3c4d · autonomy high · priced anthropic/claude-opus-5-5 · 1.8k credits",
    );
    // No external meta ⇒ no external line (byte-identical legacy output).
    const plain = await resultText(terminalSnapshot(usage(0.0055)));
    expect(plain).not.toContain("droid");
  });
});
