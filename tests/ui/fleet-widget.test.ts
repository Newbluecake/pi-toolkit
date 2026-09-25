import { describe, expect, it, vi } from "vitest";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { FakeClock } from "../../src/core/clock.js";
import type { LifecycleEvent, RunDiagnostics, RunSnapshot, UsageDelta } from "../../src/core/types.js";
import type { QueryService } from "../../src/service/query-service.js";
import {
  buildFleetViewModel,
  formatContextTokens,
  formatContextUsage,
  type FleetTone,
} from "../../src/ui/fleet-panel.js";
import {
  buildFleetWidgetLines,
  compactPhaseLabel,
  FLEET_WIDGET_KEY,
  FleetWidgetController,
  findGlyphCollisions,
  formatWidgetCost,
  formatLogSize,
  bashJobHighlight,
  tailLine,
  treeOrder,
  workflowGroupInput,
  workflowHeaderLine,
  workflowPhaseChainLine,
  type WorkflowPhaseChip,
  WIDGET_MAX_ROWS,
} from "../../src/ui/fleet-widget.js";

function diag(overrides: Partial<RunDiagnostics> = {}): RunDiagnostics {
  const base: RunDiagnostics = {
    createdAt: 0,
    phase: "model_turn",
    phaseEnteredAt: 0,
    pendingTools: 0,
    turns: 1,
    escalation: [],
    orphaned: false,
    generation: 1,
    degraded: [],
    staleInputs: 0,
    unkillable: [],
    ...overrides,
  };
  // Fixtures that only override createdAt mean "the run has been in this phase since
  // creation" — keep phaseEnteredAt aligned so rows display the expected duration.
  if (overrides.createdAt !== undefined && overrides.phaseEnteredAt === undefined) {
    base.phaseEnteredAt = overrides.createdAt;
  }
  return base;
}

function snapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    runId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    generation: 1,
    status: "running",
    phase: "model_turn",
    deadlines: { enqueuedAt: 0, deadlineAt: undefined, queueDeadlineAt: undefined },
    diag: diag(),
    updatedAt: 0,
    ...overrides,
  };
}

const usage = (costUsd: number): UsageDelta => ({ input: 10, output: 2, cacheRead: 0, cacheWrite: 0, costUsd });

const NOW = 10_000;
const OPTS = { now: NOW, idleBudgetMs: 1000 };

describe("view-model: context usage formatting", () => {
  it("formats context windows at every compact-unit boundary", () => {
    expect(formatContextTokens(999)).toBe("999");
    expect(formatContextTokens(1000)).toBe("1.0k");
    expect(formatContextTokens(9999)).toBe("10.0k");
    expect(formatContextTokens(10_000)).toBe("10k");
    expect(formatContextTokens(999_999)).toBe("1000k");
    expect(formatContextTokens(1_000_000)).toBe("1.0M");
    expect(formatContextTokens(9_999_999)).toBe("10.0M");
    expect(formatContextTokens(10_000_000)).toBe("10M");
  });

  it("renders unknown post-compaction usage with a compact window", () => {
    expect(formatContextUsage({ tokens: null, contextWindow: 262_144, percent: null })).toBe("?/262k");
    expect(formatContextUsage({ tokens: 32_000, contextWindow: 262_144, percent: 12.34 })).toBe("12.3%/262k");
  });
});

describe("view-model: formatWidgetCost boundaries", () => {
  it("4 decimals below half a cent, 2 decimals at/above", () => {
    expect(formatWidgetCost(0)).toBe("$0.0000");
    expect(formatWidgetCost(0.000312)).toBe("$0.0003");
    expect(formatWidgetCost(0.0049)).toBe("$0.0049");
    expect(formatWidgetCost(0.005)).toBe("$0.01"); // boundary: rounds up at 2dp
    expect(formatWidgetCost(1.05)).toBe("$1.05");
    expect(formatWidgetCost(12.5)).toBe("$12.50");
  });
});

