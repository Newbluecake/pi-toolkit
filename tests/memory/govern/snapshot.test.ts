// #36 P4 (arch r5 §5.3) — govern/snapshot.ts: the deterministic
// state-snapshot detector (four pattern kinds, pure, pi-free).

import { describe, expect, test } from "vitest";
import { looksLikeStateSnapshot, stateSnapshotKinds } from "../../../src/memory/govern/snapshot.js";

describe("stateSnapshotKinds (§5.3 pattern table)", () => {
  test("run id: r_ followed by ≥6 alphanumerics", () => {
    expect(stateSnapshotKinds("run r_abc123 is still going")).toEqual(["run id"]);
    expect(stateSnapshotKinds("run r_abc12 is too short")).toEqual([]);
    expect(looksLikeStateSnapshot("dispatched job r_9f3e2a1b")).toBe(true);
  });

  test("commit/HEAD: HEAD/@ + hex, or bare hex beside a current-word", () => {
    expect(stateSnapshotKinds("currently at HEAD 6dcf292f on dev")).toEqual(["commit"]);
    expect(stateSnapshotKinds("rebased onto @4f8a1c9")).toEqual(["commit"]);
    expect(stateSnapshotKinds("当前提交 6dcf292fabc 已合入")).toEqual(["commit", "progress"]); // 当前 also reads as progress
    // bare hex WITHOUT a current-word in the same sentence: not a snapshot
    expect(stateSnapshotKinds("the hash 6dcf292fabc appears in the log")).toEqual([]);
  });

  test("quota reading: percentage within 30cp of quota vocabulary", () => {
    expect(stateSnapshotKinds("5h 用量 62%，还够")).toEqual(["quota reading"]);
    expect(stateSnapshotKinds("quota window: 47.5% left")).toEqual(["quota reading"]);
    expect(stateSnapshotKinds("week 7d budget at 90%")).toEqual(["quota reading"]);
    // percentage far from any quota word: not a quota reading
    expect(stateSnapshotKinds("渲染用例成功率 95%，失败的都在 svg 分支")).toEqual([]);
  });

  test("progress/status words", () => {
    expect(stateSnapshotKinds("进度：已完成 3/8 个包")).toEqual(["progress"]);
    expect(stateSnapshotKinds("迁移进行中，先不要动设置")).toEqual(["progress"]);
    expect(stateSnapshotKinds("该问题还没修复")).toEqual(["progress"]);
    expect(stateSnapshotKinds("当前会话的 cwd 是仓库根")).toEqual([]); // 当前(?!会话)
  });

  test("durable conclusions never match", () => {
    const durable = "验收选型时优先 deepseek-flash，不要默认 v4-pro（2026-11-05 用户令）。";
    expect(stateSnapshotKinds(durable)).toEqual([]);
    expect(looksLikeStateSnapshot(durable)).toBe(false);
  });

  test("multiple kinds report in table order", () => {
    const kinds = stateSnapshotKinds("run r_deadbe 的 5h 额度读数 71%，进度 2/5");
    expect(kinds).toContain("run id");
    expect(kinds).toContain("quota reading");
    expect(kinds).toContain("progress");
    expect(kinds[0]).toBe("run id");
  });
});
