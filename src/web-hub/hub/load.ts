/**
 * Hub-side host-load sampler (sysload plan §7.2/§7.3).
 *
 * This module deliberately has no pi imports.  The hub owns one instance for its
 * lifetime; the instance keeps the latest projected frame for new SSE clients and
 * provides a bounded, shared top-process request for both listeners.
 */
import { closeSync, openSync, readSync } from "node:fs";
import { createSegmentedClock, type Clock } from "../../core/clock.js";
import type { LoadSettings } from "../../config/settings.js";
import { IoLedger } from "../../sysload/io-ledger.js";
import { sampleOnce } from "../../sysload/sampler.js";
import { scanTop } from "../../sysload/top.js";
import { createLoadTracker, type LoadTracker } from "../../sysload/tracker.js";
import { loadFingerprint, projectLoadWire, projectTop } from "../../sysload/wire.js";
import type { LoadVerdict } from "../../sysload/types.js";
import type { LoadTopWire, LoadWire } from "../protocol/messages.js";
import type { HubLoadConfig, HubLog } from "./ports.js";

export const LOAD_HUB_CAP = "load.v1";
export const LOAD_TOP_CACHE_MS = 2_000;
export const LOAD_TOP_WAITERS_MAX = 8;
/** Scan-only budget (loopback's deadline and the LAN scan phase's fair share, below). Never the
 * LAN request's own total/auth budget — see `LOAD_TOP_LAN_TOTAL_MS`. */
export const LOAD_TOP_DEADLINE_MS = 1_500;
/** web-hub-load LAN-budget fix: the LAN branch's own total admission window, mirroring the
 * ~8s total request budgets `preview`/`worktree-diff` use for their LAN GETs (`PREVIEW_AUTH_RESERVE_MS`
 * / `WTDIFF_AUTH_RESERVE_MS` both carve a `LAN_AUTH_CAP_MS`-capped (3s) auth budget out of an 8s
 * total). Before this constant existed, the LAN branch derived its auth budget straight from the
 * 1.5s scan-only `LOAD_TOP_DEADLINE_MS` (`deriveBudget(1500, 3000, 500)` = 1000ms) — far tighter
 * than every other LAN GET endpoint. LAN auth is an IPC round-trip to the separate sqlite-backed
 * auth store (unlike loopback's synchronous in-process cookie check), so on a real system under
 * load that round-trip regularly exceeded 1000ms while comfortably finishing in 1-3s, making the
 * on-demand "Top 进程" panel fail every time (503 `E_DB`) on LAN while loopback (and the SSE-pushed
 * snapshot, whose auth path carries no deadline at all) kept working. */
export const LOAD_TOP_LAN_TOTAL_MS = 8_000;

export interface HubLoadService {
  latest(): LoadWire | undefined;
  top(): Promise<LoadTopWire>;
  dispose(): Promise<void>;
}

export interface HubLoadDeps {
  home: string;
  now?: () => number;
  mono?: () => number;
  log?: HubLog;
  clock?: Clock;
  /** Test seam; production uses the bounded sysload scanner. */
  scanTop?: typeof scanTop;
  /** Called only for fingerprint changes or the 3×interval heartbeat. */
  onWire?: (wire: LoadWire) => void;
}

class LoadRequestError extends Error {
  constructor(readonly code: "E_BUSY" | "E_DEADLINE" | "E_INTERNAL") {
    super(code);
  }
}

function loadSettings(config: HubLoadConfig): LoadSettings {
  return {
    enabled: true,
    gate: false,
    gateLevel: "crit",
    sampleIntervalMs: config.sampleIntervalMs,
    sustainMs: config.sustainMs,
    recoverMs: config.recoverMs,
    cpu: { ...config.thresholds.cpu },
    mem: { ...config.thresholds.mem },
    disk: { ...config.thresholds.disk },
    hint: { enabled: false, display: false, repeatMs: 0, minIntervalMs: 0 },
    hud: false,
  };
}

function asErrorCode(error: unknown): LoadRequestError["code"] {
  if (error instanceof LoadRequestError) return error.code;
  if (error instanceof Error && error.message.includes("E_DEADLINE")) return "E_DEADLINE";
  return "E_INTERNAL";
}

/** A synchronous, bounded startup probe.  A failed probe means no cap and no route. */
export function hubLoadProbe(): boolean {
  if (process.platform !== "linux") return false;
  try {
    const fd = openSync("/proc/stat", "r");
    const buffer = Buffer.alloc(64 * 1024 + 1);
    let length = 0;
    try {
      length = readSync(fd, buffer, 0, buffer.length, 0);
    } finally {
      closeSync(fd);
    }
    if (length > 64 * 1024) return false;
    return /^cpu(?:\s|\d)/m.test(buffer.subarray(0, length).toString("utf8"));
  } catch {
    return false;
  }
}

