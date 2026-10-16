/**
 * Accepted-reading baseline persistence (2026-10-15 现场事件的后继包，用户拍板):
 * `src/quota/service.ts` 的可疑读数防护（classifyDrop / suspects / 两次确认）只对比
 * **内存里的上一份快照**——`/reload` 或 pi 重启后没有 prev，第一份垃圾读数（实测：
 * core 三窗口全 0%，真实是 7d 100% / mo 98%）会被直接当真（展示、参与判定）。
 *
 * 本 store 把「每个 provider 最后一次**被接受**的读数」持久化到 quota-state.json 的
 * `baselines` 键（与 `demotions` 同一个文件、同一套纪律），重启后作为 classifyDrop
 * 的比较基线播种——只用于比对，**不用于展示**：verdicts / HUD 仍需一份新鲜且被接受
 * 的快照。
 *
 * 文件形状（`version: 1` 保持可读；旧文件没有 `baselines` 键照常加载，未知顶层键
 * 容忍并在落盘时保留——与 demotion store 对称的读改写约定）：
 *
 *   {
 *     "version": 1,
 *     "demotions": { ... },                       // demotion store 的组
 *     "baselines": {
 *       "kimi-coding": {
 *         "fetchedAt": 1760000000000,
 *         "windows": [
 *           { "scope": "5h", "usedPct": 100, "resetAt": 1760003600000 },
 *           { "scope": "week", "usedPct": 100 }
 *         ]
 *       }
 *     }
 *   }
 *
 * - 原子写：tmp + rename（照抄 demotion store 的 `${path}.${pid}.tmp` 手法）。
 * - no-op 检测：windows（scope/usedPct/resetAt）与已持久化内容一致 ⇒ 只更新内存
 *   fetchedAt、不落盘（读数不变时不产生磁盘写放大；磁盘上的 fetchedAt 停留在内容
 *   上次变化的那一刻，TTL 也从那一刻起算——用量真冻结 7 天后基线过期属预期）。
 * - TTL：`now - fetchedAt > BASELINE_TTL_MS`（7d）⇒ get 返回 undefined（过旧基线
 *   不得压制重启后的合法回落/重置读数）。
 * - 文件损坏 / 不可读 ⇒ 视为空表（静默）；目录不可写 ⇒ 内存态照常（WARN 一次）。
 * - 零 pi import、零 timer、零模块级状态（/reload 安全）。
 */

import * as fs from "node:fs";
import type { Millis } from "../core/types.js";
import type { WindowScope } from "./types.js";

export interface QuotaBaselineWindow {
  readonly scope: WindowScope;
  readonly usedPct: number;
  readonly resetAt?: Millis | undefined;
}

export interface QuotaBaseline {
  readonly fetchedAt: Millis;
  readonly windows: readonly QuotaBaselineWindow[];
}

export interface BaselineStore {
  /** 过期（> BASELINE_TTL_MS）/ 缺席 / 损坏 ⇒ undefined。 */
  get(provider: string, now: Millis): QuotaBaseline | undefined;
  /** windows 未变 ⇒ 只更新内存 fetchedAt，不落盘；永不抛。 */
  set(provider: string, baseline: QuotaBaseline): void;
}

export interface BaselineStoreOptions {
  /** 与 demotion store 同一个文件（生产侧 join(getAgentDir(), "quota-state.json")）。 */
  readonly path: string;
  readonly now: () => Millis;
  readonly warn?: ((message: string) => void) | undefined;
}

/** 基线保鲜窗口：超过即视同没有基线（用户拍板的 e.g. 7 days）。 */
export const BASELINE_TTL_MS = 7 * 24 * 3_600_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SCOPES: readonly WindowScope[] = ["5h", "week", "month"];

/** 全 typeof 守卫；任何形状异常返回 undefined（静默丢弃该窗口，不炸整条）。 */
function parseWindow(raw: unknown): QuotaBaselineWindow | undefined {
  if (!isRecord(raw)) return undefined;
  const { scope, usedPct, resetAt } = raw;
  if (typeof scope !== "string" || !SCOPES.includes(scope as WindowScope)) return undefined;
  if (typeof usedPct !== "number" || !Number.isFinite(usedPct)) return undefined;
  return {
    scope: scope as WindowScope,
    usedPct: Math.max(0, Math.min(100, usedPct)),
    ...(typeof resetAt === "number" && Number.isFinite(resetAt) ? { resetAt: Math.round(resetAt) } : {}),
  };
}

