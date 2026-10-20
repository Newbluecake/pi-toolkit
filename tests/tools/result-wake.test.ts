import { describe, expect, it } from "vitest";
import { createResultTool } from "../../src/tools/result-tool.js";
import { formatWakeProvenance } from "../../src/tools/result-text.js";
import type { QueryService } from "../../src/service/query-service.js";
import type { RunSnapshot } from "../../src/core/types.js";

/** Gate G (plan §7): get_subagent_result states who woke a revived run and how many inbox messages rode along. */
const diag = (extra: Record<string, unknown> = {}) =>
  ({
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
    ...extra,
  }) as RunSnapshot["diag"];

function snap(runId: string, extra: Record<string, unknown> = {}, terminal = true): RunSnapshot {
  const d = diag(extra);
  return {
    runId,
    generation: 1,
    status: terminal ? "completed" : "running",
    phase: terminal ? "settled" : "streaming",
    deadlines: { enqueuedAt: 0, deadlineAt: undefined, queueDeadlineAt: undefined },
    diag: d,
    ...(terminal ? { outcome: { runId, status: "completed", text: "done", turns: 1, durationMs: 10, diag: d } } : {}),
    updatedAt: 1,
  } as RunSnapshot;
}
const queryOf = (...snaps: RunSnapshot[]): QueryService =>
  ({
    get: (id: string) => snaps.find((s) => s.runId === id),
    list: () => snaps,
    wait: async (id: string) => ({ ok: true, outcome: snaps.find((s) => s.runId === id)!.outcome! }),
    waitAll: async () => ({ settled: [], pending: [] }),
    steer: async () => undefined,
    stop: async () => false,
  }) as unknown as QueryService;
const text = async (tool: ReturnType<typeof createResultTool>, runId: string, wait = false) =>
  (
    (
      await tool.execute(
        "tc",
        { run_id: runId, ...(wait ? { wait: true } : {}) },
        undefined,
        () => undefined,
        {} as never,
      )
    ).content[0] as { text: string }
  ).text;

describe("formatWakeProvenance", () => {
  it("woken by a run: label + level; extra inbox messages exclude the trigger", () => {
    expect(formatWakeProvenance({ by: "r_SENDER01", level: 1 }, "scout", 1)).toBe(
      "Woken by scout (run_id: r_SENDER01) (level 1)",
    );
    expect(formatWakeProvenance({ by: "r_SENDER01", level: 2 }, undefined, 3)).toBe(
      "Woken by run r_SENDER01 (level 2) · +2 inbox messages",
    );
    expect(formatWakeProvenance({ by: "root", level: 1 }, undefined, 2)).toBe(
      "Woken by root (level 1) · +1 inbox message",
    );
  });
  it("human resume that carried parked messages; nothing at all otherwise (byte-identical)", () => {
    expect(formatWakeProvenance(undefined, undefined, 2)).toBe("Resumed with +2 inbox messages");
    expect(formatWakeProvenance(undefined, undefined, 0)).toBeUndefined();
    expect(formatWakeProvenance(undefined, undefined, undefined)).toBeUndefined();
  });
});

describe("get_subagent_result wake provenance", () => {
  const sender = snap("r_SENDER01", { label: "scout" });
  const woken = snap("r_REVIVE01", { wakeOrigin: { by: "r_SENDER01", key: "k", level: 1, via: "fabric" } });
  it("terminal read (get and wait) carries the line; plain runs and wake-off hosts are unchanged", async () => {
    const plain = snap("r_PLAIN001");
    const base = await text(createResultTool({ query: queryOf(plain) }), "r_PLAIN001");
    expect(base).not.toMatch(/Woken by|inbox message/);
    // a port that reports 0 for a plain run ⇒ still byte-identical
    expect(await text(createResultTool({ query: queryOf(plain), wake: { inboxCount: () => 0 } }), "r_PLAIN001")).toBe(
      base,
    );

    const tool = createResultTool({ query: queryOf(sender, woken), wake: { inboxCount: () => 3 } });
    const got = await text(tool, "r_REVIVE01");
    expect(got).toContain("Woken by scout (run_id: r_SENDER01) (level 1) · +2 inbox messages");
    expect(got.startsWith("done")).toBe(true);
    expect(await text(tool, "r_REVIVE01", true)).toContain("Woken by scout (run_id: r_SENDER01) (level 1)");
  });
  it("a still-running revived run shows it too; the wake-off tool (no port) still reports the persisted origin", async () => {
    const running = snap("r_REVIVE02", { wakeOrigin: { by: "root", key: "k", level: 1, via: "fabric" } }, false);
    expect(await text(createResultTool({ query: queryOf(running) }), "r_REVIVE02")).toContain(
      "Woken by root (level 1)",
    );
  });
  it("a throwing inbox port never breaks the read", async () => {
    const tool = createResultTool({
      query: queryOf(woken),
      wake: {
        inboxCount: () => {
          throw new Error("boom");
        },
      },
    });
    expect(await text(tool, "r_REVIVE01")).toContain("Woken by run r_SENDER01 (level 1)");
  });
  it("human resume that carried messages", async () => {
    const resumed = snap("r_RESUME01");
    expect(
      await text(createResultTool({ query: queryOf(resumed), wake: { inboxCount: () => 2 } }), "r_RESUME01"),
    ).toContain("Resumed with +2 inbox messages");
  });
});
