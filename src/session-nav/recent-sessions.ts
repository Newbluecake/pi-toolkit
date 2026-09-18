// Ported from the standalone session-nav extension (recent-sessions.ts) —
// behavior preserved verbatim; only import suffixes adapted (.ts → .js, ESM
// NodeNext).
//
// 时间窗口会话扫描 — /resume 默认只加载最近 N 小时，避免全量读取历史 JSONL。

import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { mkdtemp, readdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { cleanSkillTitles } from "./skill-titles.js";
import { collectSubagentMarks, markSubagentSessions } from "./subagent-sessions.js";

export type SessionListProgress = (loaded: number, total: number) => void;

/**
 * 只把时间窗口内的真实 session 文件链接到临时目录，再复用 pi 的原生 SessionManager
 * 解析元数据。这样既保留原生搜索/排序所需的 SessionInfo，又不会读取旧 JSONL。
 */
export async function listRecentSessions(
  cwd: string,
  sessionDir: string,
  hours: number,
  onProgress?: SessionListProgress,
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

    const sessions = await SessionManager.list(cwd, tempDir, onProgress);
    const restored = sessions.map((session) => ({
      ...session,
      path: realPathByName.get(basename(session.path)) ?? session.path,
    }));
    const marks = await collectSubagentMarks(
      candidates.map((path) => resolve(path)),
      sessionDir,
    );
    return markSubagentSessions(await cleanSkillTitles(restored), marks);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
