// Ported from the standalone session-nav extension (recent-sessions.ts) — web-resume plan
// §2.3 (P1) reworks the pipeline: ① time-window candidates → ② provenance index advance +
// bounded head reads (subagent:child self-marker) → sub set → ③ pi `SessionManager.list` over
// the symlink temp dir with a wrapped progress that FIRST maps temp paths → real paths and THEN
// drops sub rows (r1 #5 — partial rows of the recent loader carry temp-dir paths) → ④ skill
// title cleaning → ⑤ final sub filter. AbortSignal is threaded through every step and the temp
// dir is always removed (finally), abort included.
//
// `SessionListProgress` is a LOCAL 3-arg alias of pi 1.2's type (pi's own
// `SessionListProgress` is not exported from the package root — the exports map exposes only
// "." and "./rpc-entry"; the shape below is structurally identical to
// dist/core/session-manager.d.ts's declaration, F4).

import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { mkdtemp, readdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { cleanSkillTitles } from "./skill-titles.js";
import { collectSubagentSessions } from "./subagent-sessions.js";

export type SessionListProgress = (loaded: number, total: number, partialSessions?: readonly SessionInfo[]) => void;

/**
 * 只把时间窗口内的真实 session 文件链接到临时目录，再复用 pi 的原生 SessionManager
 * 解析元数据。这样既保留原生搜索/排序所需的 SessionInfo，又不会读取旧 JSONL。
 * Sub 会话（self-marker 或 provenance 命中）在 partial 进度和最终结果里都被整行丢弃（D1）。
 */
export async function listRecentSessions(
  cwd: string,
  sessionDir: string,
  hours: number,
  onProgress?: SessionListProgress,
  signal?: AbortSignal,
): Promise<SessionInfo[]> {
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  let entries;
  try {
    entries = await readdir(sessionDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const candidates = (
    await Promise.all(
      entries
        .filter((entry) => entry.name.endsWith(".jsonl"))
        .map(async (entry) => {
          const filePath = join(sessionDir, entry.name);
          try {
            const info = await stat(filePath);
            return info.isFile() && info.mtimeMs >= cutoff ? filePath : undefined;
          } catch {
            return undefined;
          }
        }),
    )
  ).filter((filePath): filePath is string => filePath !== undefined);

  if (candidates.length === 0) {
    onProgress?.(0, 0);
    return [];
  }

  const { sub } = await collectSubagentSessions(candidates, sessionDir, { signal });

  const tempDir = await mkdtemp(join(tmpdir(), "pi-recent-sessions-"));
  const realPathByName = new Map<string, string>();
  try {
    await Promise.all(
      candidates.map(async (sourcePath) => {
        const name = basename(sourcePath);
        realPathByName.set(name, sourcePath);
        await symlink(sourcePath, join(tempDir, name), "file");
      }),
    );

    // r1 #5: pi's partial rows carry temp-dir paths — map to real paths FIRST, then drop subs.
    const wrappedProgress: SessionListProgress = (loaded, total, partialSessions) => {
      if (partialSessions === undefined) {
        onProgress?.(loaded, total);
        return;
      }
      const kept = partialSessions
        .map((session) => {
          const real = realPathByName.get(basename(session.path));
          return real === undefined ? session : { ...session, path: real };
        })
        .filter((session) => !sub.has(resolve(session.path)));
      onProgress?.(loaded, total, kept);
    };

    const sessions = await SessionManager.list(cwd, tempDir, wrappedProgress, signal);
    const restored = sessions.map((session) => ({
      ...session,
      path: realPathByName.get(basename(session.path)) ?? session.path,
    }));
    const cleaned = await cleanSkillTitles(restored);
    return cleaned.filter((session) => !sub.has(resolve(session.path)));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