export function normalizeHubLoadConfig(value: unknown): HubLoadConfig | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const root = value as Record<string, unknown>;
  const cpu =
    root.thresholds !== null && typeof root.thresholds === "object"
      ? (root.thresholds as Record<string, unknown>).cpu
      : undefined;
  const mem =
    root.thresholds !== null && typeof root.thresholds === "object"
      ? (root.thresholds as Record<string, unknown>).mem
      : undefined;
  const disk =
    root.thresholds !== null && typeof root.thresholds === "object"
      ? (root.thresholds as Record<string, unknown>).disk
      : undefined;
  if (!isRecord(root.thresholds) || !isRecord(cpu) || !isRecord(mem) || !isRecord(disk)) return undefined;
  const sampleIntervalMs = finiteInt(root.sampleIntervalMs);
  const sustainMs = finiteInt(root.sustainMs);
  const recoverMs = finiteInt(root.recoverMs);
  if (
    sampleIntervalMs === undefined ||
    sampleIntervalMs < 2_000 ||
    sampleIntervalMs > 60_000 ||
    sustainMs === undefined ||
    sustainMs < 0 ||
    sustainMs > 120 * sampleIntervalMs ||
    recoverMs === undefined ||
    recoverMs < sampleIntervalMs ||
    recoverMs > 120 * sampleIntervalMs
  )
    return undefined;
  const warnPercent = numberField(cpu, "warnPercent");
  const critPercent = numberField(cpu, "critPercent");
  const psiWarnPercent = numberField(cpu, "psiWarnPercent");
  const psiCritPercent = numberField(cpu, "psiCritPercent");
  const warnAvailPercent = numberField(mem, "warnAvailPercent");
  const critAvailPercent = numberField(mem, "critAvailPercent");
  const warnFreePercent = numberField(disk, "warnFreePercent");
  const critFreePercent = numberField(disk, "critFreePercent");
  const critFreeGiB = numberField(disk, "critFreeGiB");
  if (
    warnPercent === undefined ||
    critPercent === undefined ||
    psiWarnPercent === undefined ||
    psiCritPercent === undefined ||
    warnAvailPercent === undefined ||
    critAvailPercent === undefined ||
    warnFreePercent === undefined ||
    critFreePercent === undefined ||
    critFreeGiB === undefined
  )
    return undefined;
  if (
    warnPercent > critPercent ||
    psiWarnPercent > psiCritPercent ||
    warnAvailPercent < critAvailPercent ||
    warnFreePercent < critFreePercent ||
    warnPercent > 100 ||
    critPercent > 100 ||
    psiWarnPercent > 100 ||
    psiCritPercent > 100 ||
    warnAvailPercent > 100 ||
    critAvailPercent > 100 ||
    warnFreePercent > 100 ||
    critFreePercent > 100 ||
    critFreeGiB <= 0
  )
    return undefined;
  return {
    sampleIntervalMs,
    sustainMs,
    recoverMs,
    thresholds: {
      cpu: { warnPercent, critPercent, psiWarnPercent, psiCritPercent },
      mem: { warnAvailPercent, critAvailPercent },
      disk: { warnFreePercent, critFreePercent, critFreeGiB },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) ? value : undefined;
}

