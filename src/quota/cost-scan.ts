/**
 * quota 面板「按 API 价格折算费用」（2026-11-03 用户拍板，形态 B：折算挂在窗口重置文案旁
 * `22:06 重置 · ≈$12.30`，不新增行、HUD 不加、无设置门）的增量扫描器。pi-free。
 *
 * 数据源边界（2026-11-03 用户拍板，全项目扫描）：root = `<agentDir>/sessions/`，其下每个
 * 子目录是一个项目的会话目录（`<编码cwd>/*.jsonl`），**全部项目**都计入折算。assistant
 * 条目自带 provider/model/timestamp + usage.cost.total（pi 已按目录价算好）。主会话与
 * 子会话文件同目录，全部计入——子用量只写在子文件里，天然无双算。
 *
 * 增量游标（有界范式抄 `src/session-nav/provenance.ts`）：按文件 byte offset 推进
 * （append-only 安全），单 pass ≤ budget.ms / budget.bytes（默认 500ms / 32MiB——全项目
 * 1.4GB/1166 文件量级下首回填需几分钟收敛，250ms/16MiB 会把回填拖到过久；500ms 仍远小于
 * 驱动它的 1Hz tick 间隔，不阻塞 web-hub agent）。文件打开走 `openSessionNoFollowAsync`
 * （O_NOFOLLOW；顺序扫 ⇒ ≤1 fd）。与 provenance 的关键差异：bucket 按**文件**归属
 * （cursor 里每文件存自己的 hour→[cost,unpriced]）——文件身份变化（dev/ino 变或 shrink）
 * ⇒ 丢弃该文件的 bucket 并从 0 重扫，永不双算。
 *
 * 目录枚举（有界 + 公平 + 稳态轻量）：
 * - root 每 pass readdir 一层（目录数 ~几十，廉价）；子目录内容**分帧**枚举——每 pass
 *   lstat 上限 `enumStatsPerPass`（默认 1024）+ 枚举时间片 ≤ min(budget.ms/3, 120ms)，
 *   目录内可断点续枚举（pendingNames），绝不一次 stat 全部 ~1166 文件。
 * - 枚举顺序：断点目录 → 热目录（已知最新 mtime 文件所属项目）→ 轮转游标，避免早期
 *   目录饿死。
 * - 首轮全量枚举完成（sweep complete）后转**轻量探测**：每 pass lstat 各项目目录
 *   （mtime 变化 ⇒ 有文件增删 ⇒ 重枚举该目录）+ 抽 stat 48h 内活跃的已跟踪文件
 *   （append 只动文件 mtime 不动目录 mtime）+ 每 pass 滚动补枚举 3 个目录（自愈：
 *   唤醒沉睡会话等漏网场景最迟 ~目录数/3 个 idle pass 被发现）。
 *
 * 计价：`usage.cost.total` 有限数 ⇒ 权威值（含 0——pi 已裁决）。缺失 ⇒ token×目录价兜底
 * （priceLookup 注入，费率 per-Mtok，公式仿 `src/external-agent/pricing.ts` 的 priceUsage）：
 * lookup 命中（含全零费率 ⇒ 「零价」）⇒ 计入 0，不标 unpriced；lookup 未命中 ⇒ 「无价」，
 * 该小时记 unpriced++，窗口求和时以 `unpriced: true` 上 wire（UI 渲染 `≈$X.XX+`）。
 *
 * 窗口对齐（拍板）：窗口起点 ≈ resetAt − 时长（5h→5h、week→7d、month→30d），`quotaWindowCost`
 * 对该区间求和。hour bucket 粒度 ⇒ 边缘最多 ±1h 误差（相交即计入），`≈` 前缀本就声明近似。
 * resetAt 缺失 ⇒ 无窗口边界 ⇒ 不出折算（undefined）。
 *
 * 持久化：游标 + buckets 以 `costScan` 顶层组读改写进 quota-state.json（与 demotion /
 * baseline store 同文件同纪律：flush 前重读、保留其它顶层键、tmp+rename 原子写、0600）。
 * 本组紧凑序列化（无 pretty——条目多一个数量级后 pretty 的缩进开销不可接受；同文件其它
 * store flush 时会重新 pretty，格式随最后写入者，解析侧不受影响）。文件损坏 / dir 不匹配
 * ⇒ 视为空态重扫（dir 语义 2026-11-03 从单项目目录变为 sessions root，旧状态自然作废重扫）。
 *
 * 状态体量与防抖动（硬要求）：条目淘汰只在序列化超 `COST_SCAN_STATE_MAX_BYTES` 时发生，
 * 顺序 = 先「桶空且最旧 mtime」（重扫只费字节、不丢费用历史），不够再「任意桶最旧 mtime」。
 * 被淘汰路径记入进程内 evictedPaths ⇒ **本进程不再重扫该文件**（切断「淘汰→重扫→再淘汰」
 * 抖动环；complete 保持 false，与 TRACKED_FILES_MAX 容量语义一致）。hour bucket 保鲜 40d
 * （最长窗口 month=30d + 余量），落盘时丢弃更旧 bucket。上限取值有实测背书（见 README）。
 *
 * 驱动：无 timer（I5 平凡满足）——`maybeAdvance()` 由 web-hub agent 的 1Hz tick 调用，
 * 内部节流（incomplete 2s / complete 15s）+ single-flight；webHub 关闭 ⇒ 无人调用 ⇒ 零 I/O
 * （I9）。惰性加载：首次 advance 才读状态文件与目录。`view()` 同步、永不抛。
 */