function parseBaseline(raw: unknown): QuotaBaseline | undefined {
  if (!isRecord(raw)) return undefined;
  const { fetchedAt, windows } = raw;
  if (typeof fetchedAt !== "number" || !Number.isFinite(fetchedAt)) return undefined;
  if (!Array.isArray(windows) || windows.length === 0) return undefined;
  const parsed: QuotaBaselineWindow[] = [];
  for (const w of windows) {
    const win = parseWindow(w);
    if (win === undefined) return undefined; // 半条基线比没有更危险：整条丢弃
    parsed.push(win);
  }
  return { fetchedAt: Math.round(fetchedAt), windows: parsed };
}

function windowsEqual(
  a: readonly QuotaBaselineWindow[] | undefined,
  b: readonly QuotaBaselineWindow[] | undefined,
): boolean {
  if (a === undefined || b === undefined || a.length !== b.length) return false;
  return a.every((w, i) => {
    const o = b[i]!;
    return w.scope === o.scope && w.usedPct === o.usedPct && w.resetAt === o.resetAt;
  });
}

/** 序列化当前表：保留同文件里其它 store 的顶层键（demotions / 未来的组）。 */
const serializeWith = (extras: Record<string, unknown>, records: Map<string, QuotaBaseline>): string => {
  const baselines: Record<string, { fetchedAt: number; windows: QuotaBaselineWindow[] }> = {};
  for (const provider of [...records.keys()].sort()) {
    const b = records.get(provider);
    if (b === undefined) continue;
    baselines[provider] = {
      fetchedAt: b.fetchedAt,
      windows: b.windows.map((w) => ({
        scope: w.scope,
        usedPct: w.usedPct,
        ...(w.resetAt === undefined ? {} : { resetAt: w.resetAt }),
      })),
    };
  }
  return `${JSON.stringify({ version: 1, ...extras, baselines }, null, 2)}\n`;
};

export function createBaselineStore(options: BaselineStoreOptions): BaselineStore {
  const records = new Map<string, QuotaBaseline>();
  /** 同文件其它 store 的顶层键（version / baselines 除外），落盘时原样保留。 */
  let extras: Record<string, unknown> = {};
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

  /** 首次访问惰性加载；损坏文件 ⇒ 空表（静默）。 */
  const ensureLoaded = (): void => {
    if (loaded) return;
    loaded = true;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(options.path, "utf8"));
      if (isRecord(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          if (key === "version" || key === "baselines") continue;
          extras[key] = value;
        }
        if (isRecord(parsed.baselines)) {
          for (const [provider, entry] of Object.entries(parsed.baselines)) {
            const baseline = parseBaseline(entry);
            if (baseline !== undefined) records.set(provider, baseline);
          }
        }
      }
    } catch {
      // 不存在 / 损坏 / 不可读 ⇒ 视为空表。
    }
    try {
      lastWritten = serializeWith(extras, records);
    } catch {
      lastWritten = undefined;
    }
  };

  /** flush 前重读文件，吸收同文件其它 store（demotions）的最新落盘——两 store 在同一
   *  进程内交错 flush 时，加载期捕获的 extras 快照已过期，直接写会抹掉对方的新组
   *  （读改写；读失败 ⇒ 维持已捕获的 extras）。跨进程仍是 last-writer-wins（与
   *  demotion store 既有纪律一致）。 */
  const refreshExtras = (): void => {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(options.path, "utf8"));
      if (isRecord(parsed)) {
        const next: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(parsed)) {
          if (key === "version" || key === "baselines") continue;
          next[key] = value;
        }
        extras = next;
      }
    } catch {
      // 不存在 / 损坏 / 不可读 ⇒ 维持当前 extras。
    }
  };

  const flush = (): void => {
    refreshExtras();
    const payload = serializeWith(extras, records);
    if (payload === lastWritten) return; // 内容未变则不落盘
    try {
      const tmpPath = `${options.path}.${process.pid}.tmp`;
      fs.writeFileSync(tmpPath, payload, "utf8");
      fs.renameSync(tmpPath, options.path);
      lastWritten = payload;
    } catch (error) {
      if (!warnedWrite) {
        warnedWrite = true;
        safeWarn(
          `[quota] failed to persist reading baseline to ${options.path}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  };

  return {
    get(provider, now) {
      ensureLoaded();
      const baseline = records.get(provider);
      if (baseline === undefined) return undefined;
      if (now - baseline.fetchedAt > BASELINE_TTL_MS) return undefined; // 过旧基线不作数
      return baseline;
    },
    set(provider, baseline) {
      ensureLoaded();
      const existing = records.get(provider);
      // no-op：比对窗口内容（与持久化判定相关的全部字段）；未变 ⇒ 只刷新内存
      // fetchedAt（TTL 计时延续），不触碰磁盘。
      if (existing !== undefined && windowsEqual(existing.windows, baseline.windows)) {
        if (existing.fetchedAt === baseline.fetchedAt) return;
        records.set(provider, baseline);
        return;
      }
      records.set(provider, baseline);
      flush();
    },
  };
}
