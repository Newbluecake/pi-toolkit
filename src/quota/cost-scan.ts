/**
 * quota 面板「按 API 价格折算费用」（2026-11-03 用户拍板，形态 B：折算挂在窗口重置文案旁
 * `22:06 重置 · ≈$12.30`，不新增行、HUD 不加、无设置门）的增量扫描器。pi-free。
 *
 * 主源 = pi 会话 JSONL 增量扫描：`<agentDir>/sessions/<编码cwd>/*.jsonl` 的 assistant
 * 条目自带 provider/model/timestamp + usage.cost.total（pi 已按目录价算好）。主会话与
 * 子会话文件同目录，全部计入——子用量只写在子文件里，天然无双算。
 *
 * 增量游标（有界范式抄 `src/session-nav/provenance.ts`）：按文件 byte offset 推进
 * （append-only 安全），单 pass ≤ budget.ms / budget.bytes（默认 250ms / 16MiB），文件
 * 打开走 `openSessionNoFollowAsync`（O_NOFOLLOW；顺序扫 ⇒ ≤1 fd）。与 provenance 的关键
 * 差异：bucket 按**文件**归属（cursor 里每文件存自己的 hour→[cost,unpriced]）——文件身份
 * 变化（dev/ino 变或 shrink）⇒ 丢弃该文件的 bucket 并从 0 重扫，永不双算；代价是序列化
 * 体积略大（有 8 MiB 状态上限 + 最旧 mtime 淘汰兜底）。
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
 * 文件损坏 / dir 不匹配 ⇒ 视为空态重扫。
 *
 * 驱动：无 timer（I5 平凡满足）——`maybeAdvance()` 由 web-hub agent 的 1Hz tick 调用，
 * 内部节流（incomplete 2s / complete 15s）+ single-flight；webHub 关闭 ⇒ 无人调用 ⇒ 零 I/O
 * （I9）。惰性加载：首次 advance 才读状态文件与目录。`view()` 同步、永不抛。
 */

