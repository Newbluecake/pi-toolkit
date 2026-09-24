// dynamic-threshold-plan.md §12 D2 — telemetry 纯逻辑层：
// T-D2-TRIGGER（P0-3 + R2-1/R2-4：fromHook 位置、onApplied 因果、六格判定表）、
// T-D2-WINDOW（观察窗 6 轮 / 600s 先到者关闭、shutdown 补写、打断即 flush）、
// T-D2-NO-PATHS（D5 + R2-8：递归断言无路径类键名 / 无字符串数组 / 哨兵不泄漏）、
// T-D2-NULL-NOT-ZERO（缺失量序列化为 null，不是 0）。

import { describe, expect, it } from "vitest";
import {
  MARKER_TTL_MS,
  WINDOW_MAX_WALL_MS,
  WINDOW_MIN_TURNS,
  buildSwitchTelemetryRecord,
  classifyTrigger,
  createSwitchTelemetryTracker,
  type CompactReason,
  type SessionCompactEventView,
  type SwitchTelemetryRecord,
  type SwitchTelemetryTracker,
  type TelemetrySnapshot,
} from "../../../src/compact-hint/dynamic/telemetry.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function snapshot(overrides: Partial<TelemetrySnapshot> = {}): TelemetrySnapshot {
  return {
    model: { provider: "anthropic", id: "claude-opus-4-5", contextWindow: 1_000_000 },
    lines: { mode: "on", hintPercent: 41, forcePercent: 88, basis: "cost", dynamicUsable: true, degradeReason: null },
    estimate: { g: 779, sigma: 512, s0: 98_000, cStar: 161_000, rUsd: 10, handoffTokens: 4_500 },
    price: { cacheRead: 0.2, cacheWrite: 5, output: 20, tierHit: 272_000, writePricingApproximate: true },
    cachedContextTokens: 410_000,
    ...overrides,
  };
}

const NULL_SNAPSHOT: TelemetrySnapshot = {
  model: { provider: null, id: null, contextWindow: null },
  lines: {
    mode: "shadow",
    hintPercent: null,
    forcePercent: null,
    basis: null,
    dynamicUsable: false,
    degradeReason: null,
  },
  estimate: { g: null, sigma: null, s0: null, cStar: null, rUsd: 10, handoffTokens: null },
  price: { cacheRead: null, cacheWrite: null, output: null, tierHit: null, writePricingApproximate: true },
  cachedContextTokens: null,
};

function compactEvent(
  overrides: {
    reason?: CompactReason | null;
    fromHook?: boolean;
    tokensBefore?: number;
    compactionCost?: number | null;
    dropEntry?: boolean;
  } = {},
): SessionCompactEventView {
  if (overrides.dropEntry === true) return { reason: overrides.reason ?? null };
  return {
    reason: overrides.reason ?? "manual",
    compactionEntry: {
      fromHook: overrides.fromHook ?? false,
      tokensBefore: overrides.tokensBefore ?? 420_000,
      usage: { cost: { total: overrides.compactionCost ?? 0.02 } },
    },
  };
}

function assistantEntry(id: string, model = "claude-opus-4-5"): unknown {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "t",
    message: {
      role: "assistant",
      model,
      usage: { input: 1000, output: 200, cacheRead: 5000, cacheWrite: 800, cost: { total: 0.01 } },
    },
  };
}

function harness(sessionId = "sess-1") {
  let clock = 1_000;
  const branch: unknown[] = [];
  const ctx = { sessionManager: { getBranch: () => branch } };
  const tracker = createSwitchTelemetryTracker({ now: () => clock, sessionId });
  const switchAt = (event: SessionCompactEventView = compactEvent(), snap: TelemetrySnapshot = snapshot()) => {
    branch.push({ type: "compaction", id: `c${branch.length}`, parentId: null, timestamp: "t" });
    return tracker.onSessionCompact(event, ctx, snap);
  };
  const turn = () => {
    clock += 1_000; // 每轮推进 1s，保证 ts/wallMs 单调
    branch.push(assistantEntry(`a${branch.length}`));
    return tracker.onTurnEnd(ctx, snapshot());
  };
  return { tracker, branch, clockRef: { get: () => clock, set: (v: number) => (clock = v) }, switchAt, turn };
}