describe("view-model: buildFleetWidgetLines (agent tree)", () => {
  it("returns undefined when nothing is active (empty fleet → widget hidden)", () => {
    expect(buildFleetWidgetLines(buildFleetViewModel([], OPTS))).toBeUndefined();
  });

  it("returns undefined when only terminal runs exist (history is panel material)", () => {
    const done = snapshot({ status: "completed", phase: "settled" });
    expect(buildFleetWidgetLines(buildFleetViewModel([done], OPTS))).toBeUndefined();
  });

  it("renders context usage before cost on active and terminal rows", () => {
    const contextUsage = { tokens: 32_000, contextWindow: 262_144, percent: 12.34 };
    const active = snapshot({ diag: diag({ usage: usage(0.0042), contextUsage }) });
    const done = snapshot({
      status: "completed",
      phase: "settled",
      updatedAt: NOW,
      diag: diag({ usage: usage(0.0042), contextUsage }),
    });
    const lines = buildFleetWidgetLines(buildFleetViewModel([active, done], { ...OPTS, recentTerminal: 1 }))!;
    expect(lines[1]).toContain("12.3%/262k $0.0042");
    expect(lines[2]).toContain("12.3%/262k $0.0042");
    expect(lines[1]!.indexOf("12.3%/262k")).toBeLessThan(lines[1]!.indexOf("$0.0042"));
  });

  it("single active run → header + one tree row with id-fallback, type, phase, elapsed, cost", () => {
    const run = snapshot({
      diag: diag({ createdAt: NOW - 8 * 60_000 - 32_000, lastEventAt: 9_900, usage: usage(1.05) }),
    });
    const model = buildFleetViewModel([run], { ...OPTS, typeOf: () => "architect" });
    expect(buildFleetWidgetLines(model)).toEqual([
      "● 1 active Agents · $1.05",
      "  aaaaaaaa architect 🤔 8m32s $1.05 Σ8m32s",
    ]);
  });

  it("M-A meta: label, agentType and model from diag are rendered on the row", () => {
    const run = snapshot({
      diag: diag({
        createdAt: 9_000,
        lastEventAt: 9_900,
        label: "重构用户模块",
        agentType: "architect",
        model: { provider: "copilot-completion", id: "kimi-k3" },
      }),
    });
    const lines = buildFleetWidgetLines(buildFleetViewModel([run], OPTS))!;
    expect(lines[1]).toBe("  重构用户模块 architect copilot-completion/kimi-k3 🤔 1s Σ1s");
  });

  it("consult §16.5: a main-session consult run's row shows `main`, never the sentinel type", () => {
    const mainRun = snapshot({
      diag: diag({
        createdAt: 9_000,
        lastEventAt: 9_900,
        agentType: "consult:main-snapshot",
      }),
    });
    const lines = buildFleetWidgetLines(buildFleetViewModel([mainRun], OPTS))!;
    expect(lines[1]).toContain(" main ");
    expect(lines[1]).not.toContain("consult:main-snapshot");
    // A plain consult run (real expert type) keeps its type verbatim.
    const expertRun = snapshot({
      diag: diag({ createdAt: 9_000, lastEventAt: 9_900, agentType: "explorer" }),
    });
    const expertLines = buildFleetWidgetLines(buildFleetViewModel([expertRun], OPTS))!;
    expect(expertLines[1]).toContain(" explorer ");
  });

  it("model uses full name, basename, then omission as width tightens", () => {
    const run = snapshot({
      diag: diag({
        createdAt: 9_000,
        phaseEnteredAt: 9_000,
        lastEventAt: 9_900,
        model: { provider: "droid-completion", id: "very-long-model-name" },
      }),
    });
    const model = buildFleetViewModel([run], OPTS);
    const full = buildFleetWidgetLines(model, { width: 120 })![1]!;
    expect(full).toContain("droid-completion/very-long-model-name");

    const medium = buildFleetWidgetLines(model, { width: 45 })![1]!;
    expect(medium).toContain("very-long-model-name");
    expect(medium).not.toContain("droid-completion/very-long-model-name");

    const narrow = buildFleetWidgetLines(model, { width: 20 })![1]!;
    expect(narrow).not.toContain("very-long-model-name");
    expect(visibleWidth(narrow)).toBeLessThanOrEqual(20);
  });

  it("drops fields by priority while retaining label and phase", () => {
    const run = snapshot({
      diag: diag({
        createdAt: 9_000,
        phaseEnteredAt: 9_000,
        lastEventAt: 9_900,
        label: "任务标签",
        agentType: "architect",
        model: { provider: "droid-completion", id: "long-model-name" },
        contextUsage: { tokens: 32_000, contextWindow: 262_144, percent: 12.3 },
        usage: usage(1.05),
      }),
    });
    const model = buildFleetViewModel([run], OPTS);
    const at = (width: number) => buildFleetWidgetLines(model, { width })![1]!;
    expect(at(120)).toContain("任务标签 architect droid-completion/long-model-name");
    expect(at(70)).not.toContain("architect");
    expect(at(70)).toContain("long-model-name");
    expect(at(50)).not.toContain("long-model-name");
    expect(at(50)).toContain("12.3%/262k");
    expect(at(35)).not.toContain("12.3%/262k");
    expect(at(35)).toContain("$1.05");
    // Last reachable tier: buildFleetWidgetLines clamps width to >= 20, at
    // which label+phase+Σ still fit, so the Σ-drop tier is unreachable
    // through this entry point.
    expect(at(26)).toContain("Σ1s");
    expect(at(24)).toContain("Σ1s");
    // The label is never truncated while droppable fields remain.
    expect(at(20)).toContain("任务标签");
    expect(at(20)).not.toContain("...");
    for (const width of [120, 70, 50, 35, 26, 24, 20]) {
      const line = at(width);
      expect(line).toContain("任务标签");
      expect(line).toMatch(/(?:🤔|💭|🧠|🤔) 1s/);
    }
  });

  it("truncates label only when label plus phase cannot fit", () => {
    const run = snapshot({ diag: diag({ label: "这是一个非常长的任务标签", lastEventAt: 9_900 }) });
    const model = buildFleetViewModel([run], OPTS);
    const wide = buildFleetWidgetLines(model, { width: 60 })![1]!;
    expect(wide).toContain("这是一个非常长的任务标签");
    const narrow = buildFleetWidgetLines(model, { width: 20 })![1]!;
    expect(narrow).toContain("...");
    expect(narrow).toMatch(/🤔 10s/);
  });

  it("compacts BMP and retry phase labels without leaving text fragments", () => {
    const cases = [
      ["queue_wait", "⏸ 1s"],
      ["resolve_config", "⚡ 1s"],
      ["retry_backoff", "♻ 2/3 1s"],
      ["reap", "⏹ 1s"],
    ] as const;
    for (const [phase, expected] of cases) {
      const run = snapshot({
        phase,
        diag: diag({
          createdAt: 9_000,
          phaseEnteredAt: 9_000,
          phase,

          ...(phase === "retry_backoff"
            ? { retry: { attempt: 2, maxAttempts: 3, delayMs: 100, startedAt: 9_000 } }
            : {}),
        }),
      });
      const line = buildFleetWidgetLines(buildFleetViewModel([run], OPTS), { width: 120 })![1]!;
      expect(line).toContain(expected);
      expect(line).not.toContain("排队");
      expect(line).not.toContain("启动");
      expect(line).not.toContain("重试");
      expect(line).not.toContain("停止");
    }
  });

  it("compactPhaseLabel: variation-selector (U+FE0F) inputs stay fragment-free", () => {
    // VS16-bearing emoji are unreachable via FleetRow (phase labels are
    // generated without it) but compactPhaseLabel must not leave the
    // selector or the text remnant behind if one ever shows up.
    expect(compactPhaseLabel("⏸️排队")).toBe("⏸️");
    expect(compactPhaseLabel("⚡️启动")).toBe("⚡️");
    expect(compactPhaseLabel("⏹️停止中")).toBe("⏹️");
    expect(compactPhaseLabel("♻️重试2/3")).toBe("♻️ 2/3");
    expect(compactPhaseLabel("♻重试1/5")).toBe("♻ 1/5");
    expect(compactPhaseLabel("♻重试")).toBe("♻");
    expect(compactPhaseLabel("🤔思考")).toBe("🤔");
    // M12: phaseLabel now writes a space after the wide-risk glyphs — the
    // spaced forms must compact identically (legacy space-less still works).
    expect(compactPhaseLabel("⏸ 排队")).toBe("⏸");
    expect(compactPhaseLabel("⏹ 停止中")).toBe("⏹");
    expect(compactPhaseLabel("🗜 压缩")).toBe("🗜");
    expect(compactPhaseLabel("♻ 重试2/3")).toBe("♻ 2/3");
    expect(compactPhaseLabel("♻️ 重试2/3")).toBe("♻️ 2/3");
    expect(compactPhaseLabel("♻ 重试")).toBe("♻");
    // Non-emoji phase labels pass through untouched.
    expect(compactPhaseLabel("等待中")).toBe("等待中");
  });

  describe("deadline field (timeout grace & extension)", () => {
    const liveDiag = (overrides: Partial<RunDiagnostics> = {}): RunDiagnostics =>
      diag({ createdAt: 9_000, phaseEnteredAt: 9_000, lastEventAt: 9_900, ...overrides });

    it("renders ⏳<remaining> right after the phase for a run with a deadline", () => {
      const run = snapshot({
        deadlines: { enqueuedAt: 0, deadlineAt: NOW + 65_000, queueDeadlineAt: undefined },
        diag: liveDiag(),
      });
      const line = buildFleetWidgetLines(buildFleetViewModel([run], OPTS), { width: 120 })![1]!;
      expect(line).toContain("⏳1m05s");
      // Sits with the phase (health info), before the resource stats.
      expect(line.indexOf("⏳1m05s")).toBeGreaterThan(line.indexOf("🤔 1s"));
    });

    it("appends +N when extensions were granted", () => {
      const run = snapshot({
        deadlines: { enqueuedAt: 0, deadlineAt: NOW + 65_000, queueDeadlineAt: undefined },
        diag: liveDiag({ overtime: { graces: 1, extensions: 2, grantedMs: 1_200_000 } }),
      });
      const line = buildFleetWidgetLines(buildFleetViewModel([run], OPTS), { width: 120 })![1]!;
      expect(line).toContain("⏳1m05s+2");
    });

    it("renders ⏳grace <remaining> while inside the grace window", () => {
      const run = snapshot({
        deadlines: { enqueuedAt: 0, deadlineAt: 5_000, queueDeadlineAt: undefined, graceUntil: NOW + 58_000 },
        diag: liveDiag(),
      });
      const line = buildFleetWidgetLines(buildFleetViewModel([run], OPTS), { width: 120 })![1]!;
      expect(line).toContain("⏳grace 58s");
    });

    it("no deadline (and terminal rows) render no deadline field", () => {
      const run = snapshot({ diag: liveDiag() });
      const line = buildFleetWidgetLines(buildFleetViewModel([run], OPTS), { width: 120 })![1]!;
      expect(line).not.toContain("⏳");
    });

    it("drops fields by priority: deadline goes LAST (after Σ total)", () => {
      const run = snapshot({
        deadlines: { enqueuedAt: 0, deadlineAt: NOW + 65_000, queueDeadlineAt: undefined },
        diag: liveDiag({
          label: "任务标签",
          agentType: "architect",
          model: { provider: "droid-completion", id: "long-model-name" },
          contextUsage: { tokens: 32_000, contextWindow: 262_144, percent: 12.3 },
          usage: usage(1.05),
        }),
      });
      const model = buildFleetViewModel([run], OPTS);
      const at = (width: number) => buildFleetWidgetLines(model, { width })![1]!;
      expect(at(120)).toContain("⏳1m05s");
      const widths = [120, 80, 60, 50, 40, 30, 26, 24, 20];
      // Whenever Σ survived, the deadline must still be there (it drops later).
      for (const w of widths) {
        const line = at(w);
        if (line.includes("Σ")) expect(line).toContain("⏳1m05s");
        expect(visibleWidth(line)).toBeLessThanOrEqual(w);
      }
      // …and there is a width where Σ is already gone but the deadline remains.
      expect(widths.some((w) => !at(w).includes("Σ") && at(w).includes("⏳1m05s"))).toBe(true);
      // Non-grace deadline IS eventually droppable; label and phase never are.
      expect(at(20)).not.toContain("⏳");
      expect(at(20)).toContain("任务标签");
      expect(at(20)).toMatch(/🤔 1s/);
    });

    it("inGrace: the deadline field is NEVER dropped — the label truncates first", () => {
      const run = snapshot({
        deadlines: { enqueuedAt: 0, deadlineAt: 5_000, queueDeadlineAt: undefined, graceUntil: NOW + 58_000 },
        diag: liveDiag({
          label: "这是一个非常非常长的任务标签名",
          agentType: "architect",
          model: { provider: "droid-completion", id: "long-model-name" },
          contextUsage: { tokens: 32_000, contextWindow: 262_144, percent: 12.3 },
          usage: usage(1.05),
        }),
      });
      const model = buildFleetViewModel([run], OPTS);
      const at = (width: number) => buildFleetWidgetLines(model, { width })![1]!;
      for (const w of [120, 80, 60, 40, 30]) {
        const line = at(w);
        expect(line).toContain("⏳grace 58s");
        expect(visibleWidth(line)).toBeLessThanOrEqual(w);
      }
      // Too narrow for the full marker: the bare countdown survives, never dropped.
      expect(at(20)).toContain("⏳58s");
      expect(visibleWidth(at(20))).toBeLessThanOrEqual(20);
      // At the narrowest width the label gave way, not the grace countdown.
      expect(at(20)).not.toContain("这是一个非常非常长的任务标签名");
    });
  });

  it("tool trail: own continuation line; prefers diag.toolHistory trail; falls back to ▸currentTool", () => {
    const withHistory = snapshot({
      diag: diag({
        createdAt: 9_000,
        lastEventAt: 9_900,
        toolHistory: [
          { name: "bash", toolCallId: "a", startedAt: 1, endedAt: 2, isError: false },
          { name: "bash", toolCallId: "b", startedAt: 3, endedAt: 4, isError: false },
          { name: "edit", toolCallId: "c", startedAt: 5 },
        ],
      }),
    });
    expect(buildFleetWidgetLines(buildFleetViewModel([withHistory], OPTS))!.slice(1)).toEqual([
      "  aaaaaaaa · 🤔 1s Σ1s",
      "  ╰ ✓ bash ×2 | ▸edit · 9s",
    ]);
    const withTool = snapshot({
      diag: diag({
        createdAt: 9_000,
        lastEventAt: 9_900,
        currentTool: { name: "bash", toolCallId: "t", startedAt: 9_900 },
      }),
    });
    expect(buildFleetWidgetLines(buildFleetViewModel([withTool], OPTS))!.slice(1)).toEqual([
      "  aaaaaaaa · 🤔 1s Σ1s",
      "  ╰ ▸bash · 100ms",
    ]);
  });

  it("X6b: user @ message hangs one line under the tool trail of a running row", () => {
    const run = snapshot({
      runId: "aaaaaaaa",
      diag: diag({
        createdAt: 9_000,
        lastEventAt: 9_900,
        toolHistory: [
          { name: "bash", toolCallId: "a", startedAt: 1, endedAt: 2, isError: false },
          { name: "edit", toolCallId: "c", startedAt: 5 },
        ],
      }),
    });
    const model = buildFleetViewModel([run], OPTS);
    const lines = buildFleetWidgetLines(model, {
      mentionNoteOf: (runId) => (runId === "aaaaaaaa" ? "现在跑到第几轮了？" : undefined),
    })!;
    // lines[0] is the ● header; then main row, tool trail, mention line
    expect(lines[2]).toContain("╰ ✓ bash"); // tool trail first
    expect(lines[3]).toContain("@ » 现在跑到第几轮了？"); // mention line directly below it
  });

  it("tool trail: terminal run freezes the in-flight segment (no ever-growing duration)", () => {
    // A run killed mid-tool keeps its in-flight record in toolHistory — the
    // trail must NOT carry a live duration that keeps aging after the run ended.
    const killedMidTool = snapshot({
      status: "aborted",
      phase: "settled",
      updatedAt: NOW,
      diag: diag({
        createdAt: 1_000,
        toolHistory: [{ name: "bash", toolCallId: "a", startedAt: 5_000, argsPreview: "npm test" }],
        currentTool: { name: "bash", toolCallId: "a", startedAt: 5_000 },
      }),
    });
    const model = buildFleetViewModel([killedMidTool], { ...OPTS, recentTerminal: 3 });
    const row = model.rows[0]!;
    expect(row.terminal).toBe(true);
    expect(row.toolTrail).toBe("▸bash npm test"); // no " · Ns" suffix
    expect(row.currentTool).toBeUndefined();
    expect(row.currentToolMs).toBeUndefined();
  });

  it("thinking stream: last text line is shown (one line, truncated) only in model_turn", () => {
    const thinking = snapshot({
      diag: diag({
        createdAt: 9_000,
        lastEventAt: 9_900,
        text: "先分析需求\n然后看一下代码结构，重点关注调度模块",
      }),
    });
    expect(buildFleetWidgetLines(buildFleetViewModel([thinking], OPTS))!.slice(1)).toEqual([
      "  aaaaaaaa · 🤔 1s Σ1s",
      "  ╰ » 然后看一下代码结构，重点关注调度模块",
    ]);
    // a long line is truncated with an ellipsis
    const long = snapshot({
      diag: diag({ createdAt: 9_000, lastEventAt: 9_900, text: "x".repeat(100) }),
    });
    const line = buildFleetWidgetLines(buildFleetViewModel([long], OPTS))![2]!;
    expect(line).toContain("» " + "x".repeat(59) + "…");
    // tool_exec phase: stale pre-tool text is NOT shown (the ▸tool trail carries the live info)
    const tooling = snapshot({
      phase: "tool_exec",
      diag: diag({
        createdAt: 9_000,
        lastEventAt: 9_900,
        text: "调用工具前的思考",
        currentTool: { name: "bash", toolCallId: "t", startedAt: 9_900 },
      }),
    });
    expect(buildFleetWidgetLines(buildFleetViewModel([tooling], OPTS))!.slice(1)).toEqual([
      "  aaaaaaaa · 🔧 1s Σ1s",
      "  ╰ ▸bash · 100ms",
    ]);
    // terminal rows never stream
    const done = snapshot({
      status: "completed",
      phase: "settled",
      updatedAt: NOW,
      diag: diag({ text: "最后的输出" }),
    });
    const lines = buildFleetWidgetLines(buildFleetViewModel([thinking, done], OPTS))!;
    expect(lines.find((l) => l.includes("completed"))).not.toContain("»");
  });

  it("active row shows the current phase's age (phaseMs), not the run's cumulative age", () => {
    const run = snapshot({
      diag: diag({ createdAt: 0, phaseEnteredAt: 9_000, lastEventAt: 9_900 }),
    });
    const lines = buildFleetWidgetLines(buildFleetViewModel([run], OPTS))!;
    expect(lines[1]).toBe("  aaaaaaaa · 🤔 1s Σ10s"); // 1s in this model turn, Σ10s total run age
  });

  it("tool trail: in-flight edit shows which file is being edited (path preview)", () => {
    const editing = snapshot({
      diag: diag({
        createdAt: 9_000,
        lastEventAt: 9_900,
        toolHistory: [{ name: "edit", toolCallId: "a", startedAt: 9_900, argsPreview: "src/ui/fleet-panel.ts" }],
      }),
    });
    expect(buildFleetWidgetLines(buildFleetViewModel([editing], OPTS))![2]).toBe(
      "  ╰ ▸edit src/ui/fleet-panel.ts · 100ms",
    );
  });

  it("tool trail: in-flight call carries a truncated args preview", () => {
    const withPreview = snapshot({
      diag: diag({
        createdAt: 9_000,
        lastEventAt: 9_900,
        toolHistory: [{ name: "bash", toolCallId: "a", startedAt: 9_900, argsPreview: "npm test -- --runInBand" }],
      }),
    });
    expect(buildFleetWidgetLines(buildFleetViewModel([withPreview], OPTS))!.slice(1)).toEqual([
      "  aaaaaaaa · 🤔 1s Σ1s",
      "  ╰ ▸bash npm test -- --runInBand · 100ms",
    ]);
    const longPreview = snapshot({
      diag: diag({
        createdAt: 9_000,
        lastEventAt: 9_900,
        toolHistory: [{ name: "bash", toolCallId: "a", startedAt: 9_900, argsPreview: "y".repeat(80) }],
      }),
    });
    expect(buildFleetWidgetLines(buildFleetViewModel([longPreview], OPTS))![2]).toContain(
      "▸bash " + "y".repeat(59) + "…",
    );
  });

  it("line budget: a run with activity consumes 2 lines; a lone leftover line keeps the main row only", () => {
    const busy = (runId: string, at: number) =>
      snapshot({
        runId,
        diag: diag({
          createdAt: at,
          lastEventAt: 9_900,
          toolHistory: [{ name: "bash", toolCallId: "t", startedAt: 9_900 }],
        }),
      });
    // 3 busy runs with maxRows 5 → 3 main rows + activity for the first two
    const three = [busy("r1-000000", 1_000), busy("r2-000000", 2_000), busy("r3-000000", 3_000)];
    const lines = buildFleetWidgetLines(buildFleetViewModel(three, OPTS), { maxRows: 5 })!;
    expect(lines).toHaveLength(1 + 5);
    expect(lines.filter((l) => l.includes("▸bash"))).toHaveLength(2); // 3rd run's activity dropped
    expect(lines.some((l) => l.includes("r3-00000") && !l.includes("▸"))).toBe(true);
    expect(lines[0]).not.toContain("more"); // all 3 runs shown (as rows)
    // fair allocation: main rows are dealt first — maxRows 2 → two main rows,
    // no activity lines, only the third run hidden behind +1 more
    const tight = buildFleetWidgetLines(buildFleetViewModel(three, OPTS), { maxRows: 2 })!;
    expect(tight).toHaveLength(1 + 2);
    expect(tight.filter((l) => l.includes("▸bash"))).toHaveLength(0);
    expect(tight[0]).toContain("+1 more");
  });

  it("default budget: 3 busy runs all keep their activity lines (main rows first, then trails)", () => {
    const busy = (runId: string, at: number) =>
      snapshot({
        runId,
        diag: diag({
          createdAt: at,
          lastEventAt: 9_900,
          toolHistory: [{ name: "bash", toolCallId: "t", startedAt: 9_900 }],
        }),
      });
    const three = [busy("r1-000000", 1_000), busy("r2-000000", 2_000), busy("r3-000000", 3_000)];
    // Explicit maxRows 6 (M-C2: the DEFAULT is now 20, no longer clamped by pi's
    // string-array widget cap) = 3 main rows + 3 activity lines: the LAST run's
    // tool trail is no longer starved by an odd leftover line.
    const lines = buildFleetWidgetLines(buildFleetViewModel(three, OPTS), { maxRows: 6 })!;
    expect(lines).toHaveLength(1 + 6);
    expect(lines.filter((l) => l.includes("▸bash"))).toHaveLength(3);
  });

  it("tree: a child whose parent is shown is indented under it (↳), not severity-sorted away", () => {
    const parent = snapshot({ runId: "parent-00", diag: diag({ createdAt: 1_000, lastEventAt: 9_900 }) });
    const child = snapshot({
      runId: "child-000",
      parentRunId: "parent-00",
      diag: diag({ createdAt: 5_000, lastEventAt: 9_900 }),
    });
    const other = snapshot({ runId: "other-000", diag: diag({ createdAt: 2_000, lastEventAt: 9_900 }) });
    // severity equal → elapsed order: parent(9s), other(8s), child(5s); tree pulls child up under parent
    const lines = buildFleetWidgetLines(buildFleetViewModel([parent, child, other], OPTS))!;
    expect(lines).toEqual([
      "● 3 active Agents",
      "  parent-0 · 🤔 9s Σ9s",
      "  ↳ child-00 · 🤔 5s Σ5s",
      "  other-00 · 🤔 8s Σ8s",
    ]);
  });

  it("nested run whose parent is NOT shown still gets the ↳ marker at top level", () => {
    const nested = snapshot({ parentRunId: "p", diag: diag({ createdAt: 9_000, lastEventAt: 9_900 }) });
    const lines = buildFleetWidgetLines(buildFleetViewModel([nested], OPTS))!;
    expect(lines[1]).toBe("  ↳ aaaaaaaa · 🤔 1s Σ1s");
  });

  it("highlight-priority: crit run's row is first among roots and the bullet takes the worst tone", () => {
    const calmOld = snapshot({ runId: "calm-0000", diag: diag({ createdAt: 0, lastEventAt: 9_900 }) });
    const stuck = snapshot({
      runId: "stuck-0000",
      status: "stopping",
      diag: diag({ createdAt: 9_500, lastEventAt: 9_900 }),
    });
    const tones: Array<[FleetTone, string]> = [];
    const lines = buildFleetWidgetLines(buildFleetViewModel([calmOld, stuck], OPTS), {
      color: (tone, text) => {
        tones.push([tone, text]);
        return `[${tone}]${text}`;
      },
    })!;
    expect(tones).toContainEqual(["crit", "●"]);
    // crit row: mark + label tone-tinted, meta segments keep the calm palette
    expect(lines[1]).toContain("[crit]✗");
    expect(lines[1]).toContain("[crit]stuck-00");
    expect(lines[1]).toContain("[muted]");
    // calm row: segment-colored (muted meta), label untinted
    expect(lines[2]).toContain("calm-000");
    expect(lines[2]).toContain("[muted]🤔");
    expect(lines[2]).not.toContain("[crit]");
  });

  it("warn row: mark and label take the warn tone, meta stays muted, activity keeps its normal colors", () => {
    const idle = snapshot({
      runId: "idle-0000",
      diag: diag({
        createdAt: 8_000,
        lastEventAt: 9_000, // idle 1000 > 500 = warn
        toolHistory: [{ name: "bash", toolCallId: "b", startedAt: 9_000, argsPreview: "go test" }],
      }),
    });
    const lines = buildFleetWidgetLines(buildFleetViewModel([idle], OPTS), {
      color: (tone, text) => `[${tone}]${text}`,
    })!;
    expect(lines[1]).toContain("[warn]!");
    expect(lines[1]).toContain("[warn]idle-000");
    expect(lines[1]).toContain("[muted]"); // meta segments keep the calm palette
    // activity line: normal segment colors, no warn wash
    expect(lines[2]).toContain("[header]▸bash go test");
    expect(lines[2]).not.toContain("[warn]");
  });

  it("boundary: a calm run's activity line is muted except the in-flight ▸ segment (main rows stay the anchors)", () => {
    const busy = snapshot({
      diag: diag({
        createdAt: 9_000,
        lastEventAt: 9_900,
        toolHistory: [
          { name: "read", toolCallId: "a", startedAt: 9_000, endedAt: 9_100 },
          { name: "bash", toolCallId: "b", startedAt: 9_900, argsPreview: "npm test" },
        ],
      }),
    });
    const lines = buildFleetWidgetLines(buildFleetViewModel([busy], OPTS), {
      color: (tone, text) => `[${tone}]${text}`,
    })!;
    // ╰ hook under the task name; green ✓ / muted name-and-count per the
    // collapsed-tally reference style, ▸ in-flight stays accent
    expect(lines[2]).toBe("  ╰ [success]✓[muted] read[muted] | [header]▸bash npm test · 100ms");
    expect(lines[1]).not.toContain("[muted]aaaa"); // main row label stays un-muted (bright anchor)
  });

  it("marks: ✗ crit, ! warn, space otherwise", () => {
    const stuck = snapshot({
      runId: "stuck-0000",
      status: "stopping",
      diag: diag({ createdAt: 9_000, lastEventAt: 9_900 }),
    });
    const idle = snapshot({ runId: "idle-0000", diag: diag({ createdAt: 8_000, lastEventAt: 9_000 }) }); // idle 1000 > 500 = warn
    const calm = snapshot({ runId: "calm-0000", diag: diag({ createdAt: 7_000, lastEventAt: 9_900 }) });
    const lines = buildFleetWidgetLines(buildFleetViewModel([calm, idle, stuck], OPTS))!;
    expect(lines).toHaveLength(4);
    expect(lines[1]!.startsWith("✗ ")).toBe(true);
    expect(lines[2]!.startsWith("! ")).toBe(true);
    expect(lines[3]!.startsWith("  ")).toBe(true);
  });

  it("header cost sums active rows only and is omitted at $0", () => {
    const a = snapshot({
      runId: "a-0000000",
      diag: diag({ createdAt: 9_000, lastEventAt: 9_900, usage: usage(0.002) }),
    });
    const b = snapshot({
      runId: "b-0000000",
      diag: diag({ createdAt: 9_000, lastEventAt: 9_900, usage: usage(0.001) }),
    });
    expect(buildFleetWidgetLines(buildFleetViewModel([a, b], OPTS))![0]).toBe("● 2 active Agents · $0.0030");
    const free = snapshot({ diag: diag({ createdAt: 9_000, lastEventAt: 9_900 }) });
    expect(buildFleetWidgetLines(buildFleetViewModel([free], OPTS))![0]).toBe("● 1 active Agents");
  });

  it("truncation: explicit maxRows below the run count reports overflow via the header's +N more", () => {
    const runs = Array.from({ length: 7 }, (_, i) =>
      snapshot({ runId: `run-${i}00000`, diag: diag({ createdAt: i, lastEventAt: 9_900 }) }),
    );
    const model = buildFleetViewModel(runs, OPTS);
    const lines = buildFleetWidgetLines(model, { maxRows: 6 })!;
    expect(lines).toHaveLength(7);
    expect(lines[0]).toContain("7 active Agents");
    expect(lines[0]).toContain("+1 more");
  });

  it("overflow boundary: exactly maxRows runs → no '+more'; maxRows 1 → header + 1 row", () => {
    const two = [0, 1].map((i) =>
      snapshot({ runId: `r${i}0000000`, diag: diag({ createdAt: i, lastEventAt: 9_900 }) }),
    );
    const exact = buildFleetWidgetLines(buildFleetViewModel(two, OPTS))!;
    expect(exact).toHaveLength(3);
    expect(exact[0]).not.toContain("more");

    const one = buildFleetWidgetLines(buildFleetViewModel(two, OPTS), { maxRows: 1 })!;
    expect(one).toHaveLength(2);
    expect(one[0]).toContain("+1 more");
  });

  it(`maxRows is hard-capped at ${WIDGET_MAX_ROWS}`, () => {
    const runCount = WIDGET_MAX_ROWS + 3;
    const runs = Array.from({ length: runCount }, (_, i) =>
      snapshot({ runId: `run-${i}0000`, diag: diag({ createdAt: i, lastEventAt: 9_900 }) }),
    );
    const model = buildFleetViewModel(runs, { ...OPTS, maxActiveRows: runCount });
    const lines = buildFleetWidgetLines(model, { maxRows: WIDGET_MAX_ROWS + 20 })!;
    expect(lines).toHaveLength(1 + WIDGET_MAX_ROWS);
    expect(lines[0]).toContain(`+${runCount - WIDGET_MAX_ROWS} more`);
  });

  it("pending terminal notifications stay beyond old linger and show the user @ message", () => {
    const done = snapshot({
      status: "completed",
      phase: "settled",
      updatedAt: 0,
      diag: diag({ taskPrompt: "do\n  this   carefully" }),
    });
    const model = buildFleetViewModel([done], { ...OPTS, recentTerminal: 1 });
    const lines = buildFleetWidgetLines(model, {
      terminalLingerMs: 5_000,
      awaitNotificationMs: 600_000,
      receiptOf: () => ({ kind: "pending", at: 0 }),
      mentionNoteOf: () => "继续\n  上次  的任务",
    });
    expect(lines?.join("\n")).toContain("· 待处理");
    // X6b: the awaiting preview is the raw @ message (whitespace folded), never the dispatch prompt
    expect(lines?.join("\n")).toContain("╰ @ » 继续 上次 的任务");
    expect(lines?.join("\n")).not.toContain("do this carefully");
  });

  it("pending terminal notifications disappear after the await hard bound", () => {
    const done = snapshot({ status: "completed", phase: "settled", updatedAt: 0 });
    const model = buildFleetViewModel([done], { ...OPTS, recentTerminal: 1 });
    expect(
      buildFleetWidgetLines(model, {
        awaitNotificationMs: 1_000,
        receiptOf: () => ({ kind: "pending", at: 0 }),
      }),
    ).toBeUndefined();
  });

  it("entered receipts linger from enteredAt, not from settle time", () => {
    const done = snapshot({ status: "completed", phase: "settled", updatedAt: 0 }); // settled 10s ago
    const model = buildFleetViewModel([done], { ...OPTS, recentTerminal: 1 });
    // Entered 1s ago → visible even though settledAgoMs (10s) is way past lingerMs.
    const recent = buildFleetWidgetLines(model, {
      terminalLingerMs: 5_000,
      receiptOf: () => ({ kind: "entered", at: NOW - 1_000 }),
    });
    expect(recent?.join("\n")).toContain("completed");
    expect(recent?.join("\n")).not.toContain("待处理");
    // Entered 9s ago → past linger from enteredAt → gone.
    expect(
      buildFleetWidgetLines(model, {
        terminalLingerMs: 5_000,
        receiptOf: () => ({ kind: "entered", at: NOW - 9_000 }),
      }),
    ).toBeUndefined();
  });

  it("undeliverable receipts fall back to the old settledAgoMs linger semantics", () => {
    const fresh = snapshot({ status: "failed", phase: "settled", updatedAt: NOW - 100 });
    const old = snapshot({ runId: "old-00000", status: "failed", phase: "settled", updatedAt: NOW - 9_000 });
    const receiptOf = () => ({ kind: "undeliverable" as const });
    const shown = buildFleetWidgetLines(buildFleetViewModel([fresh], { ...OPTS, recentTerminal: 1 }), {
      terminalLingerMs: 5_000,
      receiptOf,
    });
    expect(shown?.join("\n")).toContain("failed");
    expect(
      buildFleetWidgetLines(buildFleetViewModel([old], { ...OPTS, recentTerminal: 1 }), {
        terminalLingerMs: 5_000,
        receiptOf,
      }),
    ).toBeUndefined();
  });

  it("awaiting rows win budget over lingering rows; hidden awaiting still counted in header", () => {
    const active = snapshot({ runId: "live-0000", diag: diag({ lastEventAt: 9_900 }) });
    const awaiting = snapshot({ runId: "wait-0000", status: "completed", phase: "settled", updatedAt: 9_000 });
    const lingering = snapshot({
      runId: "ling-0000",
      status: "completed",
      phase: "settled",
      updatedAt: 9_999,
      diag: diag({ label: "旧完成" }),
    });
    const model = buildFleetViewModel([active, awaiting, lingering], { ...OPTS, recentTerminal: 3 });
    const lines = buildFleetWidgetLines(model, {
      maxRows: 2,
      receiptOf: (runId) => (runId === "wait-0000" ? { kind: "pending", at: 9_000 } : { kind: "untracked" }),
    })!;
    expect(lines.join("\n")).toContain("· 待处理");
    expect(lines.join("\n")).not.toContain("旧完成"); // lingering starved by budget
    expect(lines[0]).toContain("1 待处理");
  });

  it("header +N more counts awaiting rows hidden by the budget (no double-count)", () => {
    const runs = [
      ...[0, 1].map((i) => snapshot({ runId: `live-${i}000`, diag: diag({ createdAt: i, lastEventAt: 9_900 }) })),
      ...[0, 1].map((i) =>
        snapshot({ runId: `wait-${i}000`, status: "completed" as const, phase: "settled" as const, updatedAt: 9_000 }),
      ),
    ];
    const model = buildFleetViewModel(runs, { ...OPTS, recentTerminal: 3 });
    const lines = buildFleetWidgetLines(model, {
      maxRows: 3,
      receiptOf: (runId) =>
        runId.startsWith("wait-") ? { kind: "pending" as const, at: 9_000 } : { kind: "untracked" as const },
    })!;
    expect(lines[0]).toContain("2 待处理"); // total awaiting, shown or not
    expect(lines[0]).toContain("+1 more"); // 1 awaiting main hidden behind the budget
    expect(lines.filter((l) => l.includes("· 待处理"))).toHaveLength(1);
  });

  it("preview lines never render without their awaiting main row", () => {
    const actives = Array.from({ length: 6 }, (_, i) =>
      snapshot({ runId: `live-${i}000`, diag: diag({ createdAt: i, lastEventAt: 9_900 }) }),
    );
    const awaiting = snapshot({
      runId: "wait-0000",
      status: "completed",
      phase: "settled",
      updatedAt: 9_000,
      diag: diag({ taskPrompt: "some task prompt" }),
    });
    const model = buildFleetViewModel([...actives, awaiting], { ...OPTS, recentTerminal: 3 });
    const lines = buildFleetWidgetLines(model, {
      maxRows: 6,
      receiptOf: (runId) =>
        runId === "wait-0000" ? { kind: "pending" as const, at: 9_000 } : { kind: "untracked" as const },
      mentionNoteOf: (runId) => (runId === "wait-0000" ? "用户的 @ 消息" : undefined),
    })!;
    expect(lines.join("\n")).not.toContain("· 待处理"); // main row hidden by budget
    expect(lines.join("\n")).not.toContain("@ »"); // mention preview must not orphan
    expect(lines[0]).toContain("1 待处理");
    expect(lines[0]).toContain("+1 more");
  });

  it("awaiting entries preview ONLY the user @ message, never the dispatch prompt", () => {
    const awaiting = snapshot({
      runId: "wait-0000",
      status: "completed",
      phase: "settled",
      updatedAt: 9_000,
      diag: diag({ taskPrompt: "dispatch prompt must not be shown" }),
    });
    const model = buildFleetViewModel([awaiting], { ...OPTS, recentTerminal: 1 });
    // No mention note → no preview line at all (X6b).
    const withoutNote = buildFleetWidgetLines(model, {
      receiptOf: () => ({ kind: "pending" as const, at: 9_000 }),
    })!;
    expect(withoutNote.join("\n")).toContain("· 待处理");
    expect(withoutNote.join("\n")).not.toContain("dispatch prompt");
    expect(withoutNote.join("\n")).not.toContain("╰");
    // With a mention note → the note is the only preview.
    const withNote = buildFleetWidgetLines(model, {
      receiptOf: () => ({ kind: "pending" as const, at: 9_000 }),
      mentionNoteOf: (runId) => (runId === "wait-0000" ? "刚扩的音 跑完了吗" : undefined),
    })!;
    expect(withNote.join("\n")).toContain("╰ @ » 刚扩的音 跑完了吗".replace(/\s+/g, " "));
    expect(withNote.join("\n")).not.toContain("dispatch prompt");
  });

  it("elastic expansion wraps the newest awaiting mention preview to at most 4 lines", () => {
    const long = "word ".repeat(80).trim(); // wraps to many lines at width 40
    const awaiting = snapshot({
      runId: "wait-0000",
      status: "completed",
      phase: "settled",
      updatedAt: 9_000,
      diag: diag({}),
    });
    const model = buildFleetViewModel([awaiting], { ...OPTS, recentTerminal: 1 });
    const lines = buildFleetWidgetLines(model, {
      width: 40,
      receiptOf: () => ({ kind: "pending" as const, at: 9_000 }),
      mentionNoteOf: (runId) => (runId === "wait-0000" ? long : undefined),
    })!;
    expect(lines.filter((l) => l.includes("╰ @ »"))).toHaveLength(4); // capped, not 1 and not 5+
  });

  it("M6: just-finished runs linger dimmed (✓/✗) within terminalLingerMs, then vanish", () => {
    const active = snapshot({ runId: "live-0000", diag: diag({ lastEventAt: 9_900 }) });
    const done = snapshot({
      runId: "done-0000",
      status: "completed",
      phase: "settled",
      updatedAt: 9_999,
      diag: diag({ usage: usage(0.11), label: "刚完成" }),
    });
    const failed = snapshot({ runId: "fail-0000", status: "failed", phase: "settled", updatedAt: 9_998 });
    const old = snapshot({ runId: "old-00000", status: "completed", phase: "settled", updatedAt: 1_000 }); // 9s ago
    const model = buildFleetViewModel([active, done, failed, old], { ...OPTS, recentTerminal: 3 });
    const lines = buildFleetWidgetLines(model)!;
    expect(lines[0]).toContain("1 active Agents");
    expect(lines[1]).toContain("live-000");
    expect(
      lines.some(
        (l) => l.startsWith("✓ 刚完成 ") && !l.includes("#done-000") && l.includes("completed") && l.includes("$0.11"),
      ),
    ).toBe(true);
    expect(lines.some((l) => l.startsWith("✗ fail-000") && l.includes("failed"))).toBe(true);
    expect(lines.join("\n")).not.toContain("old-0000"); // 9s ago → expired
    // all-terminal fleet: still shown while lingering, hidden once expired
    const onlyDone = buildFleetViewModel([done], { ...OPTS, recentTerminal: 3 });
    expect(buildFleetWidgetLines(onlyDone)![0]).toContain("0 active Agents");
    expect(buildFleetWidgetLines(onlyDone, { terminalLingerMs: 0 })).toBeUndefined();
  });
});