import { lstat, mkdir, open as openAsync, readFile, readdir, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Dirent } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import type { Millis } from "../core/types.js";
import { openSessionNoFollowAsync } from "../session-nav/session-head.js";
import type { WindowScope } from "./types.js";

// ---------------------------------------------------------------------------
// public types + constants
// ---------------------------------------------------------------------------

/** pi 目录价费率（per-Mtok，与 pi-ai `ModelCostRates` 同形）。 */
export interface CostScanRates {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** 目录价通道（生产侧 = ctx.modelRegistry.find）；undefined ⇒ 无价模型。 */
export type CostScanPriceLookup = (provider: string, model: string) => CostScanRates | undefined;

/** 一个窗口区间内的折算结果。 */
export interface QuotaCostWindow {
  readonly usd: number;
  /** 区间内有无法计价的用量（目录价缺失）⇒ 和是下界。 */
  readonly unpriced: boolean;
}

/** 扫描器的同步只读视图（projection / fingerprint / 进度展示用）。 */
export interface QuotaCostView {
  /** 首轮全量枚举完成，且所有 tracked 文件游标均已推进到当前 size（未触发容量上限）。 */
  readonly complete: boolean;
  /** 游标已到位（scannedTo === size 且身份一致）的 tracked 文件数。 */
  readonly scannedFiles: number;
  /** 已知 tracked 文件数（首轮枚举未扫完时是下界）。 */
  readonly totalFiles: number;
  /** 本进程累计从会话文件读出的字节数（「无重复扫描」可观测性：收敛后应 ≈ 文件总量）。 */
  readonly readBytes: number;
  /** provider 在 [startMs, endMs) 内的折算；该 provider 无任何数据 ⇒ undefined。 */
  costInWindow(provider: string, startMs: Millis, endMs: Millis): QuotaCostWindow | undefined;
}

export interface CostScanner {
  /** 同步、永不抛（未扫描/目录不可读 ⇒ complete:false 的空视图）。 */
  view(): QuotaCostView;
  /** 一个完整的预算 pass（可 await；测试与未来的主动驱动用）。生产侧驱动走 maybeAdvance。 */
  advance(): Promise<void>;
  /** fire-and-forget：内部节流 + single-flight；永不抛、永不返回被拒 Promise。 */
  maybeAdvance(): void;
  /** 幂等；无资源持有（无 timer/fd），仅阻止后续 advance 与 in-flight pass 的落盘。 */
  dispose(): void;
}

export interface CostScannerOptions {
  /** `<agentDir>/sessions`（全项目扫描 root；其下每个子目录是一个项目的会话目录）。 */
  readonly sessionsRoot: string;
  /** quota-state.json（与 demotion/baseline store 同文件，读改写保留其它组）。 */
  readonly statePath: string;
  readonly priceLookup: CostScanPriceLookup;
  readonly now: () => Millis;
  /** 单 pass 上限；默认 500ms / 32 MiB（取值理由见文件头）。 */
  readonly budget?: { ms: number; bytes: number };
  /** 扫描未收敛时的最小 pass 间隔（默认 2s）。 */
  readonly busyIntervalMs?: number;
  /** 已收敛后的最小 pass 间隔（默认 15s）。 */
  readonly idleIntervalMs?: number;
  /** 每 pass 目录枚举 lstat 上限（默认 1024；测试旋钮）。 */
  readonly enumStatsPerPass?: number;
  /** 状态序列化上限（默认 COST_SCAN_STATE_MAX_BYTES；测试旋钮）。 */
  readonly stateMaxBytes?: number;
  readonly warn?: ((message: string) => void) | undefined;
}

/** 窗口时长映射（拍板）：5h→5h、week→7d、month→30d。 */
export const COST_WINDOW_SPAN_MS: Readonly<Record<WindowScope, number>> = {
  "5h": 5 * 3_600_000,
  week: 7 * 24 * 3_600_000,
  month: 30 * 24 * 3_600_000,
};

/** 单文件单 pass 读块上限（公平性：大文件不饿死其他文件，下轮从 scannedTo 续）。 */
export const COST_SCAN_CHUNK_BYTES = 8 * 1024 * 1024;
/** tracked 文件上限（最新 mtime 优先；超出 ⇒ complete:false）。 */
export const COST_SCAN_TRACKED_FILES_MAX = 20_000;
/**
 * 状态文件序列化上限；超出 ⇒ 淘汰（先桶空最旧、再任意最旧；被淘汰路径本进程不再重扫）。
 * 取值：全项目实测状态约数百 KiB 量级（紧凑序列化），32MiB 给出数十倍余量。
 */
export const COST_SCAN_STATE_MAX_BYTES = 32 * 1024 * 1024;
/** hour bucket 保鲜：比最长窗口（month=30d）+ 余量更旧的 bucket 在落盘时丢弃。 */
export const COST_BUCKET_RETENTION_MS = 40 * 24 * 3_600_000;
export const DEFAULT_COST_SCAN_BUDGET = { ms: 500, bytes: 32 * 1024 * 1024 };
/** 每 pass 目录枚举 lstat 上限（分帧推进；实测 1166 文件全量 lstat ≈ 数十 ms，一帧可容）。 */
export const COST_SCAN_ENUM_STATS_PER_PASS = 1_024;
/** 枚举时间片硬顶（ms）：即使 budget.ms 很大，枚举也不许吃掉整个 pass。 */
export const COST_SCAN_ENUM_MS_CAP = 120;
/** 稳态每 pass 滚动补枚举的目录数（自愈漏网；78 目录 ⇒ 全量刷新周期 ≈ 26 个 idle pass ≈ 6.5min）。 */
export const COST_SCAN_ENUM_ROLL_DIRS = 3;
/** 稳态每 pass 抽 stat 的 48h 活跃文件上限（append 不动目录 mtime，靠它发现增长）。 */
export const COST_SCAN_ENUM_RECENT_FILES = 128;

const HOUR_MS = 3_600_000;
const STATE_GROUP = "costScan";

/** 窗口求和（拍板的窗口对齐）：起点 = resetAt − 时长。resetAt/视图缺失 ⇒ undefined。 */
export function quotaWindowCost(
  view: QuotaCostView | undefined,
  provider: string,
  scope: WindowScope,
  resetAt: Millis | undefined,
): QuotaCostWindow | undefined {
  if (view === undefined || resetAt === undefined || !Number.isFinite(resetAt)) return undefined;
  const span = COST_WINDOW_SPAN_MS[scope];
  if (!Number.isFinite(span) || span <= 0) return undefined;
  return view.costInWindow(provider, resetAt - span, resetAt);
}

// ---------------------------------------------------------------------------
// persisted state (quota-state.json 的 costScan 组)
// ---------------------------------------------------------------------------

/** hour → [costUsd, unpricedCount]。 */
type BucketMap = Record<string, Record<string, [number, number]>>;

interface CostFileState {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  /** 最后一个完整 `\n` 之后的 byte offset。 */
  scannedTo: number;
  /** 本文件归属的 hour bucket（身份变化 ⇒ 连同 bucket 一起丢弃重扫 ⇒ 无双算）。 */
  buckets: BucketMap;
}

interface CostScanState {
  version: 1;
  /** 游标按 root 归属；root 变化（含 2026-11-03 从单项目目录升级）⇒ 整组作废重扫。 */
  dir: string;
  /** lane ② round-robin 游标（最后一个访问的 path）。 */
  cursor: string;
  files: Record<string, CostFileState>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

function finiteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function sanitizeBuckets(raw: unknown): BucketMap | undefined {
  if (!isRecord(raw)) return undefined;
  const out: BucketMap = {};
  for (const [provider, hours] of Object.entries(raw)) {
    if (!isRecord(hours)) continue;
    const h: Record<string, [number, number]> = {};
    for (const [hourKey, pair] of Object.entries(hours)) {
      if (!/^\d{1,15}$/.test(hourKey)) continue;
      if (!Array.isArray(pair) || pair.length !== 2) continue;
      const c = finiteNumber(pair[0]);
      const u = finiteNumber(pair[1]);
      if (c === undefined || u === undefined || c < 0 || u < 0) continue;
      h[hourKey] = [c, Math.floor(u)];
    }
    if (Object.keys(h).length > 0) out[provider] = h;
  }
  return out;
}

function sanitizeFileState(raw: unknown): CostFileState | undefined {
  if (!isRecord(raw)) return undefined;
  const dev = finiteNumber(raw["dev"]);
  const ino = finiteNumber(raw["ino"]);
  const size = finiteNumber(raw["size"]);
  const mtimeMs = finiteNumber(raw["mtimeMs"]);
  const scannedTo = finiteNumber(raw["scannedTo"]);
  if (dev === undefined || ino === undefined || size === undefined || mtimeMs === undefined) return undefined;
  if (scannedTo === undefined || !Number.isInteger(scannedTo) || scannedTo < 0 || scannedTo > size) return undefined;
  const buckets = sanitizeBuckets(raw["buckets"]) ?? {};
  return { dev, ino, size, mtimeMs, scannedTo, buckets };
}

function emptyState(dir: string): CostScanState {
  return { version: 1, dir, cursor: "", files: {} };
}

function parseState(raw: unknown, dir: string): CostScanState {
  if (!isRecord(raw) || raw["version"] !== 1 || raw["dir"] !== dir) return emptyState(dir);
  const cursor = typeof raw["cursor"] === "string" ? raw["cursor"] : "";
  const filesRaw = raw["files"];
  const files: Record<string, CostFileState> = {};
  if (isRecord(filesRaw)) {
    for (const [path, value] of Object.entries(filesRaw)) {
      const entry = sanitizeFileState(value);
      if (entry !== undefined) files[path] = entry;
    }
  }
  return { version: 1, dir, cursor, files };
}

/**
 * 读改写纪律：flush 前重读文件，保留同文件其它 store 的顶层键（version/demotions/baselines…）。
 * 返回被淘汰的文件 path（调用方据此把路径拉入 evictedPaths，本进程不再重扫——防抖动硬要求）。
 */
async function flushState(statePath: string, state: CostScanState, now: Millis, maxBytes: number): Promise<string[]> {
  // bucket 保鲜（>40d 的 hour bucket 对任何窗口都无贡献，落盘时丢弃）。
  const oldestHour = Math.floor((now - COST_BUCKET_RETENTION_MS) / HOUR_MS);
  for (const entry of Object.values(state.files)) {
    for (const [provider, hours] of Object.entries(entry.buckets)) {
      for (const hourKey of Object.keys(hours)) {
        if (Number(hourKey) < oldestHour) delete hours[hourKey];
      }
      if (Object.keys(hours).length === 0) delete entry.buckets[provider];
    }
  }
  let extras: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(statePath, "utf8"));
    if (isRecord(parsed)) {
      for (const [key, value] of Object.entries(parsed)) {
        if (key === STATE_GROUP) continue;
        extras[key] = value;
      }
    }
  } catch {
    // 不存在 / 损坏 ⇒ 只写自己的组。
  }
  // 紧凑序列化：全项目后条目多一个数量级，pretty 缩进是不可接受的固定开销。
  let payload = `${JSON.stringify({ ...extras, [STATE_GROUP]: state })}\n`;
  const evicted: string[] = [];
  while (Buffer.byteLength(payload, "utf8") > maxBytes) {
    // 淘汰顺序（防抖动硬要求）：先「桶空且最旧 mtime」（重扫只费字节、不丢费用历史），
    // 不够再「任意桶最旧 mtime」。被淘汰路径由调用方记入 evictedPaths，本进程不再重扫。
    let victim: string | undefined;
    let victimMtime = Infinity;
    for (const [path, entry] of Object.entries(state.files)) {
      if (Object.keys(entry.buckets).length > 0) continue;
      if (entry.mtimeMs < victimMtime) {
        victimMtime = entry.mtimeMs;
        victim = path;
      }
    }
    if (victim === undefined) {
      for (const [path, entry] of Object.entries(state.files)) {
        if (entry.mtimeMs < victimMtime) {
          victimMtime = entry.mtimeMs;
          victim = path;
        }
      }
    }
    if (victim === undefined) return evicted; // 空文件表都放不下 ⇒ 放弃本次落盘
    delete state.files[victim];
    evicted.push(victim);
    payload = `${JSON.stringify({ ...extras, [STATE_GROUP]: state })}\n`;
  }
  await mkdir(dirname(statePath), { recursive: true });
  // Unique tmp name: demotion.ts/baseline.ts flush the SAME state file synchronously;
  // a shared tmp name would let an interleaved sync flush clobber this async write.
  const tmp = `${statePath}.cost-scan.${process.pid}.tmp`;
  try {
    const handle = await openAsync(tmp, "w", 0o600);
    try {
      await handle.writeFile(payload, "utf8");
    } finally {
      await handle.close();
    }
    await rename(tmp, statePath);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
  return evicted;
}

// ---------------------------------------------------------------------------
// scanner
// ---------------------------------------------------------------------------

interface FileFact {
  path: string;
  /** 所属项目目录名（root 下一层；热目录判定用）。 */
  dirName: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function clampTokens(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/** token×目录价兜底（仿 pricing.ts 的 priceUsage，无 tier——目录价 tiers 不注入本通道）。 */
function fallbackUsd(usage: Record<string, unknown> | undefined, rates: CostScanRates): number {
  const input = clampTokens(usage?.["input"]);
  const output = clampTokens(usage?.["output"]);
  const cacheRead = clampTokens(usage?.["cacheRead"]);
  const cacheWrite = clampTokens(usage?.["cacheWrite"]);
  const usd =
    (input * rates.input + output * rates.output + cacheRead * rates.cacheRead + cacheWrite * rates.cacheWrite) /
    1_000_000;
  return Number.isFinite(usd) && usd > 0 ? usd : 0;
}

export function createCostScanner(options: CostScannerOptions): CostScanner {
  const root = resolve(options.sessionsRoot);
  const budget = options.budget ?? DEFAULT_COST_SCAN_BUDGET;
  const busyMs = options.busyIntervalMs ?? 2_000;
  const idleMs = options.idleIntervalMs ?? 15_000;
  const enumStatsCap = options.enumStatsPerPass ?? COST_SCAN_ENUM_STATS_PER_PASS;
  const stateMaxBytes = options.stateMaxBytes ?? COST_SCAN_STATE_MAX_BYTES;

  let loaded = false;
  let state = emptyState(root);
  let disposed = false;
  let inflight = false;
  let nextAt = 0;
  let lastComplete = false;
  let lastScannedFiles = 0;
  let lastTotalFiles = 0;
  let readBytesTotal = 0;
  let warnedFail = false;
  /** 聚合缓存（view 热路径）：任何 bucket/文件变动 ⇒ dirty。 */
  let aggDirty = true;
  let agg = new Map<string, Map<number, [number, number]>>();

  // ---- 目录枚举的内存态（不落盘；重启后重新轮转，代价只是重新枚举） ----
  /** root 下一层项目目录名（排序）。 */
  let dirNames: string[] = [];
  let dirSet = new Set<string>();
  /** 尚未完整枚举过的目录（undefined = 首 pass 前未初始化）。 */
  let enumPending: Set<string> | undefined;
  /** 轮转游标（dirNames 下标）。 */
  let dirCursor = 0;
  /** 稳态滚动补枚举游标（dirNames 下标）。 */
  let rollCursor = 0;
  /** 目录内断点续枚举（一个目录的 lstat 超帧时下一 pass 续）。 */
  let pendingNames: { dir: string; names: string[]; next: number } | undefined;
  /** 已枚举到的文件事实（path → 最近一次 lstat）。 */
  const factMap = new Map<string, FileFact>();
  /** 各项目目录最近一次枚举/探测到的 mtime（稳态轻量探测：变了才重枚举）。 */
  const dirMtimes = new Map<string, number>();
  /** flush 淘汰过的 path：本进程不再重扫（切断「淘汰→重扫→再淘汰」抖动环）。 */
  const evictedPaths = new Set<string>();

  const safeWarn = (message: string): void => {
    if (warnedFail) return;
    warnedFail = true;
    try {
      options.warn?.(message);
    } catch {
      // 日志通道坏了不破坏永不抛纪律。
    }
  };

  const markDirty = (): void => {
    aggDirty = true;
  };

  const aggregate = (): Map<string, Map<number, [number, number]>> => {
    if (!aggDirty) return agg;
    const next = new Map<string, Map<number, [number, number]>>();
    for (const entry of Object.values(state.files)) {
      for (const [provider, hours] of Object.entries(entry.buckets)) {
        let hp = next.get(provider);
        if (hp === undefined) {
          hp = new Map();
          next.set(provider, hp);
        }
        for (const [hourKey, pair] of Object.entries(hours)) {
          const hour = Number(hourKey);
          const cur = hp.get(hour);
          if (cur === undefined) hp.set(hour, [pair[0], pair[1]]);
          else {
            cur[0] += pair[0];
            cur[1] += pair[1];
          }
        }
      }
    }
    agg = next;
    aggDirty = false;
    return agg;
  };

  const addBucket = (entry: CostFileState, provider: string, hour: number, usd: number, unpriced: boolean): void => {
    let hours = entry.buckets[provider];
    if (hours === undefined) {
      hours = {};
      entry.buckets[provider] = hours;
    }
    const key = String(hour);
    const cur = hours[key];
    if (cur === undefined) hours[key] = [usd, unpriced ? 1 : 0];
    else {
      cur[0] += usd;
      if (unpriced) cur[1] += 1;
    }
    markDirty();
  };

  const processLine = (line: string, entry: CostFileState): void => {
    if (!line.includes('"role":"assistant"')) return; // 廉价预过滤，先不 JSON.parse
    const parsed = parseJson(line);
    if (!isRecord(parsed) || parsed["type"] !== "message") return;
    const msg = parsed["message"];
    if (!isRecord(msg) || msg["role"] !== "assistant") return;
    const provider = msg["provider"];
    if (typeof provider !== "string" || provider === "") return;
    const model = typeof msg["model"] === "string" ? msg["model"] : "";
    const tsRaw = finiteNumber(msg["timestamp"]);
    const ts = tsRaw ?? (typeof parsed["timestamp"] === "string" ? Date.parse(parsed["timestamp"]) : NaN);
    if (!Number.isFinite(ts)) return;
    const usage = isRecord(msg["usage"]) ? msg["usage"] : undefined;
    const cost = usage !== undefined && isRecord(usage["cost"]) ? usage["cost"] : undefined;
    const total = finiteNumber(cost?.["total"]);
    if (total !== undefined) {
      // pi 已按目录价算好（含 0）⇒ 权威值。
      addBucket(entry, provider, Math.floor(ts / HOUR_MS), Math.max(0, total), false);
      return;
    }
    const rates = options.priceLookup(provider, model);
    if (rates === undefined) {
      addBucket(entry, provider, Math.floor(ts / HOUR_MS), 0, true); // 无价
      return;
    }
    addBucket(entry, provider, Math.floor(ts / HOUR_MS), fallbackUsd(usage, rates), false); // 零价也算 priced
  };

  const readAt = async (handle: FileHandle, buf: Buffer, want: number, position: number): Promise<number> => {
    let done = 0;
    while (done < want) {
      const { bytesRead } = await handle.read(buf, done, want - done, position + done);
      if (bytesRead <= 0) break;
      done += bytesRead;
    }
    return done;
  };

  let scratch: Buffer | undefined;

  /** 扫一个文件的一个有界块；返回读到的字节数（0 = 无事可做/暂不可读）。 */
  const scanFileChunk = async (fact: FileFact, maxBytes: number): Promise<number> => {
    const opened = await openSessionNoFollowAsync(fact.path);
    if (!opened) return 0;
    const { handle, fact: fresh } = opened;
    try {
      let entry = state.files[fact.path];
      if (entry !== undefined && (entry.dev !== fresh.dev || entry.ino !== fresh.ino || fresh.size < entry.scannedTo)) {
        entry = undefined; // 身份变化/收缩 ⇒ 连 bucket 一起丢弃，从 0 重扫（无双算）
        markDirty();
      }
      if (entry === undefined) {
        entry = {
          dev: fresh.dev,
          ino: fresh.ino,
          size: fresh.size,
          mtimeMs: fresh.mtimeMs,
          scannedTo: 0,
          buckets: {},
        };
        state.files[fact.path] = entry;
      } else if (entry.size !== fresh.size || entry.mtimeMs !== fresh.mtimeMs) {
        entry.size = fresh.size;
        entry.mtimeMs = fresh.mtimeMs;
      }
      const startAt = entry.scannedTo;
      if (startAt >= fresh.size || maxBytes <= 0) return 0;
      const want = Math.min(maxBytes, COST_SCAN_CHUNK_BYTES, fresh.size - startAt);
      if (want <= 0) return 0;
      if (scratch === undefined) scratch = Buffer.allocUnsafeSlow(COST_SCAN_CHUNK_BYTES);
      const n = await readAt(handle, scratch, want, startAt);
      if (n <= 0) return 0;
      readBytesTotal += n;
      const window = scratch.subarray(0, n);
      const lastNl = window.lastIndexOf(0x0a);
      if (lastNl < 0) return n; // 本块无完整行——下轮从 scannedTo 重读（有界空转）
      let off = 0;
      while (off <= lastNl) {
        const nl = window.indexOf(0x0a, off);
        if (nl < 0 || nl > lastNl) break;
        const line = window.subarray(off, nl).toString("utf8");
        off = nl + 1;
        processLine(line, entry);
      }
      entry.scannedTo = startAt + lastNl + 1;
      return n;
    } finally {
      await handle.close().catch(() => {});
    }
  };

  // -------------------------------------------------------------------------
  // 目录枚举（有界分帧；稳态轻量探测）
  // -------------------------------------------------------------------------

  /** 同步 root 一层目录列表：新目录入 enumPending，消失目录清 facts/pending。 */
  const refreshDirs = (dirents: Dirent[]): void => {
    const found: string[] = [];
    for (const d of dirents) {
      if (d.isDirectory()) found.push(d.name);
    }
    found.sort();
    const foundSet = new Set(found);
    if (enumPending === undefined) {
      enumPending = new Set(found);
    } else {
      for (const name of [...enumPending]) {
        if (!foundSet.has(name)) enumPending.delete(name);
      }
      for (const name of found) {
        if (!dirSet.has(name)) enumPending.add(name);
      }
    }
    for (const old of dirNames) {
      if (foundSet.has(old)) continue;
      const prefix = join(root, old) + sep;
      for (const p of [...factMap.keys()]) {
        if (p.startsWith(prefix)) factMap.delete(p);
      }
      dirMtimes.delete(old);
    }
    if (pendingNames !== undefined && !foundSet.has(pendingNames.dir)) pendingNames = undefined;
    dirNames = found;
    dirSet = foundSet;
    if (dirCursor >= dirNames.length) dirCursor = 0;
    if (rollCursor >= dirNames.length) rollCursor = 0;
  };

  /** 已知最新 mtime 文件所属的项目目录（活跃项目优先枚举/探测）。 */
  const hottestDirName = (): string | undefined => {
    let best: string | undefined;
    let bestMtime = -1;
    for (const fact of factMap.values()) {
      if (fact.mtimeMs > bestMtime) {
        bestMtime = fact.mtimeMs;
        best = fact.dirName;
      }
    }
    return best;
  };

  /**
   * 枚举一个项目目录的 *.jsonl（分帧：lstat 超预算 ⇒ pendingNames 断点，下一 pass 续）。
   * 完成 ⇒ 清掉该目录已消失文件的 fact、记录目录 mtime、从 enumPending 移除。
   */
  const enumDir = async (name: string, budgetLeft: { stats: number }, timeUp: () => boolean): Promise<boolean> => {
    const dirPath = join(root, name);
    let names: string[];
    let next = 0;
    if (pendingNames !== undefined && pendingNames.dir === name) {
      names = pendingNames.names;
      next = pendingNames.next;
    } else {
      let dirents: Dirent[];
      try {
        dirents = await readdir(dirPath, { withFileTypes: true });
      } catch {
        // 目录竞态消失/不可读 ⇒ 视为已处理（无事实可枚举）。
        enumPending?.delete(name);
        if (pendingNames?.dir === name) pendingNames = undefined;
        return true;
      }
      names = [];
      for (const d of dirents) {
        if (d.isFile() && d.name.endsWith(".jsonl")) names.push(d.name);
      }
    }
    while (next < names.length) {
      if (budgetLeft.stats <= 0 || timeUp()) {
        pendingNames = { dir: name, names, next };
        return false;
      }
      budgetLeft.stats--;
      const fn = names[next];
      next++;
      if (fn === undefined) continue;
      const path = join(dirPath, fn);
      try {
        const st = await lstat(path);
        if (st.isFile()) {
          factMap.set(path, { path, dirName: name, dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs });
        } else {
          factMap.delete(path);
        }
      } catch {
        factMap.delete(path); // 竞态消失——不 track
      }
    }
    pendingNames = undefined;
    enumPending?.delete(name);
    // 清掉该目录下已消失文件的 fact（state.files 里已删文件的条目保留——费用历史不丢，
    // 与单目录时代语义一致；complete 判定只看 facts，不受残留条目影响）。
    const keep = new Set(names);
    const prefix = dirPath + sep;
    for (const p of [...factMap.keys()]) {
      if (p.startsWith(prefix) && !keep.has(basename(p))) factMap.delete(p);
    }
    try {
      const st = await lstat(dirPath);
      dirMtimes.set(name, st.mtimeMs);
    } catch {
      dirMtimes.delete(name);
    }
    return true;
  };

  /**
   * 枚举相位。未收敛（有 pending 目录）⇒ 全量分帧推进（断点目录 → 热目录 → 轮转）；
   * 已收敛 ⇒ 轻量探测（目录 mtime 变化才重枚举 + 48h 活跃文件抽 stat + 滚动补枚举）。
   */
  const enumerateSome = async (passDeadline: number): Promise<void> => {
    const budgetLeft = { stats: enumStatsCap };
    // 时间片下限 10ms：ms=0 的 pass（如只靠持久化游标的零预算场景）也要能推进枚举，
    // 否则 timeUp 立即为真 ⇒ pendingNames 永远断点 ⇒ 永不收敛。
    const enumDeadline = Math.max(Math.min(passDeadline, Date.now() + COST_SCAN_ENUM_MS_CAP), Date.now() + 10);
    const timeUp = () => Date.now() >= enumDeadline;
    const sweepDone = enumPending !== undefined && enumPending.size === 0 && pendingNames === undefined;

    if (!sweepDone) {
      // ---- 全量分帧（首回填 / 新目录出现）：只推进未枚举过的目录（已 swept 目录的
      // 刷新是稳态相位的职责，避免热目录每 pass 重复全量 lstat 饿死轮转）。
      const order: string[] = [];
      if (pendingNames !== undefined && dirSet.has(pendingNames.dir)) order.push(pendingNames.dir);
      const hot = hottestDirName();
      if (hot !== undefined && enumPending?.has(hot) === true && !order.includes(hot)) order.push(hot);
      for (let i = 0; i < dirNames.length; i++) {
        const name = dirNames[(dirCursor + i) % dirNames.length];
        if (name !== undefined && enumPending?.has(name) === true && !order.includes(name)) order.push(name);
      }
      let rrFinished = 0;
      for (const name of order) {
        if (budgetLeft.stats <= 0 || timeUp()) break;
        const isRr = name !== pendingNames?.dir && name !== hot;
        const finished = await enumDir(name, budgetLeft, timeUp);
        if (!finished) break; // 预算耗尽在该目录内断点
        if (isRr) rrFinished++;
      }
      if (rrFinished > 0 && dirNames.length > 0) dirCursor = (dirCursor + rrFinished) % dirNames.length;
      return;
    }

    // ---- 稳态轻量探测 ----
    // (a) 目录 mtime 探测：文件增删 ⇒ 目录 mtime 变 ⇒ 重枚举该目录（append 不动目录 mtime，
    //     由 (b) 覆盖）。预算内逐个 lstat。
    const changed: string[] = [];
    for (const name of dirNames) {
      if (budgetLeft.stats <= 0 || timeUp()) break;
      budgetLeft.stats--;
      try {
        const st = await lstat(join(root, name));
        if (dirMtimes.get(name) !== st.mtimeMs) {
          dirMtimes.set(name, st.mtimeMs);
          changed.push(name);
        }
      } catch {
        dirMtimes.delete(name);
      }
    }
    // (b) 48h 内活跃的已跟踪文件抽 stat（最新优先）：发现 append 增长/身份变化。
    const recentCutoff = Date.now() - 48 * 3_600_000;
    const recent: FileFact[] = [];
    for (const fact of factMap.values()) {
      if (fact.mtimeMs >= recentCutoff) recent.push(fact);
    }
    recent.sort((a, b) => b.mtimeMs - a.mtimeMs);
    let recentStat = 0;
    for (const fact of recent) {
      if (recentStat >= COST_SCAN_ENUM_RECENT_FILES || budgetLeft.stats <= 0 || timeUp()) break;
      recentStat++;
      budgetLeft.stats--;
      try {
        const st = await lstat(fact.path);
        if (st.isFile()) {
          factMap.set(fact.path, {
            path: fact.path,
            dirName: fact.dirName,
            dev: st.dev,
            ino: st.ino,
            size: st.size,
            mtimeMs: st.mtimeMs,
          });
        } else {
          factMap.delete(fact.path);
        }
      } catch {
        factMap.delete(fact.path);
      }
    }
    // (c) 变化目录 + 滚动补枚举（自愈漏网：如唤醒沉睡会话——其缓存 mtime 太旧不在 (b)，
    //     目录 mtime 也不动 ⇒ 最迟 目录数/ROLL 个 idle pass 后被重新枚举）。
    const order = [...changed];
    for (let i = 0; i < Math.min(COST_SCAN_ENUM_ROLL_DIRS, dirNames.length); i++) {
      const name = dirNames[(rollCursor + i) % dirNames.length];
      if (name !== undefined && !order.includes(name)) order.push(name);
    }
    let rolled = 0;
    for (const name of order) {
      if (budgetLeft.stats <= 0 || timeUp()) break;
      const isRoll = !changed.includes(name);
      const finished = await enumDir(name, budgetLeft, timeUp);
      if (!finished) {
        // 滚动/变化目录内断点 ⇒ 视为重新进入未收敛（pendingNames 续扫；enumPending 不动，
        // 下一 pass 走全量分支的断点续枚举路径——sweepDone 因 pendingNames !== undefined 翻 false）。
        break;
      }
      if (isRoll) rolled++;
    }
    if (rolled > 0 && dirNames.length > 0) rollCursor = (rollCursor + rolled) % dirNames.length;
  };

  const isPending = (fact: FileFact): boolean => {
    if (evictedPaths.has(fact.path)) return false; // 被淘汰 ⇒ 本进程不再重扫（防抖动）
    const entry = state.files[fact.path];
    if (entry === undefined) return true;
    if (entry.dev !== fact.dev || entry.ino !== fact.ino) return true;
    if (fact.size < entry.scannedTo) return true;
    return entry.scannedTo < fact.size;
  };

  const advance = async (): Promise<void> => {
    if (!loaded) {
      try {
        const parsed: unknown = JSON.parse(await readFile(options.statePath, "utf8"));
        if (isRecord(parsed)) state = parseState(parsed[STATE_GROUP], root);
        loaded = true; // 读成功才标记 loaded
        markDirty();
      } catch (error) {
        // ENOENT ⇒ 明确不存在 ⇒ 空态且不再重试读；其它读取/解析失败（EACCES/EIO/损坏）⇒
        // 保持 loaded=false，下个 pass 重试（状态文件由同文件其它 store 或后续 flush 修复/创建）。
        if (isErrno(error, "ENOENT")) loaded = true;
      }
    }
    const ms = Number.isFinite(budget.ms) ? Math.max(0, Math.floor(budget.ms)) : 0;
    const totalBytes = Number.isFinite(budget.bytes) ? Math.max(0, Math.floor(budget.bytes)) : 0;
    const deadline = Date.now() + ms;
    const bytesLeft = { n: totalBytes };
    const timeUp = () => Date.now() >= deadline;

    let rootDirents: Dirent[];
    try {
      rootDirents = await readdir(root, { withFileTypes: true });
    } catch {
      lastComplete = false;
      lastScannedFiles = 0;
      lastTotalFiles = 0;
      return;
    }
    refreshDirs(rootDirents);
    await enumerateSome(deadline);

    const facts = [...factMap.values()];
    facts.sort((a, b) => b.mtimeMs - a.mtimeMs); // 最新优先
    let capacity = evictedPaths.size > 0;
    let tracked = facts;
    if (facts.length > COST_SCAN_TRACKED_FILES_MAX) {
      tracked = facts.slice(0, COST_SCAN_TRACKED_FILES_MAX);
      capacity = true;
    }

    const processed = new Set<string>();
    let dirty = false;

    // Lane ① — 48h 窗口内 mtime 的活跃文件（最新优先），≤ 一半 byte 预算。
    const lane1Cap = Math.floor(totalBytes / 2);
    let lane1Used = 0;
    const recentCutoff = Date.now() - 48 * 3_600_000;
    for (const fact of tracked) {
      if (lane1Used >= lane1Cap || bytesLeft.n <= 0 || timeUp()) break;
      if (fact.mtimeMs < recentCutoff) break; // 已按最新排序
      processed.add(fact.path);
      if (!isPending(fact)) continue;
      const allow = Math.min(COST_SCAN_CHUNK_BYTES, lane1Cap - lane1Used, bytesLeft.n);
      if (allow <= 0) break;
      const before = state.files[fact.path]?.scannedTo;
      const n = await scanFileChunk(fact, allow);
      if (state.files[fact.path]?.scannedTo !== before) dirty = true;
      lane1Used += n;
      bytesLeft.n -= n;
    }

    // Lane ② — round-robin 游标扫全量（path 排序跨目录字典序 ⇒ 轮转天然公平，游标后起步，wrap 一次）。
    if (tracked.length > 0) {
      const sorted = tracked.map((f) => f.path).sort();
      const factByPath = new Map(tracked.map((f) => [f.path, f] as const));
      let start = 0;
      if (state.cursor !== "") {
        const idx = sorted.findIndex((p) => p > state.cursor);
        start = idx < 0 ? 0 : idx;
      }
      for (let i = 0; i < sorted.length; i++) {
        if (bytesLeft.n <= 0 || timeUp()) break;
        const path = sorted[(start + i) % sorted.length];
        if (path === undefined) continue;
        state.cursor = path; // 即使没扫完也前移——不饿死
        if (processed.has(path)) continue;
        const fact = factByPath.get(path);
        if (fact === undefined || !isPending(fact)) continue;
        const before = state.files[fact.path]?.scannedTo;
        const n = await scanFileChunk(fact, Math.min(COST_SCAN_CHUNK_BYTES, bytesLeft.n));
        if (state.files[fact.path]?.scannedTo !== before) dirty = true;
        processed.add(path);
        bytesLeft.n -= n;
      }
    }

    // 完成度与进度：首轮枚举完成，且所有 tracked 文件游标到位且身份一致、未触发容量上限。
    const sweepDone = enumPending !== undefined && enumPending.size === 0 && pendingNames === undefined;
    let complete = sweepDone && !capacity;
    let scanned = 0;
    for (const fact of tracked) {
      const entry = state.files[fact.path];
      if (
        entry !== undefined &&
        !evictedPaths.has(fact.path) &&
        entry.dev === fact.dev &&
        entry.ino === fact.ino &&
        entry.scannedTo === fact.size
      ) {
        scanned++;
      } else {
        complete = false;
      }
    }
    lastComplete = complete;
    lastScannedFiles = scanned;
    lastTotalFiles = tracked.length;

    if (dirty && !disposed) {
      try {
        const evicted = await flushState(options.statePath, state, options.now(), stateMaxBytes);
        if (evicted.length > 0) {
          for (const p of evicted) evictedPaths.add(p);
          markDirty(); // 淘汰动了 buckets ⇒ 聚合缓存作废
          safeWarn(`[quota] cost-scan state over ${stateMaxBytes} bytes; evicted ${evicted.length} file entr(ies)`);
        }
      } catch (error) {
        safeWarn(
          `[quota] failed to persist cost-scan state to ${options.statePath}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  };

  return {
    async advance(): Promise<void> {
      if (disposed) return;
      try {
        await advance();
      } catch (error) {
        safeWarn(`[quota] cost-scan pass failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    view() {
      const buckets = aggregate();
      const scannedFiles = lastScannedFiles;
      const totalFiles = lastTotalFiles;
      const complete = lastComplete;
      const readBytes = readBytesTotal;
      return {
        complete,
        scannedFiles,
        totalFiles,
        readBytes,
        costInWindow(provider, startMs, endMs) {
          const hours = buckets.get(provider);
          if (hours === undefined || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
            return undefined;
          }
          let usd = 0;
          let unpriced = 0;
          let any = false;
          for (const [hour, pair] of hours) {
            const hourStart = hour * HOUR_MS;
            if (hourStart + HOUR_MS > startMs && hourStart < endMs) {
              usd += pair[0];
              unpriced += pair[1];
              any = true;
            }
          }
          return any ? { usd, unpriced: unpriced > 0 } : undefined;
        },
      };
    },
    maybeAdvance() {
      if (disposed || inflight) return;
      const t = options.now();
      if (t < nextAt) return;
      inflight = true;
      nextAt = t + (lastComplete ? idleMs : busyMs);
      void advance()
        .catch((error) => {
          safeWarn(`[quota] cost-scan pass failed: ${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => {
          inflight = false;
        });
    },
    dispose() {
      disposed = true;
    },
  };
}