// ---------------------------------------------------------------------------
// T-D2-TRIGGER
// ---------------------------------------------------------------------------

describe("T-D2-TRIGGER: classifyTrigger table (six cells, order = semantics)", () => {
  it("cell 1: handoffApplied wins regardless of reason or force marker", () => {
    for (const reason of ["manual", "threshold", "overflow", null, undefined] as const) {
      expect(classifyTrigger({ handoffApplied: true, forceKind: "force", reason })).toBe("switch-tool");
    }
  });
  it("cell 2: live force marker beats reason (including overflow)", () => {
    expect(classifyTrigger({ handoffApplied: false, forceKind: "force", reason: "threshold" })).toBe("dynamic-force");
    expect(classifyTrigger({ handoffApplied: false, forceKind: "force", reason: "overflow" })).toBe("dynamic-force");
  });
  it("cell 3: reason overflow without markers", () => {
    expect(classifyTrigger({ handoffApplied: false, forceKind: null, reason: "overflow" })).toBe("overflow");
  });
  it("cells 4/5: threshold/manual with no marker ⇒ pi-auto/manual; demand marker contradicts ⇒ unknown", () => {
    expect(classifyTrigger({ handoffApplied: false, forceKind: null, reason: "threshold" })).toBe("pi-auto");
    expect(classifyTrigger({ handoffApplied: false, forceKind: null, reason: "manual" })).toBe("manual");
    expect(classifyTrigger({ handoffApplied: false, forceKind: "demand", reason: "threshold" })).toBe("unknown");
    expect(classifyTrigger({ handoffApplied: false, forceKind: "demand", reason: "manual" })).toBe("unknown");
  });
  it("cell 6: missing reason ⇒ unknown", () => {
    expect(classifyTrigger({ handoffApplied: false, forceKind: null, reason: null })).toBe("unknown");
    expect(classifyTrigger({ handoffApplied: false, forceKind: null, reason: undefined })).toBe("unknown");
  });
});