describe("view-model: treeOrder", () => {
  const row = (runId: string, parentRunId?: string) => ({
    ...buildFleetViewModel([snapshot({ runId, ...(parentRunId ? { parentRunId } : {}) })], OPTS).rows[0]!,
  });
  it("orders depth-first with correct depths; unknown parents stay top-level", () => {
    const rows = [row("a"), row("c", "b"), row("b", "a"), row("x", "missing")];
    const ordered = treeOrder(rows);
    expect(ordered.map((o) => [o.row.runId, o.depth])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
      ["x", 0],
    ]);
  });
});

describe("view-model: background bash rows", () => {
  const bash = (overrides: Record<string, unknown> = {}) => ({
    jobId: "b_TEST0001",
    commandPreview: "npm run build",
    status: "running" as const,
    highlight: "none" as const,
    elapsedMs: 12_000,
    logBytes: 45 * 1024,
    ...overrides,
  });

  it("formats sizes, statuses, and the final meaningful folded tail line", () => {
    expect(formatLogSize(0)).toBe("0B");
    expect(formatLogSize(1023)).toBe("1023B");
    expect(formatLogSize(1024)).toBe("1.0KB");
    expect(formatLogSize(1.5 * 1024 * 1024)).toBe("1.5MB");
    expect(bashJobHighlight("running")).toBe("none");
    expect(bashJobHighlight("completed")).toBe("none");
    expect(bashJobHighlight("failed")).toBe("crit");
    expect(bashJobHighlight("timed_out")).toBe("crit");
    expect(bashJobHighlight("killed")).toBe("warn");
    expect(bashJobHighlight("exited_unknown")).toBe("warn");
    expect(bashJobHighlight("orphaned")).toBe("warn");
    expect(tailLine("first\n  last  line \n\n")).toBe("last line");
    expect(tailLine(" \n\t")).toBeUndefined();
    expect(tailLine("输出\n完成")).toBe("完成");
  });

  it("renders running bash main/activity rows and bash-only visibility", () => {
    const model = buildFleetViewModel([], OPTS);
    const lines = buildFleetWidgetLines(model, { bashJobs: [bash({ logTail: "added 42 files" })] })!;
    expect(lines).toEqual([
      "● 1 background bash",
      "  $ npm run build · running · 12s · log 45KB",
      "  ╰ » added 42 files",
    ]);
  });

  it("shares the main-row pool and counts hidden run/bash identities precisely", () => {
    const runs = Array.from({ length: 3 }, (_, i) => snapshot({ runId: `run-${i}00000` }));
    const lines = buildFleetWidgetLines(buildFleetViewModel(runs, OPTS), {
      maxRows: 4,
      bashJobs: [bash({ jobId: "b_1" }), bash({ jobId: "b_2" })],
    })!;
    expect(lines.filter((line) => line.includes("$ npm run build"))).toHaveLength(1);
    expect(lines[0]).toContain("3 active Agents · 2 bash · +1 more");
  });

  it("uses independent bash terminal markers and expires terminal rows", () => {
    const rows = [
      bash({ status: "completed", highlight: "none", settledAgoMs: 1000 }),
      bash({ jobId: "b_2", status: "failed", highlight: "crit", settledAgoMs: 1000 }),
      bash({ jobId: "b_3", status: "killed", highlight: "warn", settledAgoMs: 1000 }),
    ];
    const lines = buildFleetWidgetLines(buildFleetViewModel([], OPTS), { bashJobs: rows });
    expect(lines).toEqual([
      "● 0 active Agents",
      "✓ $ npm run build · completed · 12s · log 45KB",
      "✗ $ npm run build · failed · 12s · log 45KB",
      "! $ npm run build · killed · 12s · log 45KB",
    ]);
    expect(
      buildFleetWidgetLines(buildFleetViewModel([], OPTS), {
        terminalLingerMs: 5000,
        bashJobs: [bash({ settledAgoMs: 5001, status: "completed" })],
      }),
    ).toBeUndefined();
  });

  it("keeps linger rows inside the shared maxRows budget", () => {
    const active = Array.from({ length: 4 }, (_, i) => snapshot({ runId: `active-${i}0000` }));
    const terminalRuns = Array.from({ length: 2 }, (_, i) =>
      snapshot({ runId: `done-${i}00000`, status: "failed", phase: "settled", updatedAt: NOW - 1000 }),
    );
    const terminalBash = [
      bash({ jobId: "b_done1", status: "failed", highlight: "crit", settledAgoMs: 1000, logTail: "tail" }),
      bash({ jobId: "b_done2", status: "failed", highlight: "crit", settledAgoMs: 1000, logTail: "tail" }),
    ];
    const lines = buildFleetWidgetLines(
      buildFleetViewModel([...active, ...terminalRuns], { ...OPTS, recentTerminal: 3 }),
      {
        maxRows: 6,
        bashJobs: terminalBash,
      },
    )!;
    expect(lines.length).toBeLessThanOrEqual(7);
  });

  it("reports overflow in the bash-only fallback header", () => {
    const lines = buildFleetWidgetLines(buildFleetViewModel([], OPTS), {
      maxRows: 6,
      bashJobs: Array.from({ length: 8 }, (_, i) => bash({ jobId: `b_${i}` })),
    })!;
    expect(lines[0]).toContain("8 background bash");
    expect(lines[0]).toContain("+2 more");
  });

  it("keeps the no-run/no-bash regression hidden", () => {
    expect(buildFleetWidgetLines(buildFleetViewModel([], OPTS))).toBeUndefined();
  });
});

