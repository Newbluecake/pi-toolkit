import { describe, expect, it } from "vitest";
import type { ConsultCacheDiagnostics, RunDiagnostics, RunSnapshot } from "../../src/core/types.js";
import { buildFleetViewModel } from "../../src/ui/fleet-panel.js";
import { buildFleetWidgetLines } from "../../src/ui/fleet-widget.js";

/**
 * cache-thread plan §5.3 / §11 (U): the TUI agent-tree consult row — the
 * compact warm/cold marker from `diag.consultCache`/`diag.consultThread`
 * rides the widget's main row (and the terminal linger line), and runs
 * without the fields render byte-identically (no field, no stray space).
 */

function diag(overrides: Partial<RunDiagnostics> = {}): RunDiagnostics {
  return {
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
}

function snapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    runId: "r_CONSULT1",
    generation: 1,
    status: "running",
    phase: "model_turn",
    deadlines: { enqueuedAt: 0, deadlineAt: undefined, queueDeadlineAt: undefined },
    diag: diag(),
    updatedAt: 0,
    ...overrides,
  };
}

const cache = (
  predicted: ConsultCacheDiagnostics["predicted"]["state"],
  first?: ConsultCacheDiagnostics["first"],
): ConsultCacheDiagnostics => ({ v: 1, predicted: { state: predicted }, ...(first ? { first } : {}) });

const NOW = 10_000;

describe("fleet view-model: consult cache mark projection", () => {
  it("toRow carries the marker for a consult run with cache facts", () => {
    const vm = buildFleetViewModel(
      [
        snapshot({
          diag: diag({
            consultCache: cache("warm", { v: 1, readShare: 0.962, label: "hit", anchor: "added", at: 9000 }),
            consultThread: { threadId: "c7k9q2mx", seq: 2 },
          }),
        }),
      ],
      { now: NOW },
    );
    expect(vm.rows[0]!.consultCacheMark).toBe("t#2 warm·hit 96%");
  });

  it("rows without the diag fields carry no marker at all (byte-identical absence)", () => {
    const vm = buildFleetViewModel([snapshot()], { now: NOW });
    expect(vm.rows[0]!.consultCacheMark).toBeUndefined();
  });
});

describe("fleet widget: consult row rendering", () => {
  const row = (consultCache?: ConsultCacheDiagnostics, seq?: number) =>
    snapshot({
      diag: diag({
        ...(consultCache ? { consultCache } : {}),
        ...(seq !== undefined ? { consultThread: { threadId: "c7k9q2mx", seq } } : {}),
      }),
    });

  it.each([
    [
      "warm·hit measured on a thread",
      cache("warm", { v: 1, readShare: 0.962, label: "hit", anchor: "added", at: 9000 }),
      2,
      "t#2 warm·hit 96%",
    ],
    ["prediction before first response", cache("cold"), undefined, "cold·…"],
    [
      "degraded partial",
      cache("unknown", { v: 1, readShare: 0.41, label: "partial", anchor: "skipped:limit", degraded: true, at: 9000 }),
      3,
      "t#3 ?·partial 41%·degraded",
    ],
  ] as const)("main row shows %s", (_name, consultCache, seq, mark) => {
    const vm = buildFleetViewModel([row(consultCache as never, seq)], { now: NOW });
    const lines = buildFleetWidgetLines(vm, { width: 120 });
    expect(lines).toBeDefined();
    expect(lines!.some((line) => line.includes(mark as string))).toBe(true);
  });

  it("the terminal linger line keeps the measured marker", () => {
    const snap = snapshot({
      status: "completed",
      phase: "settled",
      diag: diag({
        label: "consult expert",
        consultCache: cache("warm", { v: 1, readShare: 0.962, label: "hit", anchor: "added", at: 9000 }),
        consultThread: { threadId: "c7k9q2mx", seq: 2 },
      }),
    });
    const vm = buildFleetViewModel([snap], { now: NOW });
    const lines = buildFleetWidgetLines(vm, { width: 120, terminalLingerMs: 60_000 });
    expect(lines).toBeDefined();
    // terminal rows render through widgetTerminalDetail — the mark must survive settle
    expect(lines!.join("\n")).toContain("t#2 warm·hit 96%");
  });

  it("a consult row without cache facts renders the exact pre-feature line", () => {
    const plain = buildFleetViewModel([snapshot({ diag: diag({ label: "consult expert" }) })], { now: NOW });
    const withFields = buildFleetViewModel(
      [snapshot({ diag: diag({ label: "consult expert", consultOf: { askerRunId: "r_ASKER001" } }) })],
      { now: NOW },
    );
    const baseline = buildFleetWidgetLines(plain, { width: 120 });
    const probe = buildFleetWidgetLines(withFields, { width: 120 });
    expect(probe).toEqual(baseline);
    expect(baseline!.join("\n")).not.toContain("·hit");
    expect(baseline!.join("\n")).not.toContain("·…");
  });

  it("drops the marker before identity fields when the row gets tight", () => {
    const vm = buildFleetViewModel(
      [
        snapshot({
          diag: diag({
            label: "a-very-long-consult-label-that-consumes-width",
            model: { provider: "cr-anthropic", id: "claude-opus-5-5" },
            consultCache: cache("warm", { v: 1, readShare: 0.962, label: "hit", anchor: "added", at: 9000 }),
          }),
        }),
      ],
      { now: NOW },
    );
    const lines = buildFleetWidgetLines(vm, { width: 46 });
    expect(lines).toBeDefined();
    expect(lines!.join("\n")).not.toContain("warm·hit");
  });

  it("running row: the marker is dropped before the agent type", () => {
    const mk = (withCache: boolean) =>
      buildFleetViewModel(
        [
          snapshot({
            diag: diag({
              label: "consult expert",
              ...(withCache
                ? { consultCache: cache("warm", { v: 1, readShare: 0.962, label: "hit", anchor: "added", at: 9000 }) }
                : {}),
            }),
          }),
        ],
        { now: NOW },
      );
    const wide = buildFleetWidgetLines(mk(true), { width: 200 })!.join("\n");
    expect(wide).toContain("warm·hit 96%");
    // Find the narrowest width where the cache-less row still shows everything:
    // at that width the cached row must have dropped ONLY the marker.
    let w = 200;
    const full = (width: number) => buildFleetWidgetLines(mk(false), { width })!.join("\n");
    while (w > 20 && full(w - 1) === full(200)) w--;
    expect(buildFleetWidgetLines(mk(true), { width: w })!.join("\n")).toBe(full(w));
  });

  it("terminal line: the marker yields before the label is truncated", () => {
    const label = "consult-expert-with-a-long-label";
    const snap = snapshot({
      status: "completed",
      phase: "settled",
      diag: diag({
        label,
        consultCache: cache("warm", { v: 1, readShare: 0.962, label: "hit", anchor: "added", at: 9000 }),
      }),
    });
    const vm = buildFleetViewModel([snap], { now: NOW });
    const text = buildFleetWidgetLines(vm, { width: 60, terminalLingerMs: 60_000 })!.join("\n");
    expect(text).toContain(label);
    expect(text).not.toContain("warm·hit");
  });
});
