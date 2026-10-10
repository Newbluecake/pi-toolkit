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

export interface SamplerIo {
  readonly readFileSync?: (path: string, options?: { encoding?: "utf8"; flag?: string }) => string | Buffer;
  readonly readFile?: (path: string) => Promise<string | Buffer>;
  readonly realpath?: (path: string) => Promise<string>;
  readonly statfs?: (path: string, options?: { bigint?: boolean }) => Promise<StatFsLike>;
}

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
  const statfs = io.statfs ?? ((p: string) => fsPromises.statfs(p, { bigint: true }));
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
  const cpuText = read("/proc/stat");
  const parsedCpu = cpuSample(cpuText, plan.previousCpu, plan.previousMono, mono);
  const pressure = parsePressure(read("/proc/pressure/cpu") ?? "");
  const cpu =
    parsedCpu.value === undefined
      ? { kind: "invalid" as const }
      : {
          kind: "ok" as const,
          value: { ...parsedCpu.value, ...(pressure?.someAvg10 === undefined ? {} : { psiPct: pressure.someAvg10 }) },
        };
  const mem = parseMeminfo(read("/proc/meminfo") ?? "");
  const memory =
    mem === undefined
      ? { kind: "invalid" as const }
      : {
          kind: "ok" as const,
          value: {
            availPct: (100 * mem.memAvailableKiB!) / mem.memTotalKiB,
            usedPct: 100 - (100 * mem.memAvailableKiB!) / mem.memTotalKiB,
          },
        };
  const loadavg = parseLoadavg(read("/proc/loadavg") ?? "")?.values;
  const home = plan.home ?? homedir();
  // P0 freezes two display paths (HOME and root); cwd is intentionally not sampled.
  const mountText = plan.mountinfoText ?? read("/proc/self/mountinfo");
  const parsedMounts = mountText === undefined ? [] : parseMountinfo(mountText);
  const diskPaths: readonly ["~" | "/", string][] = [
    ["~", home],
    ["/", "/"],
  ];
  const cache = plan.realpathCache ?? new Map<string, { path: string; at: number }>();
  const disks: LoadDiskPathSample[] = [];
  for (const [label, path] of diskPaths) {
    const resolvedPath = await resolvePath(path, ledger, io, cache, mono, left, isCurrent);
    if (resolvedPath === undefined || mountText === undefined) {
      disks.push({ label, reading: { kind: "unresolved" } });
      continue;
    }
    const resolved = resolveMount(resolvedPath, parsedMounts);
    disks.push(await statMount(label, resolvedPath, resolved, ledger, io, left, isCurrent));
  }
  const ioPsiPct = parsePressure(read("/proc/pressure/io") ?? "")?.someAvg10;
  const sample: SampleResult["sample"] = {
    mono,
    at,
    cpu,
    mem: memory,
    disks: disks.slice(0, 2),
    ...(loadavg === undefined ? {} : { loadavg }),
    ...(ioPsiPct === undefined ? {} : { ioPsiPct }),
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
