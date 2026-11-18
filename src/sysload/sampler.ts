import { readFileSync, promises as fsPromises } from "node:fs";
import { homedir } from "node:os";
import { IoLedger, withIoLease } from "./io-ledger.js";
import { resolveMount, type ResolvedMount } from "./mounts.js";
import {
  parseLoadavg,
  parseMeminfo,
  parseMountinfo,
  parsePressure,
  parseProcCpu,
  type ProcCpuCounters,
} from "./procfs.js";
import type { LoadDiskPathSample, LoadSample } from "./types.js";
import type { LoadSettings } from "../config/settings.js";

export interface StatFsLike {
  readonly bavail: bigint | number;
  readonly bfree: bigint | number;
  readonly blocks: bigint | number;
  readonly bsize: bigint | number;
  readonly dev?: bigint | number;
}

// ── C0:BEGIN ── sampler.ts（S1 声明；S0 结构满足；零运行时 import）
export interface SamplerHostMount {
  // = MountInfoRecord 的字段集（host 解析器须填满：root:"/"、optionalFields:[]、superOptions:[]、mountId:0、majorMinor:"0:0" 占位）
  mountId: number;
  parentId: number;
  majorMinor: string;
  root: string;
  mountPoint: string;
  mountOptions: readonly string[];
  optionalFields: readonly string[];
  fstype: string;
  source: string;
  superOptions: readonly string[];
}
export interface SamplerHostReading {
  // 任一字段缺失 ⇔ 该项本拍不可用（互相独立）
  loadavg?: readonly [number, number, number];
  memAvailPct?: number; // kern.memorystatus_level，整数 0..100
  cores?: number; // hw.ncpu，正整数
}
export interface HostProcess {
  pid: number;
  comm: string;
  cpuPct: number;
  rssBytes: number;
}
/** 所有带 timeoutMs 的方法：调用方保证 timeoutMs 为有限正数；host 收到非有限/≤0 的值**不得启动进程**，直接 resolve undefined。 */
export interface SamplerHost {
  readonly kind: "darwin";
  readonly localFilesystems: ReadonlySet<string>; // 替代 mounts.ts 的 Linux LOCAL_FILESYSTEMS
  readHost(opts: { timeoutMs: number }): Promise<SamplerHostReading | undefined>; // 永不 throw/reject
  readMounts(opts: { timeoutMs: number }): Promise<string | undefined>; // 原始 mount(8) 文本 ≤1 MiB；永不 throw
  parseMounts(text: string): readonly SamplerHostMount[]; // 同步纯函数
  deviceOf(path: string): Promise<number | undefined>; // fs.stat().dev；失败 ⇒ undefined；永不 throw
  listProcesses(opts: {
    timeoutMs: number;
    maxPids: number;
  }): Promise<{ procs: readonly HostProcess[]; truncated: boolean } | undefined>;
}
export interface SamplerIo {
  readonly readFileSync?: (path: string, options?: { encoding?: "utf8"; flag?: string }) => string | Buffer;
  readonly readFile?: (path: string) => Promise<string | Buffer>;
  readonly realpath?: (path: string) => Promise<string>;
  readonly statfs?: (path: string, options?: { bigint?: boolean }) => Promise<StatFsLike>;
  readonly host?: SamplerHost; // 追加
}
// ── C0:END ──

export interface SamplerPlan {
  readonly home?: string;
  readonly cwd?: string;
  readonly previousCpu?: ProcCpuCounters;
  readonly previousMono?: number;
  readonly generation?: number;
  readonly expectedGeneration?: () => number;
  readonly mono?: () => number;
  readonly at?: () => number;
  readonly mountinfoText?: string;
  readonly realpathCache?: Map<string, { path: string; at: number }>;
}

export interface SampleResult {
  readonly sample: LoadSample & { readonly ioPsiPct?: number };
  readonly nextCpu?: ProcCpuCounters;
  readonly mountinfoText?: string;
}

const MAX_PROC_BYTES = 64 * 1024;
const MAX_MOUNTINFO_BYTES = 1024 * 1024;

/** darwin-plan §2.9（Q3 拍板）：darwin 的 mem 读数（kern.memorystatus_level）只展示、不进 gate。
 * 样本携带 `memAdvisory:true`、tracker 只记显示值。翻转启用 gate 是后续独立决策（D1），
 * 决策记录出现前禁止改回 false。Linux 样本永不携带该标记。 */