describe("T-D2-TRIGGER: tracker wiring (fromHook position, onApplied causality, marker lifecycle)", () => {
  it("reads adopted from compactionEntry.fromHook — a root-level fromHook is ignored; missing entry ⇒ null", () => {
    const a = harness();
    const withRootJunk = {
      fromHook: true, // 错误位置：事件根上（P0-3 核对点）
      reason: "manual",
      compactionEntry: { fromHook: false, tokensBefore: 1 },
    } as unknown as SessionCompactEventView;
    const [rootJunkRow] = a.switchAt(withRootJunk);
    expect(rootJunkRow.adopted).toBe(false);
    const b = harness();
    expect(b.switchAt(compactEvent({ fromHook: true }))[0].adopted).toBe(true);
    const c = harness();
    expect(c.switchAt(compactEvent({ dropEntry: true }))[0].adopted).toBeNull();
  });

  it("handoffApplied only from onApplied firing (never a time window); seq comes from onApplied", () => {
    const a = harness();
    const noApplied = a.switchAt(compactEvent({ reason: "manual" }));
    expect(noApplied[0].handoffApplied).toBe(false); // tool_call 早退/失败路径根本到不了这里
    expect(noApplied[0].trigger).toBe("manual");
    expect(noApplied[0].trigger).not.toBe("switch-tool");

    const b = harness();
    b.tracker.noteHandoffApplied({ seq: 7 });
    const [applied] = b.switchAt(compactEvent({ reason: "manual" }));
    expect(applied.handoffApplied).toBe(true);
    expect(applied.trigger).toBe("switch-tool");
    expect(applied.seq).toBe(7);
    expect(applied.precededByDemand).toBe(false);
    // 消费后 marker 立即清（§5.4 清除①）。
    expect(b.tracker.markerState().handoff).toBeUndefined();
  });

  it("force marker: dynamic-force trigger, consumed on session_compact; demand is a boolean, not a trigger", () => {
    const a = harness();
    a.tracker.noteForce("force");
    const [record] = a.switchAt(compactEvent({ reason: "threshold" }));
    expect(record.trigger).toBe("dynamic-force");
    expect(a.tracker.markerState().force).toBeUndefined();

    const b = harness();
    b.tracker.noteForce("demand");
    const [demandRecord] = b.switchAt(compactEvent({ reason: "manual" }));
    expect(demandRecord.precededByDemand).toBe(true);
    expect(demandRecord.trigger).toBe("unknown"); // marker 与 reason 矛盾（R2-4）
  });

  it("marker TTL is a fallback cap only: alive at exactly MARKER_TTL_MS, dead one tick later", () => {
    const h = harness();
    h.tracker.noteHandoffApplied({ seq: 3 });
    h.tracker.noteForce("force");
    h.clockRef.set(1_000 + MARKER_TTL_MS); // 恰好 TTL：仍存活
    expect(h.tracker.markerState().handoff).toBeDefined();
    expect(h.tracker.markerState().force).toBeDefined();
    h.clockRef.set(1_000 + MARKER_TTL_MS + 1); // 超时作废
    expect(h.tracker.markerState().handoff).toBeUndefined();
    expect(h.tracker.markerState().force).toBeUndefined();
    const [expired] = h.switchAt(compactEvent({ reason: "manual" }));
    expect(expired.handoffApplied).toBe(false);
    expect(expired.trigger).toBe("manual");
  });

  it("clearMarkers (session_compact_failed) and clearForceMarker (compact onError) empty the markers", () => {
    const h = harness();
    h.tracker.noteHandoffApplied({ seq: 1 });
    h.tracker.noteForce("force");
    h.tracker.clearForceMarker();
    expect(h.tracker.markerState().force).toBeUndefined();
    expect(h.tracker.markerState().handoff).toBeDefined();
    h.tracker.clearMarkers("compact-failed");
    expect(h.tracker.markerState().handoff).toBeUndefined();
    const [record] = h.switchAt(compactEvent({ reason: "manual" }));
    expect(record.trigger).toBe("manual");
  });

  it("before.contextTokens prefers tokensBefore, falls back to cached snapshot, else null; percent derived", () => {
    const a = harness();
    const [r1] = a.switchAt(compactEvent({ tokensBefore: 420_000 }));
    expect(r1.before.contextTokens).toBe(420_000);
    expect(r1.before.percent).toBe(42);
    const b = harness();
    const [r2] = b.switchAt({ reason: "manual" }, snapshot({ cachedContextTokens: 250_000 }));
    expect(r2.before.contextTokens).toBe(250_000);
    expect(r2.before.percent).toBe(25);
    const c = harness();
    const [r3] = c.switchAt(compactEvent({ dropEntry: true }), snapshot({ cachedContextTokens: null }));
    expect(r3.before.contextTokens).toBeNull();
    expect(r3.before.percent).toBeNull();
  });

  it("compactionCostUsd comes from compactionEntry.usage.cost.total (R2-6), null when absent", () => {
    const a = harness();
    expect(a.switchAt(compactEvent({ compactionCost: 0.013 }))[0].compactionCostUsd).toBeCloseTo(0.013, 12);
    const b = harness();
    expect(b.switchAt(compactEvent({ dropEntry: true }))[0].compactionCostUsd).toBeNull();
  });

  it("turnsSinceLastSwitch counts turn_ends since the previous switch and resets on switch", () => {
    const h = harness();
    h.turn();
    h.turn();
    const switchRow = (rows: SwitchTelemetryRecord[]): SwitchTelemetryRecord => rows[rows.length - 1]; // 窗口被时会先 flush 旧行，switch 行恒在末位
    expect(switchRow(h.switchAt(compactEvent())).before.turnsSinceLastSwitch).toBe(2);
    h.turn();
    expect(switchRow(h.switchAt(compactEvent())).before.turnsSinceLastSwitch).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// T-D2-WINDOW
// ---------------------------------------------------------------------------

describe("T-D2-WINDOW: observation window state machine", () => {
  it("closes at WINDOW_MIN_TURNS counted assistant usages, exactly once, never a third row", () => {
    const h = harness();
    const [switchRow] = h.switchAt(compactEvent({ reason: "manual" }));
    expect(h.tracker.windowState()).toMatchObject({ open: true, afterEntryId: "c0", seq: switchRow.seq });
    for (let i = 0; i < WINDOW_MIN_TURNS - 1; i += 1) {
      expect(h.turn()).toEqual([]); // 未到 6 轮：不关
    }
    const closed = h.turn(); // 第 6 轮
    expect(closed).toHaveLength(1);
    const [windowRow] = closed;
    expect(windowRow.phase).toBe("window");
    expect(windowRow.seq).toBe(switchRow.seq); // 同一次切换的两行共用 seq
    expect(windowRow.ts).toBeGreaterThan(switchRow.ts);
    expect(windowRow.rProxy?.turns).toBe(WINDOW_MIN_TURNS);
    expect(windowRow.rProxy?.costUnknownReason).toBeNull();
    expect(windowRow.rProxy?.firstContextTokens).toBe(1000 + 5000 + 800); // 喂 estimator 的 S0 代理值
    expect(h.tracker.windowState().open).toBe(false);
    expect(h.turn()).toEqual([]); // 关闭后不再产生第三条
  });

  it("closes on wallMs first when the clock outruns the turns (先到为准)", () => {
    const h = harness();
    h.switchAt(compactEvent({ reason: "manual" }));
    h.turn();
    h.turn(); // 仅 2 轮（≈2s），远未到 6 轮
    h.clockRef.set(1_000 + WINDOW_MAX_WALL_MS + 1); // 但墙钟已过 600s（长工具/用户闲置）
    const closed = h.turn();
    expect(closed).toHaveLength(1);
    expect(closed[0].rProxy?.wallMs).toBeGreaterThanOrEqual(WINDOW_MAX_WALL_MS);
    expect(closed[0].rProxy?.turns).toBe(3); // turns < 6 仍关闭：wallMs 先到
  });

  it("session_shutdown flushes an open window with its actual values, once", () => {
    const h = harness();
    h.switchAt(compactEvent({ reason: "manual" }));
    h.turn();
    h.turn();
    const flushed = h.tracker.flushWindow({ sessionManager: { getBranch: () => h.branch } }, snapshot());
    expect(flushed).toHaveLength(1);
    expect(flushed[0].phase).toBe("window");
    expect(flushed[0].rProxy?.turns).toBe(2); // 按实际值 flush，不丢样本
    expect(h.tracker.flushWindow({ sessionManager: { getBranch: () => h.branch } }, snapshot())).toEqual([]);
    expect(h.tracker.windowState().open).toBe(false);
  });

  it("a second switch while a window is open flushes the interrupted window first, then opens the new one", () => {
    const h = harness();
    const [first] = h.switchAt(compactEvent({ reason: "manual" }));
    h.turn();
    h.turn();
    const rows = h.switchAt(compactEvent({ reason: "threshold" }));
    expect(rows).toHaveLength(2);
    expect(rows[0].phase).toBe("window");
    expect(rows[0].seq).toBe(first.seq);
    expect(rows[0].rProxy?.turns).toBe(2);
    expect(rows[1].phase).toBe("switch");
    expect(rows[1].seq).not.toBe(first.seq); // fallback seq 单调递增
    expect(h.tracker.windowState()).toMatchObject({ open: true, seq: rows[1].seq });
  });

  it("window with an unreadable branch degrades to watermark-lost nulls, never throws", () => {
    const tracker = createSwitchTelemetryTracker({ now: () => 5_000, sessionId: "s" });
    const rows = tracker.onSessionCompact(compactEvent({ reason: "manual" }), undefined, snapshot());
    expect(rows).toHaveLength(1);
    tracker.onTurnEnd(undefined, snapshot());
    tracker.onTurnEnd(undefined, snapshot());
    const flushed = tracker.flushWindow(undefined, snapshot());
    expect(flushed).toHaveLength(1);
    expect(flushed[0].rProxy).toMatchObject({
      turns: null, // watermark-lost ⇒ turns 不可知 ⇒ null（不是 0）
      costUsd: null,
      firstContextTokens: null,
      costUnknownReason: "watermark-lost",
      crossModel: false,
    });
  });
});

// ---------------------------------------------------------------------------
// T-D2-NO-PATHS + T-D2-NULL-NOT-ZERO
// ---------------------------------------------------------------------------

const PATHISH_KEY = /path|file|dir|cwd|hash/i;
const SENTINEL = "/tmp/sentinel-9f2";

function assertNoPathish(value: unknown): void {
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      expect(node.some((el) => typeof el === "string")).toBe(false); // ② 不存在任何字符串数组值
      node.forEach(visit);
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) {
        expect(PATHISH_KEY.test(key)).toBe(false); // ① 不存在 path/file/dir/cwd/hash 类键名（含前后缀）
        visit(child);
      }
      return;
    }
    if (typeof node === "string") {
      expect(node.includes(SENTINEL)).toBe(false); // ③ 哨兵路径不出现在任何字符串里
    }
  };
  visit(value);
}

describe("T-D2-NO-PATHS: the record schema cannot carry paths (D5 + R2-8, no `grep '/'`)", () => {
  it("switch row: path-ish junk in the event input never reaches the record; model.id keeps its legal slash", () => {
    const fatEvent = {
      fromHook: true,
      cwd: SENTINEL,
      reason: "manual",
      compactionEntry: {
        fromHook: true,
        tokensBefore: 420_000,
        summary: `handoff text referencing ${SENTINEL}/summary.md`,
        firstKeptEntryId: `${SENTINEL}/entry-9`,
        systemMessage: { content: SENTINEL },
        usage: { cost: { total: 0.02 } },
      },
    } as unknown as SessionCompactEventView;
    const record = buildSwitchTelemetryRecord({
      now: 1,
      sessionId: "sess",
      seq: 1,
      event: fatEvent,
      handoff: { seq: 9, at: 1 },
      force: undefined,
      turnsSinceLastSwitch: 3,
      snapshot: snapshot({
        model: { provider: "anthropic", id: "anthropic/claude-opus-4-5", contextWindow: 1_000_000 },
      }),
    });
    const roundTripped: unknown = JSON.parse(JSON.stringify(record));
    expect(JSON.stringify(roundTripped)).toContain("anthropic/claude-opus-4-5"); // model.id 合法含 "/"（R2-8）
    assertNoPathish(roundTripped);
  });

  it("window row passes the same walk", () => {
    const g = harness();
    g.switchAt(compactEvent({ reason: "manual" }));
    g.turn();
    g.turn();
    const [windowRow] = g.tracker.flushWindow({ sessionManager: { getBranch: () => g.branch } }, snapshot());
    assertNoPathish(JSON.parse(JSON.stringify(windowRow)));
  });
});

describe("T-D2-NULL-NOT-ZERO: every missing quantity serializes as null, never 0", () => {
  it("switch row with an all-null snapshot and no compaction entry", () => {
    const record = buildSwitchTelemetryRecord({
      now: 42,
      sessionId: "s",
      seq: 1,
      event: { reason: null },
      handoff: undefined,
      force: undefined,
      turnsSinceLastSwitch: 0,
      snapshot: NULL_SNAPSHOT,
    });
    const text = JSON.stringify(record);
    for (const fragment of [
      '"contextTokens":null',
      '"percent":null',
      '"hintPercent":null',
      '"forcePercent":null',
      '"basis":null',
      '"degradeReason":null',
      '"g":null',
      '"sigma":null',
      '"s0":null',
      '"cStar":null',
      '"handoffTokens":null',
      '"cacheRead":null',
      '"cacheWrite":null',
      '"output":null',
      '"tierHit":null',
      '"compactionCostUsd":null',
      '"adopted":null',
      '"reason":null',
    ]) {
      expect(text).toContain(fragment);
    }
    // 绝不用 0 冒充未知：这些字段不以 0 出现（rUsd 是配置值，允许数字）。
    for (const zero of ['"contextTokens":0', '"percent":0', '"hintPercent":0', '"compactionCostUsd":0']) {
      expect(text).not.toContain(zero);
    }
  });

  it("window row with watermark lost: rProxy numeric proxies are null, not 0", () => {
    const tracker = createSwitchTelemetryTracker({ now: () => 7_000, sessionId: "s" });
    tracker.onSessionCompact({ reason: "manual" }, undefined, NULL_SNAPSHOT);
    tracker.onTurnEnd(undefined, NULL_SNAPSHOT);
    const [windowRow] = tracker.flushWindow(undefined, NULL_SNAPSHOT);
    const text = JSON.stringify(windowRow);
    for (const fragment of [
      '"turns":null',
      '"firstContextTokens":null',
      '"firstUsage":null',
      '"costUsd":null',
      '"cacheRead":null',
      '"cacheWrite":null',
      '"costUnknownReason":"watermark-lost"',
    ]) {
      expect(text).toContain(fragment);
    }
  });
});
