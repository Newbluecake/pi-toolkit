/**
 * Demotion mark persistence (docs/dev/quota/quota-plan.md §3.4 / D6 / §5.3).
 *
 * File-level store（路径由调用方注入，生产侧是
 * `join(getAgentDir(), "quota-state.json")`）：标记必须活到窗口重置——跨
 * `/reload`、跨 `/new`、跨 pi 重启（session entry 在 `/new` 后消失，语义不
 * 匹配，D6）。
 *
 *   { "version": 1, "demotions": { "zai-coding-cn": { level, markedAt, expiresAt } } }
 *
 * - 原子写：tmp + rename（照抄 loadSettingsFromFile 的 `${path}.${pid}.tmp`
 *   手法）；内容未变则不落盘（write-through + no-op 检测）。
 * - 文件损坏 / 不可读 ⇒ 视为空表（静默，R6/§5.3 ③）；目录不可写 ⇒ 内存态
 *   照常工作（写失败只 WARN 一次，标记退化为「本进程内存有效」）。
 * - 过期双保险之一（TTL ①）：`now >= expiresAt` 即视为无记录；
 *   `expiresAt` = 触发窗口的 resetAt，未知/已过期 ⇒ markedAt + 6h。
 *   （② 观测重置由 service 调 `clear()` 实现。）
 * - 零 pi import、零 timer（plan §2 分层纪律 / D2）——fs 走命名空间导入，
 *   测试可 `vi.spyOn(fs, "writeFileSync")` 断言落盘行为。
 */

import * as fs from "node:fs";
import type { Millis } from "../core/types.js";

export interface DemotionRecord {
  readonly provider: string;
  readonly level: 2 | 3;
  readonly markedAt: Millis;
  /** 触发窗口的 resetAt；未知时 markedAt + DEFAULT_DEMOTION_TTL_MS。 */
  readonly expiresAt: Millis;
}

export interface DemotionStore {
  get(provider: string, now: Millis): DemotionRecord | undefined;
  /** 幂等：同 provider 只在 level 抬升或已过期时改写；否则不落盘。 */
  mark(provider: string, level: 2 | 3, resetAt: Millis | undefined, now: Millis): void;
  /** 观测到窗口重置时显式清除。 */
  clear(provider: string): void;
  list(now: Millis): readonly DemotionRecord[];
}

export interface DemotionStoreOptions {
  /** 绝对路径，由 stack.ts 注入 join(getAgentDir(), "quota-state.json")。 */
  readonly path: string;
  readonly now: () => Millis;
  readonly warn?: ((message: string) => void) | undefined;
}

export const DEFAULT_DEMOTION_TTL_MS = 21_600_000; // 6h

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 全 typeof 守卫；任何形状异常返回 undefined（静默丢弃该条，不炸整表）。 */
function parseRecord(provider: string, raw: unknown): DemotionRecord | undefined {
  if (!isRecord(raw)) return undefined;
  const { level, markedAt, expiresAt } = raw;
  if (level !== 2 && level !== 3) return undefined;
  if (typeof markedAt !== "number" || !Number.isFinite(markedAt)) return undefined;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return undefined;
  return { provider, level, markedAt: Math.round(markedAt), expiresAt: Math.round(expiresAt) };
}

export function createDemotionStore(options: DemotionStoreOptions): DemotionStore {
  const records = new Map<string, DemotionRecord>();
  let loaded = false;
  let lastWritten: string | undefined = undefined;
  let warnedWrite = false;

  const safeWarn = (message: string): void => {
    try {
      options.warn?.(message);
    } catch {
      // 日志通道坏了也不能破坏「永不抛」纪律。
    }
  };

  /** 序列化当前有效表（flush 时顺手剪掉已过期记录，保持文件干净）。 */
  const serialize = (): string => {
    const demotions: Record<string, { level: number; markedAt: number; expiresAt: number }> = {};
    const now = options.now();
    for (const provider of [...records.keys()].sort()) {
      const record = records.get(provider);
      if (record === undefined || record.expiresAt <= now) continue;
      demotions[provider] = { level: record.level, markedAt: record.markedAt, expiresAt: record.expiresAt };
    }
    return `${JSON.stringify({ version: 1, demotions }, null, 2)}\n`;
  };

  const flush = (): void => {
    const payload = serialize();
    if (payload === lastWritten) return; // 内容未变则不落盘
    try {
      // Atomic write (tmp + rename): the file is shared across sessions and
      // restarts — a torn write must never replace a valid table.
      const tmpPath = `${options.path}.${process.pid}.tmp`;
      fs.writeFileSync(tmpPath, payload, "utf8");
      fs.renameSync(tmpPath, options.path);
      lastWritten = payload;
    } catch (error) {
      // R6：目录不可写 / 磁盘满 ⇒ 内存态照常；WARN 一次不刷屏。
      if (!warnedWrite) {
        warnedWrite = true;
        safeWarn(
          `[quota] failed to persist demotion state to ${options.path}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  };

  /** 首次访问惰性加载；损坏文件 ⇒ 空表（静默）。 */
  const ensureLoaded = (): void => {
    if (loaded) return;
    loaded = true;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(options.path, "utf8"));
      if (isRecord(parsed) && isRecord(parsed.demotions)) {
        for (const [provider, entry] of Object.entries(parsed.demotions)) {
          const record = parseRecord(provider, entry);
          if (record !== undefined) records.set(provider, record);
        }
      }
    } catch {
      // 不存在 / 损坏 / 不可读 ⇒ 视为空表（§5.3 ③）。
    }
    try {
      lastWritten = serialize();
    } catch {
      lastWritten = undefined;
    }
  };

  return {
    get(provider, now) {
      ensureLoaded();
      const record = records.get(provider);
      if (record === undefined) return undefined;
      if (now >= record.expiresAt) return undefined; // TTL ①
      return record;
    },
    mark(provider, level, resetAt, now) {
      ensureLoaded();
      const existing = records.get(provider);
      // 幂等：未过期且新 level 不抬升（含 3→2 降写）⇒ 不改写、不落盘。
      if (existing !== undefined && existing.expiresAt > now && existing.level >= level) return;
      const fromReset =
        resetAt !== undefined && Number.isFinite(resetAt) && resetAt > now ? Math.round(resetAt) : undefined;
      const expiresAt = fromReset ?? now + DEFAULT_DEMOTION_TTL_MS;
      records.set(provider, { provider, level, markedAt: now, expiresAt });
      flush();
    },
    clear(provider) {
      ensureLoaded();
      if (!records.delete(provider)) return; // 本就不在表里 ⇒ 无事发生、不落盘
      flush();
    },
    list(now) {
      ensureLoaded();
      const out: DemotionRecord[] = [];
      for (const record of records.values()) {
        if (record.expiresAt > now) out.push(record);
      }
      return out;
    },
  };
}
