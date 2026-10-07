import { existsSync } from "node:fs";
import type { CustomEntry } from "@earendil-works/pi-coding-agent";
import type { SnapshotStore, OutboxRecord } from "../core/store.js";
import { TERMINAL_STATUSES } from "../core/status.js";
import { interruptedFromJournal } from "../core/run-journal.js";
import type { RunId, RunSnapshot, Generation, WorktreeDisposition } from "../core/types.js";
import type { LateWorktreeDisposition } from "./worktree-disposition-sink.js";

export const RUN_CUSTOM_TYPE = "subagent:run";
/** E20/D7: the late worktree-disposition dead-letter entry (written by stack.ts's sink, read by the seed). */
export const WORKTREE_DISPOSITION_CUSTOM_TYPE = "subagent:worktree-disposition";

export interface PiRunLogHost {
  appendEntry<T = unknown>(customType: string, data?: T): void;
  sessionManager: { getEntries(): ReadonlyArray<{ type: string; customType?: string; data?: unknown }> };
}

/**
 * G5a: wraps a SnapshotStore so every terminal put() also lands a
 * "subagent:run" custom entry via pi.appendEntry, and exposes
 * verifyLanded() to read it back via pi.sessionManager.getEntries()
 * (architecture 2.5 - appendEntry has no ack, so "persisted" must mean
 * "read back successfully", not just "the call did not throw").
 */
export function wrapWithRunLog(
  base: SnapshotStore,
  pi: PiRunLogHost,
): SnapshotStore & {
  verifyLanded(runId: RunId, generation: Generation): boolean;
  /** run-persistence plan D2/J2/J7: only appendEntry (never touches base), synchronous, never throws. */
  journal(snapshot: RunSnapshot): void;
} {
  return {
    put(snapshot: RunSnapshot) {
      base.put(snapshot);
      try {
        pi.appendEntry(RUN_CUSTOM_TYPE, snapshot);
      } catch {
        // Best-effort: verifyLanded() is the actual detection mechanism for
        // G5a degradation, not this try/catch (appendEntry itself has no ack
        // even when it does not throw, architecture 2.5).
      }
    },
    get(runId, generation) {
      return base.get(runId, generation);
    },
    list(filter) {
      return base.list(filter);
    },
    appendOutbox(entry: OutboxRecord) {
      base.appendOutbox(entry);
    },
    journal(snapshot: RunSnapshot) {
      try {
        pi.appendEntry(RUN_CUSTOM_TYPE, snapshot);
      } catch {
        // J7: best-effort. A stale appendEntry after /reload's invalidate()
        // is the expected failure here; the run itself is unaffected.
      }
    },
    verifyLanded(runId: RunId, generation: Generation) {
      return pi.sessionManager
        .getEntries()
        .some(
          (e) =>
            e.type === "custom" &&
            (e as CustomEntry).customType === RUN_CUSTOM_TYPE &&
            (e as CustomEntry<RunSnapshot>).data?.runId === runId &&
            (e as CustomEntry<RunSnapshot>).data?.generation === generation,
        );
    },
  };
}

/**
 * G5a 补全（2026-10-04 现场事故）+ run-persistence plan D4/D7：重启后恢复
 * resume 能力。wrapWithRunLog 只写不读——每次 stack 重建 MemoryRunStore 都是
 * 空的，进程重启后 resolveResumeTarget 的数据源全空（尽管 subagent:run 条目
 * 还在会话文件里）。这里在 stack 构建期把预取条目种回 base store——**直接喂
 * base，绕过写穿包装**，否则会把旧条目重复 appendEntry 回会话文件（J2）。
 *
 * 选择规则（每个 runId 一条）：有任何终态条目 ⇒ 只在终态条目里选，否则在
 * 非终态（journal）条目里选；同类内 updatedAt 大者胜，相等时文件中靠后者胜。
 * 选中的非终态条目经 `interruptedFromJournal` 合成为终态 aborted 再种入——
 * 种子是唯一的「非终态 → 终态」映射点，base store 永远只含终态快照（J1）。
 * 同批 `subagent:worktree-disposition` 条目（晚到的 worktree 处置死信）按
 * runId 取 `at` 最大者，折进 diag.worktree 缺席 / active / 无 path 的 kept
 * 快照（D7）。只种 sessionFile 仍在盘上的（resolveResumeTarget 反正要
 * existsSync 校验，提前过滤让候选列表不掺死人）。返回种入条数（诊断用）。
 */
export function seedRunStoreFromEntries(
  base: SnapshotStore,
  entries: ReadonlyArray<{ type: string; customType?: string; data?: unknown }>,
  fileExists: (path: string) => boolean = existsSync,
): number {
  const terminal = new Map<RunId, RunSnapshot>();
  const journal = new Map<RunId, RunSnapshot>();
  const dispositions = new Map<RunId, LateWorktreeDisposition>();
  for (const entry of entries) {
    if (entry.type !== "custom") continue;
    if (entry.customType === WORKTREE_DISPOSITION_CUSTOM_TYPE) {
      const d = entry.data as LateWorktreeDisposition | undefined;
      if (d === undefined || typeof d.runId !== "string" || typeof d.at !== "number") continue;
      if (d.state !== "committed" && d.state !== "kept" && d.state !== "clean") continue;
      const prev = dispositions.get(d.runId);
      if (prev === undefined || d.at >= prev.at) dispositions.set(d.runId, d);
      continue;
    }
    if (entry.customType !== RUN_CUSTOM_TYPE) continue;
    const snapshot = entry.data as RunSnapshot | undefined;
    if (snapshot === undefined || typeof snapshot.runId !== "string") continue;
    if (snapshot.diag === undefined || typeof snapshot.updatedAt !== "number") continue; // 畸形/旧版条目防御
    const bucket = TERMINAL_STATUSES.has(snapshot.status) ? terminal : journal;
    const prev = bucket.get(snapshot.runId);
    if (prev === undefined || snapshot.updatedAt >= prev.updatedAt) bucket.set(snapshot.runId, snapshot);
  }
  const chosen: RunSnapshot[] = [...terminal.values()];
  for (const [runId, snapshot] of journal) if (!terminal.has(runId)) chosen.push(interruptedFromJournal(snapshot));
  let seeded = 0;
  for (const snapshot of chosen) {
    const file = snapshot.diag.sessionFile;
    if (typeof file !== "string" || file === "" || !fileExists(file)) continue;
    base.put(foldLateDisposition(snapshot, dispositions.get(snapshot.runId)));
    seeded++;
  }
  return seeded;
}

/** D7: fold a late worktree disposition into a seeded snapshot whose own worktree state is unresolved. */
function foldLateDisposition(snapshot: RunSnapshot, late: LateWorktreeDisposition | undefined): RunSnapshot {
  if (late === undefined) return snapshot;
  const current = snapshot.diag.worktree;
  const unresolved =
    current === undefined || current.state === "active" || (current.state === "kept" && current.path === undefined);
  if (!unresolved) return snapshot;
  const worktree: WorktreeDisposition = {
    state: late.state,
    ...(late.branch === undefined ? {} : { branch: late.branch }),
    ...(late.path === undefined ? {} : { path: late.path }),
  };
  const diag = { ...snapshot.diag, worktree };
  return {
    ...snapshot,
    diag,
    ...(snapshot.outcome === undefined ? {} : { outcome: { ...snapshot.outcome, diag } }),
  };
}