export const DARWIN_MEM_ADVISORY = true;
/** darwin-plan §2.3 hostBounded 步骤 1：host 调用前的最小剩余预算（ms）——预算不足不取租约、不启动进程。 */
export const HOST_MIN_BUDGET_MS = 50;
/** darwin-plan §2.3 hostBounded 步骤 2：单次 host 调用的超时上限（ms）；内部常量，不属 C0 契约。 */
const HOST_MAX_TIMEOUT_MS = 800;

const finite = (n: number): boolean => Number.isFinite(n);
const asNumber = (value: bigint | number): number => (typeof value === "bigint" ? Number(value) : value);

function boundedRead(path: string, io: SamplerIo): string | undefined {
  try {
    const value = (io.readFileSync ?? ((p) => readFileSync(p, { encoding: "utf8" })))(path, { encoding: "utf8" });
    const text = typeof value === "string" ? value : value.toString("utf8");
    const max = path.includes("mountinfo") ? MAX_MOUNTINFO_BYTES : MAX_PROC_BYTES;
    return Buffer.byteLength(text) <= max ? text : undefined;
  } catch {
    return undefined;
  }
}

function cpuSample(
  text: string | undefined,
  previous: ProcCpuCounters | undefined,
  previousMono: number | undefined,
  mono: number,
): { value?: { busyPct: number; cores: number }; next?: ProcCpuCounters } {
  const entries = text === undefined ? [] : parseProcCpu(text);
  const current = entries.find((entry) => entry.name === "cpu");
  if (current === undefined) return {};
  const cores = Math.max(1, entries.filter((entry) => /^cpu\d+$/.test(entry.name)).length);
  if (previous === undefined || previousMono === undefined || mono <= previousMono) return { next: current };
  const totalDelta = current.total - previous.total;
  const idleDelta = current.idleAll - previous.idleAll;
  if (totalDelta <= 0 || idleDelta < 0 || idleDelta > totalDelta || !finite(totalDelta) || !finite(idleDelta))
    return { next: current };
  const busyPct = Math.max(0, Math.min(100, ((totalDelta - idleDelta) / totalDelta) * 100));
  return { value: { busyPct, cores }, next: current };
}

