// 主会话 / subagent 会话区分 — web-resume plan §2.1/§2.3 (P1)。
//
// 判定规则（无启发式，D2）：会话文件是 sub ⇔ (a) 文件头部含 `subagent:child` 自标记
// （v0.4.0+ 的子会话，写在文件第 2 行，见 session-head.ts），或 (b) 其路径在**整个会话
// 目录**的 provenance 索引里（所有主会话 `subagent:run` 条目 diag.sessionFile 的并集，
// 增量回填 + 磁盘缓存 v2，见 provenance.ts）。旧的「扫 48h 窗口内文件 + mtime/size 缓存
// + `[sub:type]` 改标题」路径已按 D1（彻底隐藏）删除：sub 会话在 TUI/web 列表里整行丢弃，
// 没有 flag、没有开关、没有隐藏计数行；用户改过名（session_info.name）的子会话同样按
// 身份过滤（旧 retitle 路径的 rename 豁免不再存在）。
//
// 性能：advanceProvenance 每次调用在有界预算（默认 ≤2s / ≤64MiB / ≤4fd）内推进增量回填；
// 候选文件的 self-marker 头读并发 ≤16、每文件有界（64KiB 头 + 16KiB 尾）。全部文件打开
// 走 openSessionNoFollowAsync（O_NOFOLLOW|O_NONBLOCK|O_NOCTTY，fstat 非 regular 即拒绝）。

import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { advanceProvenance, DEFAULT_PROVENANCE_BUDGET, type ProvenanceIndex } from "./provenance.js";
import { openSessionNoFollowAsync, readSessionHeadFd } from "./session-head.js";

/** §2.3: candidate head reads run with ≤16 concurrency. */
export const HEAD_SCAN_CONCURRENCY = 16;

export interface SubagentFilter {
  /** Resolved paths of subagent sessions among the candidates (D1: dropped entirely by callers). */
  sub: ReadonlySet<string>;
  /** The dir-wide provenance index advanced by this call (for `complete`/status diagnostics). */
  index: ProvenanceIndex;
}

/**
 * Classify the given candidate session files: advance the provenance index one budgeted step,
 * then head-read each candidate not already covered by the index for the `subagent:child`
 * self-marker (v0.4.0+ children stay hidden even while the backfill is incomplete or
 * capacity-truncated). Never throws for a single bad file — it is simply not classified.
 */
export async function collectSubagentSessions(
  candidateFiles: string[],
  sessionDir: string,
  opts?: { budget?: { ms: number; bytes: number }; signal?: AbortSignal | undefined },
): Promise<SubagentFilter> {
  const index = await advanceProvenance(sessionDir, opts?.budget ?? DEFAULT_PROVENANCE_BUDGET, opts?.signal);
  const sub = new Set<string>();
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(HEAD_SCAN_CONCURRENCY, candidateFiles.length) }, async () => {
      for (;;) {
        if (opts?.signal?.aborted) return;
        const path = candidateFiles[cursor++];
        if (path === undefined) return;
        const resolved = resolve(path);
        if (index.has(resolved)) {
          sub.add(resolved); // provenance hit — no need to open the file at all
          continue;
        }
        const opened = await openSessionNoFollowAsync(path);
        if (opened === undefined) continue;
        try {
          const result = readSessionHeadFd(opened.handle.fd, opened.fact.size);
          if (result.ok && result.head.child) sub.add(resolved);
        } finally {
          await opened.handle.close().catch(() => {});
        }
      }
    }),
  );
  return { sub, index };
}

/** 列出目录下全部 session 文件（给 --all 路径用）。 */
export async function listSessionFiles(sessionDir: string): Promise<string[]> {
  try {
    return (await readdir(sessionDir))
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => resolve(join(sessionDir, name)));
  } catch {
    return [];
  }
}
