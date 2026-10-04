import { existsSync } from "node:fs";
import type { CustomEntry } from "@earendil-works/pi-coding-agent";
import type { SnapshotStore, OutboxRecord } from "../core/store.js";
import { TERMINAL_STATUSES } from "../core/status.js";
import type { RunId, RunSnapshot, Generation } from "../core/types.js";

export const RUN_CUSTOM_TYPE = "subagent:run";

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
): SnapshotStore & { verifyLanded(runId: RunId, generation: Generation): boolean } {
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
 * G5a 补全（2026-10-04 现场事故）：重启后恢复 resume 能力。
 * wrapWithRunLog 只写不读——每次 stack 重建 MemoryRunStore 都是空的，进程
 * 重启后 resolveResumeTarget 的四个数据源（records/live/tombstones/labels）
 * 全空，终态 run 无法 resume（尽管 subagent:run 条目还在会话文件里）。
 * 这里在 stack 构建期把预取条目里的终态快照种回 base store——**直接喂
 * base，绕过写穿包装**，否则会把旧条目重复 appendEntry 回会话文件。
 * 每个 runId 只留最新一条（updatedAt，同刻比 generation）；只种终态且
 * sessionFile 仍在盘上的（resolveResumeTarget 反正要 existsSync 校验，
 * 提前过滤让候选列表不掺死人）。返回种入条数（诊断用）。
 */
export function seedRunStoreFromEntries(
  base: SnapshotStore,
  entries: ReadonlyArray<{ type: string; customType?: string; data?: unknown }>,
  fileExists: (path: string) => boolean = existsSync,
): number {
  const latest = new Map<RunId, RunSnapshot>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== RUN_CUSTOM_TYPE) continue;
    const snapshot = entry.data as RunSnapshot | undefined;
    if (snapshot === undefined || typeof snapshot.runId !== "string") continue;
    if (!TERMINAL_STATUSES.has(snapshot.status)) continue;
    if (snapshot.diag === undefined || typeof snapshot.updatedAt !== "number") continue; // 畸形/旧版条目防御
    const prev = latest.get(snapshot.runId);
    if (
      prev === undefined ||
      snapshot.updatedAt > prev.updatedAt ||
      (snapshot.updatedAt === prev.updatedAt && snapshot.generation > prev.generation)
    )
      latest.set(snapshot.runId, snapshot);
  }
  let seeded = 0;
  for (const snapshot of latest.values()) {
    const file = snapshot.diag.sessionFile;
    if (typeof file !== "string" || file === "" || !fileExists(file)) continue;
    base.put(snapshot);
    seeded++;
  }
  return seeded;
}