import { lstat, mkdir, open as openAsync, readFile, readdir, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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

/** 扫描器的同步只读视图（projection / fingerprint 用）。 */
export interface QuotaCostView {
  /** 所有 tracked 文件游标均已推进到当前 size（且未触发容量上限）。 */
  readonly complete: boolean;
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
  /** `<agentDir>/sessions/<编码cwd>`（生产侧 = ctx.sessionManager.getSessionDir()）。 */
  readonly sessionDir: string;
  /** quota-state.json（与 demotion/baseline store 同文件，读改写保留其它组）。 */
  readonly statePath: string;
  readonly priceLookup: CostScanPriceLookup;
  readonly now: () => Millis;
  /** 单 pass 上限；默认 250ms / 16 MiB。 */
  readonly budget?: { ms: number; bytes: number };
  /** 扫描未收敛时的最小 pass 间隔（默认 2s）。 */
  readonly busyIntervalMs?: number;
  /** 已收敛后的最小 pass 间隔（默认 15s）。 */
  readonly idleIntervalMs?: number;
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
/** 状态文件序列化上限；超出 ⇒ 淘汰最旧 mtime 的文件条目直到放下。 */
export const COST_SCAN_STATE_MAX_BYTES = 8 * 1024 * 1024;
/** hour bucket 保鲜：比最长窗口（month=30d）+ 余量更旧的 bucket 在落盘时丢弃。 */
export const COST_BUCKET_RETENTION_MS = 40 * 24 * 3_600_000;
export const DEFAULT_COST_SCAN_BUDGET = { ms: 250, bytes: 16 * 1024 * 1024 };

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
  /** 游标按目录归属；dir 变化 ⇒ 整组作废重扫。 */
  dir: string;
  /** lane ② round-robin 游标（最后一个访问的 path）。 */
  cursor: string;
  files: Record<string, CostFileState>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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

/** 读改写纪律：flush 前重读文件，保留同文件其它 store 的顶层键（version/demotions/baselines…）。 */
async function flushState(statePath: string, state: CostScanState, now: Millis): Promise<void> {
  // bucket 保鲜 + 状态体积上限（淘汰最旧 mtime）。
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
  let payload = `${JSON.stringify({ ...extras, [STATE_GROUP]: state }, null, 2)}\n`;
  while (Buffer.byteLength(payload, "utf8") > COST_SCAN_STATE_MAX_BYTES) {
    let oldest: string | undefined;
    let oldestMtime = Infinity;
    for (const [path, entry] of Object.entries(state.files)) {
      if (entry.mtimeMs < oldestMtime) {
        oldestMtime = entry.mtimeMs;
        oldest = path;
      }
    }
    if (oldest === undefined) return;
    delete state.files[oldest];
    payload = `${JSON.stringify({ ...extras, [STATE_GROUP]: state }, null, 2)}\n`;
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
}

// ---------------------------------------------------------------------------
// scanner
// ---------------------------------------------------------------------------

interface FileFact {
  path: string;
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
  const dir = resolve(options.sessionDir);
  const budget = options.budget ?? DEFAULT_COST_SCAN_BUDGET;
  const busyMs = options.busyIntervalMs ?? 2_000;
  const idleMs = options.idleIntervalMs ?? 15_000;

  let loaded = false;
  let state = emptyState(dir);
  let disposed = false;
  let inflight = false;
  let nextAt = 0;
  let lastComplete = false;
  let warnedFail = false;
  /** 聚合缓存（view 热路径）：任何 bucket/文件变动 ⇒ dirty。 */
  let aggDirty = true;
  let agg = new Map<string, Map<number, [number, number]>>();

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

  const enumerateFacts = async (): Promise<FileFact[] | undefined> => {
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    const facts: FileFact[] = [];
    for (const dirent of dirents) {
      if (!dirent.name.endsWith(".jsonl") || !dirent.isFile()) continue;
      const path = resolve(join(dir, dirent.name));
      try {
        const st = await lstat(path);
        if (st.isFile()) facts.push({ path, dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        /* 竞态消失——不 track */
      }
    }
    return facts;
  };

  const isPending = (fact: FileFact): boolean => {
    const entry = state.files[fact.path];
    if (entry === undefined) return true;
    if (entry.dev !== fact.dev || entry.ino !== fact.ino) return true;
    if (fact.size < entry.scannedTo) return true;
    return entry.scannedTo < fact.size;
  };

  const advance = async (): Promise<void> => {
    if (!loaded) {
      loaded = true;
      try {
        const parsed: unknown = JSON.parse(await readFile(options.statePath, "utf8"));
        if (isRecord(parsed)) state = parseState(parsed[STATE_GROUP], dir);
        markDirty();
      } catch {
        // 不存在 / 损坏 ⇒ 空态重扫。
      }
    }
    const ms = Number.isFinite(budget.ms) ? Math.max(0, Math.floor(budget.ms)) : 0;
    const totalBytes = Number.isFinite(budget.bytes) ? Math.max(0, Math.floor(budget.bytes)) : 0;
    const deadline = Date.now() + ms;
    const bytesLeft = { n: totalBytes };
    const timeUp = () => Date.now() >= deadline;

    const facts = await enumerateFacts();
    if (facts === undefined) {
      lastComplete = false;
      return;
    }
    facts.sort((a, b) => b.mtimeMs - a.mtimeMs); // 最新优先
    let capacity = false;
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

    // Lane ② — round-robin 游标扫全量（path 排序，游标后起步，wrap 一次）。
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

    // 完成度：所有 tracked 文件游标到位且身份一致、未触发容量上限。
    let complete = !capacity;
    if (complete) {
      for (const fact of tracked) {
        const entry = state.files[fact.path];
        if (entry === undefined || entry.dev !== fact.dev || entry.ino !== fact.ino || entry.scannedTo !== fact.size) {
          complete = false;
          break;
        }
      }
    }
    lastComplete = complete;

    if (dirty && !disposed) {
      try {
        await flushState(options.statePath, state, options.now());
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
      return {
        complete: lastComplete,
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