describe("FleetWidgetController (fake ui)", () => {
  function fakeQuery(runs: RunSnapshot[]): QueryService & { runs: RunSnapshot[] } {
    const holder = {
      runs,
      get: (id: string) => holder.runs.find((r) => r.runId === id),
      list: () => [...holder.runs],
      wait: async () => ({ ok: false as const, reason: "unknown_run" as const }),
      waitAll: async () => ({ settled: [], pending: [] }),
      steer: async () => ({ ok: false as const, reason: "not_running" as const }),
      stop: async () => ({ ok: false as const, reason: "stop_failed" as const, escalatedTo: "L4" as const }),
    };
    return holder;
  }

  /**
   * M-C2: the controller now installs a pi-tui COMPONENT FACTORY (mirrors
   * pi's real `setExtensionWidget`: `content(tui, theme)` builds the live
   * component) instead of a plain string array — tests assert against
   * `renderedLines()` / `mountCount` / `requestRenderCount` rather than
   * indexing raw `calls[].content` as a string array.
   */
  type WidgetFactory = (tui: { requestRender: () => void }, theme: unknown) => Component;
  interface WidgetCall {
    key: string;
    content: string[] | WidgetFactory | undefined;
    options?: { placement?: string };
  }
  function fakeUi() {
    const calls: WidgetCall[] = [];
    let mounted: Component | undefined;
    let mountCount = 0;
    let requestRenderCount = 0;
    const tui = {
      requestRender: () => {
        requestRenderCount++;
      },
    };
    return {
      calls,
      get mountCount() {
        return mountCount;
      },
      get requestRenderCount() {
        return requestRenderCount;
      },
      setWidget(key: string, content: string[] | WidgetFactory | undefined, options?: { placement?: string }) {
        calls.push({ key, content, options });
        if (content === undefined) {
          mounted = undefined;
        } else if (typeof content === "function") {
          mountCount++;
          mounted = content(tui, {});
        }
      },
      /** The widget's current visible lines, however they got there (initial
       *  mount or a later requestRender-driven update) — mirrors what a user
       *  would actually see on the next paint. */
      renderedLines(): string[] | undefined {
        return mounted?.render(200);
      },
    };
  }

  const lifecycleEvent = (runId: string): LifecycleEvent => ({ runId, generation: 1, status: "running", at: NOW });

  it("mounts a component factory above the editor exactly once when runs are active", () => {
    const clock = new FakeClock(NOW);
    const ui = fakeUi();
    const query = fakeQuery([snapshot({ runId: "live-0000", diag: diag({ createdAt: 9_000, lastEventAt: 9_900 }) })]);
    new FleetWidgetController({ ui, query, clock, idleBudgetMs: 1000 });
    expect(ui.calls).toHaveLength(1);
    expect(ui.calls[0]!.key).toBe(FLEET_WIDGET_KEY);
    expect(ui.calls[0]!.options?.placement).toBe("aboveEditor");
    expect(typeof ui.calls[0]!.content).toBe("function"); // component factory, not a string[]
    expect(ui.mountCount).toBe(1);
    expect(ui.renderedLines()).toEqual([" ● 1 active Agents", "   live-000 · 🤔 1s Σ1s"]);
    expect(clock.pendingTimers).toBe(1); // 1s tick armed
  });

  it("hides the widget (setWidget undefined) when no runs are active", () => {
    const clock = new FakeClock(NOW);
    const ui = fakeUi();
    new FleetWidgetController({ ui, query: fakeQuery([]), clock });
    expect(ui.calls).toHaveLength(1);
    expect(ui.calls[0]!.content).toBeUndefined();
    expect(ui.mountCount).toBe(0);
  });

  it("refreshes on the clock tick via setLines + requestRender — no repeat setWidget call", () => {
    const clock = new FakeClock(NOW);
    const ui = fakeUi();
    const query = fakeQuery([snapshot({ runId: "live-0000", diag: diag({ createdAt: 9_000, lastEventAt: 9_900 }) })]);
    new FleetWidgetController({ ui, query, clock });
    clock.advance(61_000);
    expect(ui.renderedLines()?.[1]).toContain("1m02s"); // now=71_000, createdAt=9_000
    // One push per 1s tick, but ALL of them update the same mounted component.
    expect(ui.mountCount).toBe(1);
    expect(ui.calls).toHaveLength(1); // setWidget itself never called again
    expect(ui.requestRenderCount).toBeGreaterThan(10);
  });

  it("H1 onLifecycle triggers an immediate refresh (start → shown, finish → hidden); re-activation remounts a fresh component", () => {
    const clock = new FakeClock(NOW);
    const ui = fakeUi();
    const query = fakeQuery([]);
    const widget = new FleetWidgetController({ ui, query, clock });
    expect(ui.calls[0]!.content).toBeUndefined();

    query.runs.push(snapshot({ runId: "live-0000", diag: diag({ createdAt: 9_000, lastEventAt: 9_900 }) }));
    widget.lifecycle.onLifecycle!(lifecycleEvent("live-0000"));
    expect(ui.renderedLines()).toEqual([" ● 1 active Agents", "   live-000 · 🤔 1s Σ1s"]);
    expect(ui.mountCount).toBe(1); // first activation after starting idle

    query.runs.length = 0;
    widget.lifecycle.onLifecycle!({ ...lifecycleEvent("live-0000"), status: "completed" });
    expect(ui.calls[ui.calls.length - 1]!.content).toBeUndefined();

    // Re-activating after the idle setWidget(undefined) installs a fresh component.
    query.runs.push(snapshot({ runId: "live-1111", diag: diag({ createdAt: 9_000, lastEventAt: 9_900 }) }));
    widget.lifecycle.onLifecycle!(lifecycleEvent("live-1111"));
    expect(ui.mountCount).toBe(2);
  });

  it("dispose stops the tick and clears the widget; double dispose is a no-op", () => {
    const clock = new FakeClock(NOW);
    const ui = fakeUi();
    const query = fakeQuery([snapshot({ runId: "live-0000" })]);
    const widget = new FleetWidgetController({ ui, query, clock });
    widget.dispose();
    expect(clock.pendingTimers).toBe(0);
    expect(ui.calls[ui.calls.length - 1]).toEqual({ key: FLEET_WIDGET_KEY, content: undefined, options: undefined });
    expect(ui.renderedLines()).toBeUndefined(); // cleared on dispose
    const callCount = ui.calls.length;
    clock.advance(5_000);
    widget.dispose();
    expect(ui.calls).toHaveLength(callCount); // nothing after dispose
  });

  it("non-interactive host without setWidget → inert: no throw, no timer, refresh is a no-op", () => {
    const clock = new FakeClock(NOW);
    const query = fakeQuery([snapshot({ runId: "live-0000" })]);
    const widget = new FleetWidgetController({ ui: {}, query, clock });
    expect(clock.pendingTimers).toBe(0);
    expect(() => {
      widget.refresh();
      widget.lifecycle.onLifecycle!(lifecycleEvent("live-0000"));
      widget.dispose();
    }).not.toThrow();
    const noUi = new FleetWidgetController({ query, clock });
    expect(clock.pendingTimers).toBe(0);
    expect(() => noUi.dispose()).not.toThrow();
  });

  it("a throwing setWidget disables the widget silently (sticky), never propagates", () => {
    const clock = new FakeClock(NOW);
    const query = fakeQuery([snapshot({ runId: "live-0000" })]);
    const ui = {
      calls: 0,
      setWidget() {
        this.calls++;
        throw new Error("no TUI in rpc mode");
      },
    };
    const widget = new FleetWidgetController({ ui, query, clock });
    expect(ui.calls).toBe(1); // initial refresh attempted once
    expect(clock.pendingTimers).toBe(0); // tick stopped after the throw
    expect(() => {
      widget.refresh();
      widget.lifecycle.onLifecycle!(lifecycleEvent("live-0000"));
      widget.dispose();
    }).not.toThrow();
    expect(ui.calls).toBe(1); // sticky dead: no further attempts
  });

  // The tick is a self-rescheduling one-shot, so a throw that skips the
  // re-arm is not a dropped frame but a permanently frozen agent tree; and the
  // constructor's initial refresh() runs inside buildSessionStack, so a throw
  // there takes the whole extension down with the session_start handler. (The
  // onLifecycle path below is defense in depth only — mergeExtensionPoints
  // already catches throws on the H1 fan-out.)
  it("a throwing view-model source drops the frame, warns once, and keeps the tick alive (recovers next frame)", () => {
    const clock = new FakeClock(NOW);
    const ui = fakeUi();
    const query = fakeQuery([snapshot({ runId: "live-0000", diag: diag({ createdAt: 9_000, lastEventAt: 9_900 }) })]);
    const healthy = query.list;
    let boom = true;
    query.list = () => {
      if (boom) throw new Error("registry exploded");
      return healthy();
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const widget = new FleetWidgetController({ ui, query, clock });
      expect(ui.calls).toHaveLength(0); // initial frame dropped, nothing pushed
      expect(clock.pendingTimers).toBe(1); // ...but the tick is armed anyway

      clock.advance(3_000); // three more failing frames
      expect(ui.calls).toHaveLength(0);
      expect(clock.pendingTimers).toBe(1); // clock never stopped
      expect(warn).toHaveBeenCalledTimes(1); // warn-once, not once per tick

      boom = false;
      clock.advance(1_000);
      const last = ui.calls[ui.calls.length - 1]!;
      expect(last.key).toBe(FLEET_WIDGET_KEY);
      expect(ui.renderedLines()?.[0]).toContain("1 active Agents"); // recovered on its own
      widget.dispose();
    } finally {
      warn.mockRestore();
    }
  });

  it("construction survives a throwing view model (a throw would escape buildSessionStack → session_start)", () => {
    const clock = new FakeClock(NOW);
    const ui = fakeUi();
    const query = fakeQuery([snapshot({ runId: "live-0000" })]);
    query.list = () => {
      throw new Error("registry exploded");
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let widget: FleetWidgetController | undefined;
      expect(() => {
        widget = new FleetWidgetController({ ui, query, clock });
      }).not.toThrow();
      expect(clock.pendingTimers).toBe(1); // still armed, so it can recover later
      widget!.dispose();
    } finally {
      warn.mockRestore();
    }
  });

  it("onLifecycle never propagates a refresh failure (warn-once shared with the tick path)", () => {
    const clock = new FakeClock(NOW);
    const ui = fakeUi();
    const query = fakeQuery([snapshot({ runId: "live-0000" })]);
    query.list = () => {
      throw new Error("registry exploded");
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const widget = new FleetWidgetController({ ui, query, clock });
      expect(() => widget.lifecycle.onLifecycle!(lifecycleEvent("live-0000"))).not.toThrow();
      expect(() => widget.refresh()).not.toThrow();
      expect(() => clock.advance(2_000)).not.toThrow();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(clock.pendingTimers).toBe(1);
      widget.dispose();
      expect(clock.pendingTimers).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  it("settings off (enabled: false) → inert: no setWidget call, no timer", () => {
    const clock = new FakeClock(NOW);
    const ui = fakeUi();
    const query = fakeQuery([snapshot({ runId: "live-0000" })]);
    const widget = new FleetWidgetController({ ui, query, clock, enabled: false });
    expect(ui.calls).toHaveLength(0);
    expect(clock.pendingTimers).toBe(0);
    expect(() => widget.dispose()).not.toThrow();
  });

  it("component.render(width) never exceeds width, for any width including 1", () => {
    const clock = new FakeClock(NOW);
    const ui = fakeUi();
    const query = fakeQuery([
      snapshot({
        runId: "live-0000",
        diag: diag({
          createdAt: 9_000,
          lastEventAt: 9_900,
          label: "a very very very long agent label that should never overflow",
          toolHistory: [{ name: "bash", toolCallId: "t", startedAt: 9_900 }],
        }),
      }),
    ]);
    new FleetWidgetController({ ui, query, clock });
    const calls = ui.calls;
    expect(typeof calls[0]!.content).toBe("function");
    const factory = calls[0]!.content as (tui: { requestRender: () => void }, theme: unknown) => Component;
    const component = factory({ requestRender: () => {} }, {});
    for (const width of [1, 2, 5, 20, 79, 80, 200]) {
      const lines = component.render(width);
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it("settings.fleetWidgetMaxRows reaches buildFleetWidgetLines through deps.maxRows, clamped to WIDGET_MAX_ROWS", () => {
    const clock = new FakeClock(NOW);
    const ui = fakeUi();
    const runs = Array.from({ length: WIDGET_MAX_ROWS + 10 }, (_, i) =>
      snapshot({ runId: `run-${i}0000`, diag: diag({ createdAt: i, lastEventAt: 9_900 }) }),
    );
    // Deliberately out-of-range (mirrors an already-clamped settings value
    // reaching the controller unchanged) — the controller/builder clamp again.
    new FleetWidgetController({ ui, query: fakeQuery(runs), clock, maxRows: WIDGET_MAX_ROWS + 999 });
    const lines = ui.renderedLines()!;
    // header + WIDGET_MAX_ROWS run rows, never more.
    expect(lines).toHaveLength(1 + WIDGET_MAX_ROWS);

    const uiSmall = fakeUi();
    new FleetWidgetController({ ui: uiSmall, query: fakeQuery(runs), clock: new FakeClock(NOW), maxRows: 3 });
    const smallLines = uiSmall.renderedLines()!;
    expect(smallLines).toHaveLength(1 + 3);
    expect(smallLines[0]).toContain("+");
  });
});

describe("M9: workflow group headers in the tree", () => {
  it("children with parentRunId === workflowId are grouped under a ⚙ header; others stay in the general tree", () => {
    const wfChild1 = snapshot({
      runId: "child-a00",
      parentRunId: "wf-1",
      diag: diag({ createdAt: 8_000, lastEventAt: 9_900, label: "评审A" }),
    });
    const wfChild2 = snapshot({
      runId: "child-b00",
      parentRunId: "wf-1",
      diag: diag({ createdAt: 8_500, lastEventAt: 9_900, label: "评审B" }),
    });
    const loner = snapshot({ runId: "loner-000", diag: diag({ createdAt: 7_000, lastEventAt: 9_900 }) });
    const model = buildFleetViewModel([wfChild1, wfChild2, loner], OPTS);
    const lines = buildFleetWidgetLines(model, {
      workflows: [
        { workflowId: "wf-1", name: "plan-review", elapsedMs: 121_000, doneTotal: 0, failedTotal: 0, activeTotal: 2 },
      ],
    })!;
    expect(lines[0]).toContain("3 active Agents");
    expect(lines[1]).toBe("⚙ plan-review · 2m01s · ▸2");
    expect(lines[2]).toContain("↳ 评审A");
    expect(lines[3]).toContain("↳ 评审B");
    expect(lines[4]).toContain("loner-00");
    expect(lines[4]).not.toContain("↳");
  });

  it("a workflow with no visible children still shows its header; widget visible even with 0 active runs", () => {
    const model = buildFleetViewModel([], OPTS);
    const lines = buildFleetWidgetLines(model, {
      workflows: [
        { workflowId: "wf-2", name: "nightly", elapsedMs: 5_000, doneTotal: 0, failedTotal: 0, activeTotal: 0 },
      ],
    })!;
    expect(lines[0]).toContain("0 active Agents");
    expect(lines[1]).toBe("⚙ nightly · 5s");
  });

  it("without workflows opt, workflow-orphaned children keep the plain ↳ top-level rendering", () => {
    const child = snapshot({
      runId: "child-a00",
      parentRunId: "wf-1",
      diag: diag({ createdAt: 8_000, lastEventAt: 9_900 }),
    });
    const lines = buildFleetWidgetLines(buildFleetViewModel([child], OPTS))!;
    expect(lines[1]).toContain("↳ child-a0");
  });
});

describe("worktree isolation marker rendering (X1)", () => {
  it("active isolated runs show ⎇ wt on the main row; non-isolated runs show no marker", () => {
    const isolated = snapshot({ diag: diag({ label: "isolate", worktree: { state: "active" } }) });
    const lines = buildFleetWidgetLines(buildFleetViewModel([isolated], OPTS), { width: 120 })!;
    expect(lines.join("\n")).toContain("⎇ wt");

    const plain = snapshot({ diag: diag({ label: "plain" }) });
    const plainLines = buildFleetWidgetLines(buildFleetViewModel([plain], OPTS), { width: 120 })!;
    expect(plainLines.join("\n")).not.toContain("⎇");
  });

  it.each([
    ["committed branch", { state: "committed", branch: "pi-agent-r_ABC12345" } as const, "⎇ pi-agent-r_ABC12345"],
    ["kept worktree", { state: "kept" } as const, "⎇ kept"],
    ["clean removal", { state: "clean" } as const, "⎇ clean"],
    // beforeReap runs after settlement: a just-settled row can still carry the
    // active marker — acceptable, it converges on the next 1Hz tick.
    ["pre-report active", { state: "active" } as const, "⎇ wt"],
  ])("terminal rows render the %s marker", (_label, wt, expected) => {
    const done = snapshot({
      runId: "wt-run-0000",
      status: "completed",
      phase: "settled",
      updatedAt: NOW - 100,
      diag: diag({ label: "isolate", worktree: wt }),
    });
    const model = buildFleetViewModel([done], { ...OPTS, recentTerminal: 1 });
    const lines = buildFleetWidgetLines(model, {
      terminalLingerMs: 5_000,
      receiptOf: () => ({ kind: "untracked" as const }),
    })!;
    expect(lines.join("\n")).toContain(expected);
  });

  it("truncates an over-long branch name on the terminal marker", () => {
    const done = snapshot({
      runId: "wt-run-0000",
      status: "completed",
      phase: "settled",
      updatedAt: NOW - 100,
      diag: diag({
        label: "isolate",
        worktree: { state: "committed", branch: "pi-agent-extremely-long-run-identifier" },
      }),
    });
    const model = buildFleetViewModel([done], { ...OPTS, recentTerminal: 1 });
    const lines = buildFleetWidgetLines(model, {
      terminalLingerMs: 5_000,
      receiptOf: () => ({ kind: "untracked" as const }),
    })!;
    expect(lines.join("\n")).toContain("⎇ pi-agent-extremely-…");
    expect(lines.join("\n")).not.toContain("pi-agent-extremely-long-run-identifier");
  });
});

const wfChip = (
  id: string,
  state: "pending" | "active" | "draining" | "done",
  spawned = 0,
  settled = 0,
  failed = 0,
  replayed = 0,
): WorkflowPhaseChip => ({ id, state, spawned, settled, failed, replayed });

describe("M11: workflow pipeline view", () => {
  const chip = wfChip;

  it("renders header with budget + counts and the phase chain under it (✗0 omitted, frame picks the spinner glyph)", () => {
    const model = buildFleetViewModel([], OPTS);
    const lines = buildFleetWidgetLines(model, {
      frame: 2, // ⠹
      workflows: [
        {
          workflowId: "wf-1",
          name: "wf-smoke-test",
          elapsedMs: 42_000,
          budgetMs: 600_000,
          doneTotal: 3,
          failedTotal: 0,
          activeTotal: 2,
          phases: [chip("scan", "done", 2, 2), chip("summarize", "active", 3, 1), chip("report", "pending")],
        },
      ],
    })!;
    expect(lines[1]).toBe("⚙ wf-smoke-test · 42s / 10m00s · ✓3 ▸2");
    expect(lines[2]).toBe("  ✓ scan 2/2 → ⠹ summarize 1/3 → ○ report");
  });

  it("no chain line when there are no phases at all (planned empty, never entered) — header stays simple", () => {
    const model = buildFleetViewModel([], OPTS);
    const lines = buildFleetWidgetLines(model, {
      workflows: [
        { workflowId: "wf-2", name: "nightly", elapsedMs: 5_000, doneTotal: 0, failedTotal: 0, activeTotal: 0 },
      ],
    })!;
    expect(lines[1]).toBe("⚙ nightly · 5s");
    expect(lines).toHaveLength(2); // widget header + workflow header only
  });

  it("a single entered phase still renders a one-chip chain; counts hidden while spawned is 0", () => {
    const model = buildFleetViewModel([], OPTS);
    const lines = buildFleetWidgetLines(model, {
      frame: 0,
      workflows: [
        {
          workflowId: "wf-1",
          name: "solo",
          elapsedMs: 1_000,
          doneTotal: 0,
          failedTotal: 0,
          activeTotal: 1,
          phases: [chip("scan", "active")],
        },
      ],
    })!;
    expect(lines[2]).toBe("  ⠋ scan");
  });

  it("colors: done-clean = success, done-with-failures = crit ✗, pending = muted, active = plain", () => {
    const seen: string[] = [];
    const color: FleetColorize = (tone, text) => {
      seen.push(`${tone}:${text}`);
      return text;
    };
    const model = buildFleetViewModel([], OPTS);
    const lines = buildFleetWidgetLines(model, {
      color,
      frame: 4,
      workflows: [
        {
          workflowId: "wf-1",
          name: "tone",
          elapsedMs: 1_000,
          doneTotal: 1,
          failedTotal: 1,
          activeTotal: 1,
          phases: [
            chip("scan", "done", 2, 2, 2),
            chip("build", "done", 1, 1),
            chip("pack", "active", 1),
            chip("ship", "pending"),
          ],
        },
      ],
    })!;
    expect(seen).toContain("crit:✗ scan 2/2");
    expect(seen).toContain("success:✓ build 1/1");
    expect(seen).toContain("muted:○ ship");
    expect(lines[2]).toContain("⠼ pack 0/1"); // active chip: plain (no tone call), glyph from frame 4
  });

  it("a draining phase (left behind, children still running) renders ▸ n/m, plain — never ✓", () => {
    const seen: string[] = [];
    const color: FleetColorize = (tone, text) => {
      seen.push(`${tone}:${text}`);
      return text;
    };
    const line = workflowPhaseChainLine(
      [chip("scan", "draining", 2, 1), chip("summarize", "active", 1), chip("report", "pending")],
      { frame: 0, color },
    );
    expect(line).toBe("▸ scan 1/2 → ⠋ summarize 0/1 → ○ report");
    expect(seen.some((s) => s.includes("scan"))).toBe(false); // plain: no success tone for an unfinished phase
  });

  it("chain truncation keeps the active chip and collapses the sides to … (short arrow: sep width 3)", () => {
    const phases = [
      chip("alpha", "done", 1, 1),
      chip("beta", "done", 1, 1),
      chip("gamma", "active", 2, 1),
      chip("delta", "pending"),
      chip("epsilon", "pending"),
    ];
    // chips are 11+10+11+7+9 wide, sep 3: full chain = 48 + 4×3 = 60.
    // width 30 → window [gamma..delta]: 11+7+3 = 21 + two … sides (4+4) = 29 fits, beta side (28+6+4+4=42) does not
    expect(workflowPhaseChainLine(phases, { width: 30, frame: 0 })).toBe("… → ⠋ gamma 1/2 → ○ delta → …");
    // width 37 → single-sided: [gamma..epsilon] = 27+6+4 = 37 fits, [beta..epsilon] = 37+9+4 = 50 does not
    expect(workflowPhaseChainLine(phases, { width: 37, frame: 0 })).toBe("… → ⠋ gamma 1/2 → ○ delta → ○ epsilon");
    // very narrow: even the anchored window overflows → the anchor chip itself is truncated
    expect(visibleWidth(workflowPhaseChainLine(phases, { width: 8, frame: 0 })!)).toBeLessThanOrEqual(8);
    // wide enough → whole chain, no ellipses (full width: 48 + 4×3 = 60)
    expect(workflowPhaseChainLine(phases, { width: 60, frame: 0 })).toBe(
      "✓ alpha 1/1 → ✓ beta 1/1 → ⠋ gamma 1/2 → ○ delta → ○ epsilon",
    );
    expect(workflowPhaseChainLine([], { width: 40 })).toBeUndefined();
  });

  it("replay-only chips render `✓ name ↩ N` — no fraction, since replay hits carry no spawn", () => {
    const line = workflowPhaseChainLine([chip("gather", "done", 0, 0, 0, 3), chip("analyze", "active", 1, 0, 0, 0)], {
      frame: 2,
    });
    expect(line).toBe("✓ gather ↩ 3 → ⠹ analyze 0/1");
  });

  it("mixed chips keep the live-only fraction and append the replay tally: `✓ x 2/2 ↩ 1`", () => {
    // settled counts live settles only — the fraction stays `live settled/live spawned`
    const line = workflowPhaseChainLine([chip("x", "done", 2, 2, 0, 1)], { frame: 0 });
    expect(line).toBe("✓ x 2/2 ↩ 1");
    const draining = workflowPhaseChainLine([chip("y", "draining", 2, 1, 0, 1)], { frame: 0 });
    expect(draining).toBe("▸ y 1/2 ↩ 1");
  });

  it("collapsedVisits renders `…+N` at the chain head and absorbs left-truncated chips into the count", () => {
    const phases = [chip("a", "done", 1, 1), chip("b", "done", 1, 1), chip("c", "active", 1)];
    // whole chain fits → the marker names just the dropped visits
    expect(workflowPhaseChainLine(phases, { width: 120, frame: 0, collapsedVisits: 2 })).toBe(
      "…+2 → ✓ a 1/1 → ✓ b 1/1 → ⠋ c 0/1",
    );
    // narrow window hides a+b on the left → they join the dropped count (…+4), never a second ellipsis
    expect(workflowPhaseChainLine(phases, { width: 22, frame: 0, collapsedVisits: 2 })).toBe("…+4 → ⠋ c 0/1");
    // no collapsed visits, no truncation → no marker at all
    expect(workflowPhaseChainLine(phases, { width: 120, frame: 0 })).toBe("✓ a 1/1 → ✓ b 1/1 → ⠋ c 0/1");
  });

  it("recent settled children render as muted rows after the workflow's active rows, within the leftover budget only", () => {
    const child1 = snapshot({
      runId: "child-a00",
      parentRunId: "wf-1",
      diag: diag({ createdAt: 8_000, lastEventAt: 9_900, label: "wf-sum-journal" }),
    });
    const child2 = snapshot({
      runId: "child-b00",
      parentRunId: "wf-1",
      diag: diag({ createdAt: 8_500, lastEventAt: 9_900, label: "wf-sum-log" }),
    });
    const model = buildFleetViewModel([child1, child2], OPTS);
    const base = {
      workflowId: "wf-1",
      name: "wf-smoke-test",
      elapsedMs: 42_000,
      doneTotal: 3,
      failedTotal: 1,
      activeTotal: 2,
      phases: [chip("scan", "done", 2, 2), chip("summarize", "active", 2, 1)],
      recentSettled: [
        { label: "wf-sum-background", ok: true, durationMs: 8_000, source: "live" as const },
        { label: "wf-sum-config", ok: false, durationMs: 3_500, source: "live" as const },
      ],
    };
    // both active children's identity rows consume maxRows=2 → settled rows hidden
    const tight = buildFleetWidgetLines(buildFleetViewModel([child1, child2], OPTS), {
      maxRows: 2,
      workflows: [base],
    })!;
    expect(tight.filter((l) => l.includes("wf-sum-background"))).toHaveLength(0);
    // leftover budget present → settled rows appear under the workflow, after its active rows
    const lines = buildFleetWidgetLines(model, { maxRows: 4, workflows: [base] })!;
    expect(lines[1]).toBe("⚙ wf-smoke-test · 42s · ✓3 ✗1 ▸2");
    expect(lines[2]).toBe("  ✓ scan 2/2 → ⠋ summarize 1/2");
    expect(lines[3]).toContain("↳ wf-sum-journal");
    expect(lines[4]).toContain("↳ wf-sum-log");
    expect(lines[5]).toBe("    ✓ wf-sum-background 8s");
    expect(lines[6]).toBe("    ✗ wf-sum-config 3s");
  });

  it("replay-settled children render `↩ label replay` (muted, no ✓/✗, no fake duration)", () => {
    const model = buildFleetViewModel([], OPTS);
    const lines = buildFleetWidgetLines(model, {
      frame: 2,
      workflows: [
        {
          workflowId: "wf-1",
          name: "nightly-audit",
          elapsedMs: 4_000,
          doneTotal: 2,
          failedTotal: 1,
          activeTotal: 1,
          phases: [chip("gather", "done", 0, 0, 0, 3), chip("analyze", "active", 1, 0, 0, 0)],
          recentSettled: [
            { label: "fetch-logs", ok: true, durationMs: 0, source: "replay" },
            { label: "fetch-metrics", ok: true, durationMs: 0, source: "replay" },
            { label: "live-child", ok: false, durationMs: 1_500, source: "live" },
          ],
        },
      ],
    })!;
    expect(lines[1]).toBe("⚙ nightly-audit · 4s · ✓2 ✗1 ▸1");
    expect(lines[2]).toBe("  ✓ gather ↩ 3 → ⠹ analyze 0/1");
    expect(lines[3]).toBe("    ↩ fetch-logs replay");
    expect(lines[4]).toBe("    ↩ fetch-metrics replay");
    expect(lines[5]).toBe("    ✗ live-child 1s");
  });

  it("a lingering terminal workflow renders a muted frozen header with ✓/✗ icon and a frozen pipeline", () => {
    const seen: string[] = [];
    const color: FleetColorize = (tone, text) => {
      seen.push(`${tone}:${text}`);
      return text;
    };
    const model = buildFleetViewModel([], OPTS);
    const lines = buildFleetWidgetLines(model, {
      color,
      frame: 3,
      workflows: [
        {
          workflowId: "wf-1",
          name: "wf-smoke-test",
          elapsedMs: 65_000, // controller freezes this at terminal.endedAt
          budgetMs: 600_000,
          doneTotal: 4,
          failedTotal: 0,
          activeTotal: 0,
          phases: [chip("scan", "done", 2, 2), chip("report", "done", 2, 2)],
          terminal: { status: "completed" },
        },
      ],
    })!;
    expect(lines[1]).toBe("✓ wf-smoke-test · 1m05s / 10m00s · ✓4");
    expect(lines[2]).toBe("  ✓ scan 2/2 → ✓ report 2/2");
    expect(seen).toContain("muted:✓ wf-smoke-test · 1m05s / 10m00s · ✓4");
    // a failed freeze swaps the icon (and keeps the crit chain chips) and names its cause
    const failed = buildFleetWidgetLines(model, {
      workflows: [
        {
          workflowId: "wf-2",
          name: "broken",
          elapsedMs: 10_000,
          doneTotal: 0,
          failedTotal: 2,
          activeTotal: 0,
          phases: [chip("scan", "done", 2, 2, 2)],
          terminal: { status: "failed" },
        },
      ],
    })!;
    expect(failed[1]).toBe("✗ broken · 10s · ✗2 · failed");
    expect(failed[2]).toBe("  ✗ scan 2/2");
    // unknown terminal status: judged by the children
    const unknown = buildFleetWidgetLines(model, {
      workflows: [
        {
          workflowId: "wf-3",
          name: "mystery",
          elapsedMs: 1_000,
          doneTotal: 0,
          failedTotal: 0,
          activeTotal: 0,
          phases: [chip("scan", "done", 1, 1)],
          terminal: { status: "terminal" },
        },
      ],
    })!;
    expect(unknown[1]).toBe("✓ mystery · 1s");
  });

  it("frozen headers name the terminal cause: timed out / aborted; completed and unknown add nothing", () => {
    const model = buildFleetViewModel([], OPTS);
    const header = (terminal: { status: string }) =>
      buildFleetWidgetLines(model, {
        workflows: [
          {
            workflowId: "wf-1",
            name: "long-crawl",
            elapsedMs: 30_000,
            budgetMs: 30_000,
            doneTotal: 0,
            failedTotal: 1,
            activeTotal: 0,
            phases: [chip("crawl", "done", 1, 1, 1), chip("digest", "pending")],
            terminal,
          },
        ],
      })!;
    expect(header({ status: "timed_out" })[1]).toBe("✗ long-crawl · 30s / 30s · ✗1 · timed out");
    expect(header({ status: "aborted" })[1]).toBe("✗ long-crawl · 30s / 30s · ✗1 · aborted");
    expect(header({ status: "failed" })[1]).toBe("✗ long-crawl · 30s / 30s · ✗1 · failed");
    // completed adds no cause; its failed-children count still shows
    expect(header({ status: "completed" })[1]).toBe("✓ long-crawl · 30s / 30s · ✗1");
    expect(header({ status: "terminal" })[1]).toBe("✗ long-crawl · 30s / 30s · ✗1"); // unknown judged by children
  });

  it("workflowGroupInput: elapsed freezes at endedAt; recentSettled filters by the linger window", () => {
    const snap: import("../../src/workflow/activity.js").WorkflowActivitySnapshot = {
      workflowId: "wf-1",
      name: "pipe",
      startedAt: 1_000,
      deadlineAt: 301_000,
      currentPhaseId: "scan",
      activeChildren: [{ callId: "c1", enteredAt: 2_000 }],
      settledChildren: [
        { callId: "c0", status: "completed", source: "live", durationMs: 500, settledAt: 16_000 },
        { callId: "c1x", label: "old", status: "completed", source: "live", durationMs: 500, settledAt: 2_000 },
      ],
      settledTotal: 5,
      completedTotal: 4,
      replayTotal: 0,
      queuedChildren: [],
      rejectedTotal: 0,
      stageErrorTotal: 0,
      phases: [{ id: "scan", state: "active", spawned: 1, settled: 0, failed: 0, replayed: 0 }],
    };
    const live = workflowGroupInput(snap, 20_000, 5_000);
    expect(live.elapsedMs).toBe(19_000);
    expect(live.budgetMs).toBe(300_000);
    expect(live.doneTotal).toBe(4);
    expect(live.failedTotal).toBe(1);
    expect(live.activeTotal).toBe(1);
    expect(live.recentSettled).toEqual([{ label: "c0", ok: true, durationMs: 500, source: "live" }]); // the 18s-old one is out
    expect(live.terminal).toBeUndefined();
    const frozen = workflowGroupInput({ ...snap, terminal: { status: "completed", endedAt: 15_000 } }, 20_000, 5_000);
    expect(frozen.elapsedMs).toBe(14_000); // stopped ticking at the freeze
    expect(frozen.terminal).toEqual({ status: "completed" });
    expect(frozen.recentSettled).toEqual([{ label: "c0", ok: true, durationMs: 500, source: "live" }]); // 4s old, still inside
  });

  it("workflowGroupInput passes collapsedVisits through only when visits were dropped", () => {
    const base: import("../../src/workflow/activity.js").WorkflowActivitySnapshot = {
      workflowId: "wf-1",
      name: "pipe",
      startedAt: 1_000,
      activeChildren: [],
      settledChildren: [],
      settledTotal: 0,
      completedTotal: 0,
      replayTotal: 0,
      queuedChildren: [],
      rejectedTotal: 0,
      stageErrorTotal: 0,
      phases: [],
    };
    expect(workflowGroupInput(base, 10_000, 5_000).collapsedVisits).toBeUndefined();
    expect(workflowGroupInput({ ...base, collapsedVisits: 2 }, 10_000, 5_000).collapsedVisits).toBe(2);
  });

  it("widget stays visible (not undefined) while a workflow lingers terminal", () => {
    const model = buildFleetViewModel([], OPTS);
    const lines = buildFleetWidgetLines(model, {
      workflows: [
        {
          workflowId: "wf-1",
          name: "x",
          elapsedMs: 1_000,
          doneTotal: 1,
          failedTotal: 0,
          activeTotal: 0,
          terminal: { status: "completed" },
        },
      ],
    });
    expect(lines).toBeDefined();
    expect(lines![0]).toContain("0 active Agents");
  });

  it("workflowHeaderLine hides the counts segment while nothing has happened (✓0 ▸0 is noise)", () => {
    const line = workflowHeaderLine(
      { workflowId: "wf-1", name: "fresh", elapsedMs: 200, doneTotal: 0, failedTotal: 0, activeTotal: 0 },
      (_t, s) => s,
    );
    expect(line).toBe("⚙ fresh · 200ms");
  });
});

describe("workflow-agent-queue §5: queued + error marks in the pipeline view", () => {
  const plain = (_t: string, s: string) => s;
  const wfChild = (runId: string, label: string) =>
    snapshot({
      runId,
      parentRunId: "wf-1",
      diag: diag({ createdAt: 8_000, lastEventAt: 9_900, label }),
    });

  it("header appends `⧗ N` and `⚠ N` after the counts, each with a mandatory space (⚠ is wide-risk)", () => {
    expect(
      workflowHeaderLine(
        {
          workflowId: "wf-1",
          name: "multi-review",
          elapsedMs: 18_000,
          budgetMs: 600_000,
          doneTotal: 2,
          failedTotal: 0,
          activeTotal: 4,
          queued: [{ label: "review-race", waitedMs: 15_000 }],
          rejectedTotal: 1,
          stageErrorTotal: 1,
        },
        plain,
      ),
    ).toBe("⚙ multi-review · 18s / 10m00s · ✓2 ▸4 ⧗ 1 ⚠ 2");
  });

  it("`⧗ N` shows only with queued calls; `⚠ N` only when rejectedTotal + stageErrorTotal > 0", () => {
    const base = {
      workflowId: "wf-1",
      name: "multi-review",
      elapsedMs: 18_000,
      budgetMs: 600_000,
      doneTotal: 2,
      failedTotal: 0,
      activeTotal: 4,
    };
    // neither mark: exactly the pre-§5 header
    expect(workflowHeaderLine(base, plain)).toBe("⚙ multi-review · 18s / 10m00s · ✓2 ▸4");
    // queued only
    expect(
      workflowHeaderLine(
        {
          ...base,
          queued: [
            { label: "a", waitedMs: 1 },
            { label: "b", waitedMs: 2 },
          ],
        },
        plain,
      ),
    ).toBe("⚙ multi-review · 18s / 10m00s · ✓2 ▸4 ⧗ 2");
    // rejected only / stage errors only / both pool into one ⚠ count
    expect(workflowHeaderLine({ ...base, rejectedTotal: 3 }, plain)).toBe("⚙ multi-review · 18s / 10m00s · ✓2 ▸4 ⚠ 3");
    expect(workflowHeaderLine({ ...base, stageErrorTotal: 2 }, plain)).toBe(
      "⚙ multi-review · 18s / 10m00s · ✓2 ▸4 ⚠ 2",
    );
    expect(workflowHeaderLine({ ...base, rejectedTotal: 1, stageErrorTotal: 2 }, plain)).toBe(
      "⚙ multi-review · 18s / 10m00s · ✓2 ▸4 ⚠ 3",
    );
    // a queued-only workflow still surfaces its counts segment (⧗ alone is signal, not noise)
    expect(
      workflowHeaderLine(
        {
          workflowId: "wf-1",
          name: "fresh-queue",
          elapsedMs: 200,
          doneTotal: 0,
          failedTotal: 0,
          activeTotal: 0,
          queued: [
            { label: "a", waitedMs: 1 },
            { label: "b", waitedMs: 2 },
          ],
        },
        plain,
      ),
    ).toBe("⚙ fresh-queue · 200ms · ⧗ 2");
  });

  it("queued rows render dim after the workflow's active rows and before recent-settled rows", () => {
    const model = buildFleetViewModel([wfChild("child-a00", "active-a"), wfChild("child-b00", "active-b")], OPTS);
    const seen: string[] = [];
    const color = (tone: string, text: string) => {
      seen.push(`${tone}:${text}`);
      return text;
    };
    const lines = buildFleetWidgetLines(model, {
      color,
      workflows: [
        {
          workflowId: "wf-1",
          name: "multi-review",
          elapsedMs: 18_000,
          budgetMs: 600_000,
          doneTotal: 1,
          failedTotal: 0,
          activeTotal: 2,
          queued: [
            { label: "queued-a", waitedMs: 15_000 },
            { label: "queued-b", waitedMs: 14_000 },
          ],
          recentSettled: [{ label: "done-a", ok: true, durationMs: 8_000, source: "live" }],
        },
      ],
    })!;
    expect(lines[1]).toBe("⚙ multi-review · 18s / 10m00s · ✓1 ▸2 ⧗ 2");
    expect(lines[2]).toContain("↳ active-a");
    expect(lines[3]).toContain("↳ active-b");
    expect(lines[4]).toBe("    ⧗ queued-a waiting for slot · 15s");
    expect(lines[5]).toBe("    ⧗ queued-b waiting for slot · 14s");
    expect(lines[6]).toBe("    ✓ done-a 8s");
    // the whole queued row is dim (muted tone), like the settled rows above it
    expect(seen).toContain("muted:    ⧗ queued-a waiting for slot · 15s");
  });

  it("queued rows share the run-identity line budget; overflow joins the `+N more` count", () => {
    const model = buildFleetViewModel([wfChild("child-a00", "active-a"), wfChild("child-b00", "active-b")], OPTS);
    const wf = {
      workflowId: "wf-1",
      name: "multi-review",
      elapsedMs: 18_000,
      doneTotal: 0,
      failedTotal: 0,
      activeTotal: 2,
      queued: [
        { label: "queued-a", waitedMs: 15_000 },
        { label: "queued-b", waitedMs: 14_000 },
      ],
    };
    // identity budget exhausted by the two run rows → both queued rows hidden, counted as +2 more
    const tight = buildFleetWidgetLines(model, { maxRows: 2, workflows: [wf] })!;
    expect(tight[0]).toBe("● 2 active Agents · +2 more");
    expect(tight.some((l) => l.includes("waiting for slot"))).toBe(false);
    // one line of identity budget left → first queued row shows, second joins +1 more
    const one = buildFleetWidgetLines(model, { maxRows: 3, workflows: [wf] })!;
    expect(one.filter((l) => l.includes("waiting for slot"))).toHaveLength(1);
    expect(one[0]).toBe("● 2 active Agents · +1 more");
    expect(one.find((l) => l.includes("waiting for slot"))).toBe("    ⧗ queued-a waiting for slot · 15s");
  });

  it("workflowGroupInput maps queuedChildren (label ?? agentType ?? callId, waitedMs = now − queuedAt) and the error totals", () => {
    const snap: import("../../src/workflow/activity.js").WorkflowActivitySnapshot = {
      workflowId: "wf-1",
      name: "multi-review",
      startedAt: 0,
      deadlineAt: 600_000,
      activeChildren: [],
      settledChildren: [],
      settledTotal: 0,
      completedTotal: 0,
      replayTotal: 0,
      queuedChildren: [
        { callId: "c1", label: "review-race", queuedAt: 3_000 },
        { callId: "c2", agentType: "Explore", queuedAt: 4_000 },
        { callId: "c3", queuedAt: 4_500 },
      ],
      rejectedTotal: 1,
      stageErrorTotal: 2,
      phases: [],
    };
    const input = workflowGroupInput(snap, 18_000, 5_000);
    expect(input.queued).toEqual([
      { label: "review-race", waitedMs: 15_000 },
      { label: "Explore", waitedMs: 14_000 },
      { label: "c3", waitedMs: 13_500 },
    ]);
    expect(input.rejectedTotal).toBe(1);
    expect(input.stageErrorTotal).toBe(2);
    // frozen snapshot: the wait clock freezes at endedAt (the engine settles every
    // queued call before unregistering — this pins the defensive behavior)
    const frozen = workflowGroupInput({ ...snap, terminal: { status: "completed", endedAt: 20_000 } }, 30_000, 5_000);
    expect(frozen.queued![0]).toEqual({ label: "review-race", waitedMs: 17_000 });
  });

  it("headers and queued rows render collision-free (⧗ has no emoji variant; ⚠ is followed by a space)", () => {
    const model = buildFleetViewModel([wfChild("child-a00", "active-a")], OPTS);
    const lines = buildFleetWidgetLines(model, {
      workflows: [
        {
          workflowId: "wf-1",
          name: "multi-review",
          elapsedMs: 18_000,
          budgetMs: 600_000,
          doneTotal: 2,
          failedTotal: 0,
          activeTotal: 1,
          queued: [{ label: "queued-a", waitedMs: 15_000 }],
          rejectedTotal: 1,
          stageErrorTotal: 1,
        },
      ],
    })!;
    expect(lines[1]).toBe("⚙ multi-review · 18s / 10m00s · ✓2 ▸1 ⧗ 1 ⚠ 2");
    for (const line of lines) expect(findGlyphCollisions(line)).toEqual([]);
  });
});

describe("M12: wide-risk glyph collisions (emoji terminals render ⚙⚠↩♻⏸⏹🗜 two-wide)", () => {
  const chip = wfChip;
  it("findGlyphCollisions flags a risk glyph glued to a non-space (VS16-aware); space or EOL is safe", () => {
    expect(findGlyphCollisions("⚠2 active")).toEqual(["⚠2"]);
    expect(findGlyphCollisions("✓ gather ↩3")).toEqual(["↩3"]);
    expect(findGlyphCollisions("⏸排队")).toEqual(["⏸排"]);
    expect(findGlyphCollisions("⏸\uFE0F排队")).toEqual(["⏸\uFE0F排"]);
    // safe forms: trailing space, end of line, non-risk glyphs
    expect(findGlyphCollisions("✓ gather ↩ 3")).toEqual([]);
    expect(findGlyphCollisions("⚙ name · 5s")).toEqual([]);
    expect(findGlyphCollisions(" ↩")).toEqual([]);
    expect(findGlyphCollisions("✓1 ✗2 ▸3 ⧗4 →5 ⎇6")).toEqual([]);
  });

  it("workflow surfaces (header / chain / recent-settled / frozen header) render collision-free", () => {
    const model = buildFleetViewModel([], OPTS);
    const live = buildFleetWidgetLines(model, {
      width: 100,
      frame: 2,
      workflows: [
        {
          workflowId: "wf-1",
          name: "draft-check-loop",
          elapsedMs: 25_000,
          budgetMs: 600_000,
          doneTotal: 3,
          failedTotal: 0,
          activeTotal: 1,
          collapsedVisits: 2,
          phases: [
            chip("draft", "done", 1, 1),
            chip("check", "done", 1, 1),
            chip("draft#2", "done", 1, 1),
            chip("gather", "done", 0, 0, 0, 3),
            chip("check#2", "active", 1, 0, 0, 1),
            chip("accept", "pending"),
          ],
          recentSettled: [
            { label: "fetch-logs", ok: true, durationMs: 0, source: "replay" },
            { label: "loop-draft-2", ok: false, durationMs: 7_000, source: "live" },
          ],
        },
        {
          workflowId: "wf-2",
          name: "long-crawl",
          elapsedMs: 30_000,
          budgetMs: 30_000,
          doneTotal: 0,
          failedTotal: 1,
          activeTotal: 0,
          phases: [chip("crawl", "done", 1, 1, 1), chip("digest", "pending")],
          terminal: { status: "timed_out" },
        },
      ],
    })!;
    expect(live.some((line) => line.includes("↩ fetch-logs replay"))).toBe(true);
    expect(live.some((line) => line.includes("· timed out"))).toBe(true);
    for (const line of live) expect(findGlyphCollisions(line)).toEqual([]);
  });

  it("run rows in queue_wait / retry_backoff / compaction / abort_grace render collision-free", () => {
    const phases = ["queue_wait", "retry_backoff", "compaction", "abort_grace", "reap"] as const;
    const runs = phases.map((phase, i) =>
      snapshot({
        runId: `run-${i}00`,
        phase,
        diag: diag({
          createdAt: 9_000,
          phaseEnteredAt: 9_000,
          lastEventAt: 9_900,
          phase,
          label: `task-${phase}`,
          ...(phase === "retry_backoff"
            ? { retry: { attempt: 2, maxAttempts: 3, delayMs: 100, startedAt: 9_000 } }
            : {}),
        }),
      }),
    );
    const lines = buildFleetWidgetLines(buildFleetViewModel(runs, OPTS), { width: 120, frame: 0 })!;
    // sanity: each phase label actually made it onto a row (compacted or not)
    for (const marker of ["⏸", "♻", "🗜", "⏹"]) {
      expect(lines.some((line) => line.includes(marker))).toBe(true);
    }
    for (const line of lines) expect(findGlyphCollisions(line)).toEqual([]);
  });
});

describe("workflow-agent-queue §5 (stage B): workflow header deadline marker", () => {
  const plain = (_t: string, s: string) => s;
  const base = {
    workflowId: "wf-1",
    name: "multi-review",
    elapsedMs: 3_602_000,
    budgetMs: 3_600_000,
    doneTotal: 2,
    failedTotal: 0,
    activeTotal: 1,
  };

  it("inside the grace window: `⏳grace 58s` (same format as the run row), right after the time segment", () => {
    const line = workflowHeaderLine(
      { ...base, deadline: { remainingMs: 58_000, extensions: 0, inGrace: true } },
      plain,
    );
    expect(line).toBe("⚙ multi-review · 1h00m / 1h00m · ⏳grace 58s · ✓2 ▸1");
    expect(findGlyphCollisions(line)).toEqual([]);
  });

  it("extended: `⏳12m+1`; grace after an extension keeps the grace form", () => {
    expect(
      workflowHeaderLine(
        { ...base, budgetMs: 4_320_000, deadline: { remainingMs: 720_000, extensions: 1, inGrace: false } },
        plain,
      ),
    ).toBe("⚙ multi-review · 1h00m / 1h12m · ⏳12m00s+1 · ✓2 ▸1");
    expect(
      workflowHeaderLine({ ...base, deadline: { remainingMs: 5_000, extensions: 2, inGrace: true } }, plain),
    ).toContain("· ⏳grace 5s ·");
  });

  it("no marker without grace/extension, and never on a frozen terminal header", () => {
    expect(workflowHeaderLine(base, plain)).toBe("⚙ multi-review · 1h00m / 1h00m · ✓2 ▸1");
    expect(
      workflowHeaderLine(
        { ...base, terminal: { status: "timed_out" }, deadline: { remainingMs: 1, extensions: 1, inGrace: true } },
        plain,
      ),
    ).not.toContain("⏳");
  });

  it("workflowGroupInput maps graceUntil / extensions from the activity snapshot (grace wins over the soft deadline)", () => {
    const snap: import("../../src/workflow/activity.js").WorkflowActivitySnapshot = {
      workflowId: "wf-1",
      name: "pipe",
      startedAt: 0,
      deadlineAt: 60_000,
      activeChildren: [],
      settledChildren: [],
      settledTotal: 0,
      completedTotal: 0,
      replayTotal: 0,
      queuedChildren: [],
      rejectedTotal: 0,
      stageErrorTotal: 0,
      phases: [],
    };
    expect(workflowGroupInput(snap, 30_000, 5_000).deadline).toBeUndefined();
    expect(workflowGroupInput({ ...snap, graceUntil: 70_000 }, 62_000, 5_000).deadline).toEqual({
      remainingMs: 8_000,
      extensions: 0,
      inGrace: true,
    });
    expect(workflowGroupInput({ ...snap, deadlineAt: 90_000, extensions: 1 }, 62_000, 5_000).deadline).toEqual({
      remainingMs: 28_000,
      extensions: 1,
      inGrace: false,
    });
    const frozen = { ...snap, graceUntil: 70_000, terminal: { status: "timed_out" as const, endedAt: 70_000 } };
    expect(workflowGroupInput(frozen, 71_000, 5_000).deadline).toBeUndefined();
  });

  it("end to end (registry → widget): the grace marker is on the header even when the row budget is exhausted", async () => {
    const { createWorkflowActivityRegistry } = await import("../../src/workflow/activity.js");
    const reg = createWorkflowActivityRegistry({ now: () => 62_000 });
    reg.register("wf-1", "multi-review", 0, 60_000, ["review"]);
    reg.onEvent("subagent:workflow:deadline", {
      workflowId: "wf-1",
      at: 60_000,
      kind: "grace",
      deadlineAt: 60_000,
      graceUntil: 150_000,
      hardDeadlineAt: 240_000,
      extensionsUsed: 0,
      maxExtensions: 3,
    });
    const runs = [1, 2, 3].map((i) =>
      snapshot({ runId: `run-${i}00`, parentRunId: "wf-1", diag: diag({ createdAt: 8_000, label: `child-${i}` }) }),
    );
    const lines = buildFleetWidgetLines(buildFleetViewModel(runs, { ...OPTS, now: 62_000 }), {
      width: 120,
      frame: 0,
      maxRows: 1,
      workflows: reg.listForDisplay().map((w) => workflowGroupInput(w, 62_000, 5_000)),
    })!;
    const header = lines.find((line) => line.includes("multi-review"))!;
    expect(header).toContain("⏳grace 1m28s");
    for (const line of lines) expect(findGlyphCollisions(line)).toEqual([]);
  });
});