function numberField(record: Record<string, unknown>, name: string): number | undefined {
  const value = record[name];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function createHubLoad(config: HubLoadConfig, deps: HubLoadDeps): HubLoadService | undefined {
  const normalized = normalizeHubLoadConfig(config);
  if (normalized === undefined || !hubLoadProbe()) return undefined;
  const mono = deps.mono ?? (() => performance.now());
  const wall = deps.now ?? (() => Date.now());
  const settings = loadSettings(normalized);
  const ledger = new IoLedger();
  const tracker: LoadTracker = createLoadTracker(settings, mono, wall);
  const clock =
    deps.clock ??
    createSegmentedClock({
      now: mono,
      set: (ms, fn) => {
        const timer = setTimeout(fn, ms);
        timer.unref?.();
        return timer;
      },
      clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    });
  let generation = 0;
  let disposed = false;
  let timer: ReturnType<Clock["setTimer"]> | undefined;
  let previousCpu: Awaited<ReturnType<typeof sampleOnce>>["nextCpu"];
  let previousMono: number | undefined;
  let mountinfoText: string | undefined;
  let mountinfoAt = -Infinity;
  const realpathCache = new Map<string, { path: string; at: number }>();
  let latestWire: LoadWire | undefined;
  let latestFingerprint: string | undefined;
  let publishedAt = -Infinity;
  let topCache: LoadTopWire | undefined;
  let topCacheAt = -Infinity;
  let topFlight: Promise<LoadTopWire> | undefined;
  let topWaiters = 0;

  // Overall-level "held since" (LoadCard's 「已持续」): the tracker only keeps per-metric
  // `levelSinceMono`, so the hub anchors the overall level itself — first sample, then every
  // overall-level change. Before this, `sinceAgoMs` was `sample.mono - verdict.mono` ≡ 0.
  let overallLevel: LoadVerdict["level"] | undefined;
  let overallSinceMono = 0;

  const publish = (sample: Awaited<ReturnType<typeof sampleOnce>>["sample"]): void => {
    const verdict = tracker.verdict(sample.mono, sample.at);
    if (verdict.level !== overallLevel) {
      overallLevel = verdict.level;
      overallSinceMono = sample.mono;
    }
    const wire = projectLoadWire(verdict, settings, sample.mono, sample.at, sample, overallSinceMono);
    const fingerprint = loadFingerprint(wire);
    if (latestFingerprint === fingerprint && mono() - publishedAt < normalized.sampleIntervalMs * 3) return;
    latestWire = wire;
    latestFingerprint = fingerprint;
    publishedAt = mono();
    deps.onWire?.(wire);
  };

  const tick = (): void => {
    if (disposed) return;
    const mine = generation;
    const plan = {
      home: deps.home,
      ...(previousCpu === undefined ? {} : { previousCpu }),
      ...(previousMono === undefined ? {} : { previousMono }),
      ...(mountinfoText !== undefined && mono() - mountinfoAt <= 60_000 ? { mountinfoText } : {}),
      realpathCache,
      expectedGeneration: () => generation,
      mono,
      at: wall,
    };
    void sampleOnce({}, plan, ledger, mine, settings)
      .then((result) => {
        if (disposed || mine !== generation) return;
        previousCpu = result.nextCpu;
        previousMono = result.sample.mono;
        if (result.mountinfoText !== undefined) {
          mountinfoText = result.mountinfoText;
          mountinfoAt = result.sample.mono;
        }
        tracker.observe(result.sample);
        publish(result.sample);
      })
      .catch((error: unknown) => deps.log?.warn("web-hub load: sample failed", { error: String(error) }))
      .finally(() => {
        if (!disposed && mine === generation) timer = clock.setTimer(normalized.sampleIntervalMs, tick);
      });
  };

  tick();

  const top = (): Promise<LoadTopWire> => {
    const age = mono() - topCacheAt;
    if (topCache !== undefined && age >= 0 && age < LOAD_TOP_CACHE_MS) return Promise.resolve(topCache);
    if (topFlight !== undefined) {
      if (topWaiters >= LOAD_TOP_WAITERS_MAX) return Promise.reject(new LoadRequestError("E_BUSY"));
      topWaiters++;
      return topFlight.finally(() => {
        topWaiters = Math.max(0, topWaiters - 1);
      });
    }
    const mine = generation;
    topWaiters = 0;
    const scan = (deps.scanTop ?? scanTop)(ledger, {
      now: mono,
      deadlineMs: 1_000,
      isCurrent: () => !disposed && mine === generation,
    })
      .then((snapshot) => {
        if (disposed || mine !== generation) throw new LoadRequestError("E_DEADLINE");
        const wire = projectTop(snapshot);
        if (wire === undefined) throw new LoadRequestError("E_INTERNAL");
        topCache = wire;
        topCacheAt = mono();
        return wire;
      })
      .catch((error: unknown) => {
        const code = asErrorCode(error);
        throw new LoadRequestError(code);
      })
      .finally(() => {
        topFlight = undefined;
      });
    topFlight = scan;
    return scan;
  };

  return {
    latest: () => latestWire,
    top,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      generation++;
      if (timer !== undefined) clock.clearTimer(timer);
      timer = undefined;
      latestWire = undefined;
      realpathCache.clear();
      // Do not await topFlight: scanTop owns all of its IO leases and is generation-fenced.
      topCache = undefined;
      topFlight = undefined;
    },
  };
}

export function loadTopErrorCode(error: unknown): "E_BUSY" | "E_DEADLINE" | "E_INTERNAL" {
  return asErrorCode(error);
}
