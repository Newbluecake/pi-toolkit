import { describe, expect, it } from "vitest";
import { MemoryRunStore } from "../../src/core/store.js";
import { RUN_CUSTOM_TYPE, seedRunStoreFromEntries, wrapWithRunLog } from "../../src/adapters/pi-run-log.js";
import type { RunSnapshot } from "../../src/core/types.js";

function snapshot(textFinal?: true): RunSnapshot {
  const diag = {
    createdAt: 0,
    phase: "settled" as const,
    phaseEnteredAt: 1,
    pendingTools: 0,
    turns: 1,
    escalation: [],
    orphaned: false,
    generation: 1,
    degraded: [],
    staleInputs: 0,
    unkillable: [],
    text: "final answer",
    ...(textFinal ? { textFinal } : {}),
  };
  return {
    runId: "r1",
    generation: 1,
    status: "completed",
    phase: "settled",
    deadlines: { enqueuedAt: 0, deadlineAt: undefined, queueDeadlineAt: undefined },
    diag,
    outcome: { runId: "r1", status: "completed", text: "final answer", turns: 1, durationMs: 1, diag },
    updatedAt: 1,
  };
}

describe("pi run log diagnostics persistence", () => {
  it("retains textFinal through the append-entry JSON round trip", () => {
    const entries: Array<{ type: string; customType?: string; data?: unknown }> = [];
    const store = wrapWithRunLog(new MemoryRunStore(), {
      appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
      sessionManager: { getEntries: () => entries },
    });
    store.put(snapshot(true));
    const persisted = JSON.parse(JSON.stringify(entries[0]!.data)) as RunSnapshot;
    expect(persisted.diag.text).toBe("final answer");
    expect(persisted.diag.textFinal).toBe(true);
    expect(entries[0]!.customType).toBe(RUN_CUSTOM_TYPE);

    const old = JSON.parse(JSON.stringify(snapshot().diag)) as { textFinal?: true };
    expect(old.textFinal).toBeUndefined();
  });
});

// G5a 补全（2026-10-04 事故）：stack 重建时把会话文件里的终态快照种回内存
// store，否则重启后 resolveResumeTarget 四源全空、终态 run 无法 resume。
describe("seedRunStoreFromEntries (restart resume seeding)", () => {
  function snap(runId: string, over: { status?: RunSnapshot["status"]; updatedAt?: number; file?: string } = {}) {
    const base = snapshot();
    const file = over.file ?? `/tmp/sess-${runId}.jsonl`;
    return {
      ...base,
      runId,
      status: over.status ?? base.status,
      updatedAt: over.updatedAt ?? 1,
      diag: { ...base.diag, sessionFile: file },
      outcome: { ...base.outcome!, runId },
    } as RunSnapshot;
  }
  const entry = (s: RunSnapshot) => ({ type: "custom", customType: RUN_CUSTOM_TYPE, data: s });
  const allExist = () => true;

  it("seeds terminal snapshots with existing session files; skips running and dead files", () => {
    const store = new MemoryRunStore();
    const seeded = seedRunStoreFromEntries(
      store,
      [
        entry(snap("r_done")),
        entry(snap("r_failed", { status: "failed" })),
        entry(snap("r_running", { status: "running" as RunSnapshot["status"] })),
        { type: "custom", customType: "subagent:notification", data: {} },
        { type: "message" },
      ],
      allExist,
    );
    expect(seeded).toBe(2);
    expect(store.get("r_done")?.status).toBe("completed");
    expect(store.get("r_failed")?.status).toBe("failed");
    expect(store.get("r_running")).toBeUndefined();
  });

  it("keeps only the latest snapshot per runId (updatedAt, then generation)", () => {
    const store = new MemoryRunStore();
    const older = snap("r1", { updatedAt: 100 });
    const newer = { ...snap("r1", { updatedAt: 200 }), generation: 2 } as RunSnapshot;
    seedRunStoreFromEntries(store, [entry(older), entry(newer)], allExist);
    expect(store.get("r1")?.updatedAt).toBe(200);
    expect(store.list()).toHaveLength(1);
  });

  it("skips snapshots whose session file no longer exists", () => {
    const store = new MemoryRunStore();
    const seeded = seedRunStoreFromEntries(store, [entry(snap("r_gone", { file: "/tmp/nope.jsonl" }))], () => false);
    expect(seeded).toBe(0);
    expect(store.get("r_gone")).toBeUndefined();
  });

  it("seeds the BASE store — never re-appends entries through the write-through wrapper", () => {
    const appended: unknown[] = [];
    const store = wrapWithRunLog(new MemoryRunStore(), {
      appendEntry: (_t, d) => appended.push(d),
      sessionManager: { getEntries: () => [] },
    });
    // 模拟 stack.ts 的接线：seed 只接触 base（这里直接断言种子路径不产生新条目）。
    const base = new MemoryRunStore();
    seedRunStoreFromEntries(base, [entry(snap("r1"))], allExist);
    const wrapped = wrapWithRunLog(base, {
      appendEntry: (_t, d) => appended.push(d),
      sessionManager: { getEntries: () => [] },
    });
    expect(appended).toHaveLength(0);
    expect(wrapped.get("r1")?.status).toBe("completed");
    expect(store.get("r1")).toBeUndefined();
  });
});