async function beforeDeadline<T>(operation: Promise<T>, left: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (left <= 0) {
      void operation.catch(() => undefined);
      return undefined;
    }
    return await Promise.race([
      operation,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), left);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function resolvePath(
  path: string,
  ledger: IoLedger,
  io: SamplerIo,
  cache: Map<string, { path: string; at: number }>,
  mono: number,
  left: () => number,
  isCurrent: () => boolean,
): Promise<string | undefined> {
  if (path === "/") return "/";
  const cached = cache.get(path);
  if (cached !== undefined && mono - cached.at <= 60_000) return cached.path;
  if (left() <= 0) return undefined;
  const result = withIoLease(ledger, `rp:${path}`, () => (io.realpath ?? ((p) => fsPromises.realpath(p)))(path));
  if (result === undefined) return undefined;
  try {
    const resolved = await beforeDeadline(result, left());
    if (resolved !== undefined && isCurrent() && left() > 0) cache.set(path, { path: resolved, at: mono });
    else return undefined;
    return resolved;
  } catch {
    return undefined;
  }
}

/** darwin-plan §2.3 `hostBounded`：所有 host 调用的共用闸门。
 * 1. 预算/代际检查在取租约**之前**⇒ 预算耗尽不取租约、不启动进程；
 * 2. 预算取**单次快照**（S1 评审 Major 1：连续两次读 left() 会跨界——第二次可能跌破 50 甚至 ≤0
 *    仍取租约/调 host），快照须为有限值且 ≥HOST_MIN_BUDGET_MS，timeoutMs 由同一快照计算，
 *    必为 ≥HOST_MIN_BUDGET_MS 的有限正整数（≤HOST_MAX_TIMEOUT_MS）；
 * 3. 租约由 withIoLease 在底层 promise 真正 settle 后释放；
 * 4. beforeDeadline 只结束等待（该拍记缺失），不取消进程；返回后 !isCurrent() ⇒ 丢弃。 */
async function hostBounded<T>(
  kind: string,
  ledger: IoLedger,
  left: () => number,
  isCurrent: () => boolean,
  op: (timeoutMs: number) => Promise<T>,
): Promise<T | undefined> {
  if (!isCurrent()) return undefined;
  const budget = left();
  if (!Number.isFinite(budget) || budget < HOST_MIN_BUDGET_MS) return undefined;
  const timeoutMs = Math.floor(Math.min(HOST_MAX_TIMEOUT_MS, budget));
  const operation = withIoLease(ledger, `host:${kind}`, () => op(timeoutMs));
  if (operation === undefined) return undefined;
  try {
    const result = await beforeDeadline(operation, left());
    return isCurrent() ? result : undefined;
  } catch {
    return undefined;
  }
}

async function statMount(
  label: "~" | "/",
  path: string,
  resolved: ResolvedMount,
  ledger: IoLedger,
  io: SamplerIo,
  left: () => number,
  isCurrent: () => boolean,
): Promise<LoadDiskPathSample> {
  if (resolved.mount === undefined || resolved.skipped !== undefined)
    return { label, reading: resolved.skipped ? { kind: "skipped", reason: "remote" } : { kind: "unresolved" } };
  if (left() <= 0) return { label, reading: { kind: "invalid" } };
  const statfs: NonNullable<SamplerIo["statfs"]> = io.statfs ?? ((p: string) => fsPromises.statfs(p, { bigint: true }));
  const op = withIoLease(ledger, `statfs:${resolved.mount.mountId}:${resolved.mount.majorMinor}`, () =>
    statfs(path, { bigint: true }),
  );
  if (op === undefined) return { label, reading: { kind: "invalid" } };
  try {
    const stat = await beforeDeadline(op, left());
    if (stat === undefined || !isCurrent() || left() <= 0) return { label, reading: { kind: "invalid" } };
    const blocks = asNumber(stat.blocks);
    const bavail = asNumber(stat.bavail);
    const bfree = asNumber(stat.bfree);
    const bsize = asNumber(stat.bsize);
    const denominator = blocks - bfree + bavail;
    if (
      ![blocks, bavail, bfree, bsize, denominator].every(finite) ||
      blocks <= 0 ||
      bavail < 0 ||
      bavail > blocks ||
      bfree < bavail ||
      bsize <= 0 ||
      denominator <= 0
    )
      return { label, reading: { kind: "invalid" } };
    const freeBytes = bavail * bsize;
    const totalBytes = blocks * bsize;
    const freePct = (100 * bavail) / denominator;
    if (![freeBytes, totalBytes, freePct].every(finite) || freePct < 0 || freePct > 100)
      return { label, reading: { kind: "invalid" } };
    return {
      label,
      reading: {
        kind: "ok",
        value: {
          mountPath: resolved.mount.mountPoint,
          freePct,
          freeBytes,
          totalBytes,
          mountId: resolved.mount.mountId,
          dev: resolved.mount.majorMinor,
        },
      },
    };
  } catch {
    return { label, reading: { kind: "invalid" } };
  }
}

export async function sampleOnce(
  io: SamplerIo = {},
  plan: SamplerPlan = {},
  ledger: IoLedger = new IoLedger(),
  generation = 0,
  settings?: LoadSettings,
): Promise<SampleResult> {
  const mono = plan.mono?.() ?? (typeof performance !== "undefined" ? performance.now() : Date.now());
  const at = plan.at?.() ?? Date.now();
  const deadline = performance.now() + 1_000;
  const left = (): number => Math.max(0, deadline - performance.now());
  const isCurrent = (): boolean => plan.expectedGeneration === undefined || plan.expectedGeneration() === generation;
  const read = (path: string): string | undefined => boundedRead(path, io);
  const host = io.host;
  const reading =
    host === undefined
      ? undefined
      : await hostBounded("sysctl", ledger, left, isCurrent, (timeoutMs) => host.readHost({ timeoutMs }));
  const cpuText = host === undefined ? read("/proc/stat") : undefined;
  const parsedCpu = cpuSample(cpuText, plan.previousCpu, plan.previousMono, mono);
  const pressure = host === undefined ? parsePressure(read("/proc/pressure/cpu") ?? "") : undefined;
  const cpu =
    parsedCpu.value === undefined
      ? { kind: "invalid" as const }
      : {
          kind: "ok" as const,
          value: { ...parsedCpu.value, ...(pressure?.someAvg10 === undefined ? {} : { psiPct: pressure.someAvg10 }) },
        };
  const mem = host === undefined ? parseMeminfo(read("/proc/meminfo") ?? "") : undefined;
  const memory =
    host === undefined
      ? mem === undefined
        ? { kind: "invalid" as const }
        : {
            kind: "ok" as const,
            value: {
              availPct: (100 * mem.memAvailableKiB!) / mem.memTotalKiB,
              usedPct: 100 - (100 * mem.memAvailableKiB!) / mem.memTotalKiB,
            },
          }
      : reading?.memAvailPct === undefined
        ? { kind: "invalid" as const }
        : {
            kind: "ok" as const,
            value: { availPct: reading.memAvailPct, usedPct: 100 - reading.memAvailPct },
          };
  const loadavg = host === undefined ? parseLoadavg(read("/proc/loadavg") ?? "")?.values : reading?.loadavg;
  const home = plan.home ?? homedir();
  // P0 freezes two display paths (HOME and root); cwd is intentionally not sampled.
  const mountText =
    plan.mountinfoText ??
    (host === undefined
      ? read("/proc/self/mountinfo")
      : await hostBounded("mount", ledger, left, isCurrent, (timeoutMs) => host.readMounts({ timeoutMs })));
  const parsedMounts =
    mountText === undefined ? [] : host === undefined ? parseMountinfo(mountText) : host.parseMounts(mountText);
  const diskPaths: readonly ["~" | "/", string][] = [
    ["~", home],
    ["/", "/"],
  ];
  const cache = plan.realpathCache ?? new Map<string, { path: string; at: number }>();
  const disks: LoadDiskPathSample[] = [];
  // P0's two display paths frequently live on the SAME mount (HOME on the root fs): show the
  // mount once. Identity = mountId + majorMinor (types.ts §5.2's continuity identity), so a
  // path resolving to the same mount is dropped entirely — no duplicate display, no duplicate
  // statfs ledger slot. `~` is kept as the representative (the more meaningful label).
  const seenMounts = new Set<string>();
  for (const [label, path] of diskPaths) {
    const resolvedPath = await resolvePath(path, ledger, io, cache, mono, left, isCurrent);
    if (resolvedPath === undefined || mountText === undefined) {
      disks.push({ label, reading: { kind: "unresolved" } });
      continue;
    }
    let resolved: ResolvedMount =
      host === undefined
        ? resolveMount(resolvedPath, parsedMounts)
        : resolveMount(resolvedPath, parsedMounts, host.localFilesystems);
    if (host !== undefined && resolved.mount !== undefined && resolved.skipped === undefined) {
      // darwin-plan §2.3 deviceOf 步骤：命中本地挂载后，以 fs.stat().dev 覆盖 mountId/majorMinor。
      if (!isCurrent() || left() < HOST_MIN_BUDGET_MS) {
        disks.push({ label, reading: { kind: "invalid" } });
        continue;
      }
      const dev = await hostBounded(`dev:${resolvedPath}`, ledger, left, isCurrent, () => host.deviceOf(resolvedPath));
      if (dev === undefined) {
        // S1 评审 Minor：区分两种 dev 缺席——代际在调用期间失效 ⇒ 整拍已死 ⇒ invalid（方案步骤 4 口径）；
        // deviceOf 真失败/账本满/等待超期 ⇒ 不能证明挂载身份就不冒充（与 resolvePath 同口径）⇒ unresolved。
        // 两者都绝不调 statfs、不进 seenMounts。
        disks.push({ label, reading: isCurrent() ? { kind: "unresolved" } : { kind: "invalid" } });
        continue;
      }
      if (!isCurrent() || left() <= 0) {
        disks.push({ label, reading: { kind: "invalid" } });
        continue;
      }
      resolved = { ...resolved, mount: { ...resolved.mount, mountId: dev, majorMinor: String(dev) } };
    }
    if (resolved.mount !== undefined && resolved.skipped === undefined) {
      const mountKey = `${resolved.mount.mountId}:${resolved.mount.majorMinor}`;
      if (seenMounts.has(mountKey)) continue;
      seenMounts.add(mountKey);
    }
    disks.push(await statMount(label, resolvedPath, resolved, ledger, io, left, isCurrent));
  }
  const ioPsiPct = host === undefined ? parsePressure(read("/proc/pressure/io") ?? "")?.someAvg10 : undefined;
  const sample: SampleResult["sample"] = {
    mono,
    at,
    cpu,
    mem: memory,
    disks: disks.slice(0, 2),
    ...(loadavg === undefined ? {} : { loadavg }),
    ...(ioPsiPct === undefined ? {} : { ioPsiPct }),
    ...(host !== undefined && reading?.cores !== undefined ? { cores: reading.cores } : {}),
    ...(host !== undefined && DARWIN_MEM_ADVISORY ? { memAdvisory: true } : {}),
  };
  void settings;
  return {
    sample,
    ...(parsedCpu.next === undefined ? {} : { nextCpu: parsedCpu.next }),
    ...(mountText === undefined ? {} : { mountinfoText: mountText }),
  };
}

export function createDefaultSamplerIo(): SamplerIo {
  return {};
}
