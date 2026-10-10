import {
  LOAD_MOUNT_RING_MAX_SLOTS,
  LOAD_RECOVERY_MARGIN,
  type LoadDiskMountSample,
  type LoadDiskPathSample,
  type LoadLevel,
  type LoadSample,
  type LoadThresholds,
  type LoadTransition,
  type LoadVerdict,
  type MetricState,
} from "./types.js";
import type { LoadSettings } from "../config/settings.js";

export interface LoadTracker {
  observe(sample: LoadSample): LoadTransition;
  verdict(now?: number, at?: number): LoadVerdict;
  reset(): void;
}

interface InternalMetric {
  level: LoadLevel;
  windowStart: number | undefined;
  lastValid: number | undefined;
  previousValid: number | undefined;
  direction: "up" | "down" | undefined;
  windowTarget: LoadLevel | undefined;
  mountIdentity: string | undefined;
  broken: boolean;
}

const rank = (level: LoadLevel): number => (level === "unknown" ? -1 : level === "ok" ? 0 : level === "warn" ? 1 : 2);
const levelOfRank = (value: number): LoadLevel => (value >= 2 ? "crit" : value >= 1 ? "warn" : "ok");
const knownState = (metric: InternalMetric): MetricState => ({
  level: metric.level,
  ...(metric.windowStart === undefined ? {} : { windowStartMono: metric.windowStart }),
  ...(metric.lastValid === undefined ? {} : { lastValidMono: metric.lastValid }),
});
const validFinite = (value: number): boolean => Number.isFinite(value);
const effectiveGate = (settings: LoadSettings, level: LoadLevel): boolean =>
  settings.enabled && settings.gate && level !== "unknown" && rank(level) >= rank(settings.gateLevel);

function cpuRaw(sample: LoadSample, thresholds: LoadThresholds): LoadLevel | undefined {
  if (sample.cpu.kind !== "ok") return undefined;
  const cpu = sample.cpu.value;
  if (
    !validFinite(cpu.busyPct) ||
    cpu.busyPct < 0 ||
    cpu.busyPct > 100 ||
    !Number.isInteger(cpu.cores) ||
    cpu.cores <= 0 ||
    (cpu.psiPct !== undefined && (!validFinite(cpu.psiPct) || cpu.psiPct < 0 || cpu.psiPct > 100))
  )
    return undefined;
  if (
    cpu.busyPct >= thresholds.cpu.critPercent ||
    (cpu.psiPct !== undefined && cpu.psiPct >= thresholds.cpu.psiCritPercent)
  )
    return "crit";
  if (
    cpu.busyPct >= thresholds.cpu.warnPercent ||
    (cpu.psiPct !== undefined && cpu.psiPct >= thresholds.cpu.psiWarnPercent)
  )
    return "warn";
  return "ok";
}

function memRaw(sample: LoadSample, thresholds: LoadThresholds): LoadLevel | undefined {
  if (sample.mem.kind !== "ok") return undefined;
  const mem = sample.mem.value;
  if (
    !validFinite(mem.availPct) ||
    !validFinite(mem.usedPct) ||
    mem.availPct < 0 ||
    mem.availPct > 100 ||
    mem.usedPct < 0 ||
    mem.usedPct > 100 ||
    Math.abs(mem.usedPct - (100 - mem.availPct)) > 0.01
  )
    return undefined;
  if (mem.availPct <= thresholds.mem.critAvailPercent) return "crit";
  if (mem.availPct <= thresholds.mem.warnAvailPercent) return "warn";
  return "ok";
}

function diskRaw(reading: LoadDiskPathSample["reading"], thresholds: LoadThresholds): LoadLevel | undefined {
  if (reading.kind !== "ok") return undefined;
  const disk = reading.value;
  const impossible =
    !validFinite(disk.freePct) ||
    !validFinite(disk.freeBytes) ||
    !validFinite(disk.totalBytes) ||
    disk.freePct < 0 ||
    disk.freePct > 100 ||
    disk.freeBytes < 0 ||
    disk.totalBytes <= 0 ||
    disk.freeBytes > disk.totalBytes;
  if (impossible) return undefined;
  if (disk.freePct <= thresholds.disk.critFreePercent || disk.freeBytes <= thresholds.disk.critFreeGiB * 2 ** 30)
    return "crit";
  if (disk.freePct <= thresholds.disk.warnFreePercent) return "warn";
  return "ok";
}

function clearPredicate(
  kind: "cpu" | "mem" | "disk",
  level: LoadLevel,
  value: unknown,
  thresholds: LoadThresholds,
): boolean {
  if (kind === "cpu") {
    const cpu = value as { busyPct: number; psiPct?: number };
    return (
      cpu.busyPct <
        thresholds.cpu[rank(level) >= 2 ? "critPercent" : "warnPercent"] - LOAD_RECOVERY_MARGIN.cpuPercent &&
      (cpu.psiPct === undefined ||
        cpu.psiPct <
          thresholds.cpu[rank(level) >= 2 ? "psiCritPercent" : "psiWarnPercent"] - LOAD_RECOVERY_MARGIN.cpuPercent)
    );
  }
  if (kind === "mem") {
    const mem = value as { availPct: number };
    return (
      mem.availPct >
      thresholds.mem[rank(level) >= 2 ? "critAvailPercent" : "warnAvailPercent"] + LOAD_RECOVERY_MARGIN.memPercent
    );
  }
  const disk = value as LoadDiskMountSample;
  const percentLevel = rank(level) >= 2 ? thresholds.disk.critFreePercent : thresholds.disk.warnFreePercent;
  const bytesClear =
    rank(level) < 2 || disk.freeBytes > thresholds.disk.critFreeGiB * 2 ** 30 + LOAD_RECOVERY_MARGIN.diskBytes;
  return disk.freePct > percentLevel + LOAD_RECOVERY_MARGIN.diskPercent && bytesClear;
}

function advanceMetric(
  metric: InternalMetric,
  raw: LoadLevel | undefined,
  value: unknown,
  mono: number,
  settings: LoadSettings,
  kind: "cpu" | "mem" | "disk",
  identity?: string,
): { recovered: boolean } {
  if (raw === undefined || !Number.isFinite(mono)) {
    metric.windowStart = undefined;
    metric.direction = undefined;
    metric.windowTarget = undefined;
    metric.broken = true;
    return { recovered: false };
  }
  if (metric.lastValid !== undefined && mono - metric.lastValid > settings.sampleIntervalMs * 3) {
    metric.level = "unknown";
    metric.windowStart = undefined;
    metric.direction = undefined;
    metric.windowTarget = undefined;
  }
  const identityChanged = kind === "disk" && metric.mountIdentity !== undefined && metric.mountIdentity !== identity;
  if (identity !== undefined) metric.mountIdentity = identity;
  const gap = metric.lastValid === undefined ? false : mono - metric.lastValid > settings.sampleIntervalMs * 2;
  const continuityBroken =
    metric.broken || identityChanged || gap || (metric.previousValid !== undefined && mono < metric.previousValid);
  if (continuityBroken) {
    metric.windowStart = undefined;
    metric.direction = undefined;
    metric.windowTarget = undefined;
  }
  metric.broken = false;
  metric.previousValid = metric.lastValid;
  metric.lastValid = mono;

  const currentRank = rank(metric.level);
  const rawRank = rank(raw);
  let target: LoadLevel | undefined;
  if (metric.level === "unknown") {
    if (rawRank >= 1) target = raw;
    else target = "ok";
  } else if (rawRank > currentRank) {
    target = raw;
  } else if (rawRank < currentRank && clearPredicate(kind, metric.level, value, settingsToThresholds(settings))) {
    target = levelOfRank(currentRank - 1);
  } else {
    metric.windowStart = undefined;
    metric.direction = undefined;
    metric.windowTarget = undefined;
    return { recovered: false };
  }

  const direction = rank(target) > currentRank ? "up" : "down";
  if (metric.direction !== direction || metric.windowStart === undefined || metric.windowTarget !== target) {
    metric.direction = direction;
    metric.windowTarget = target;
    metric.windowStart = mono;
  }
  const elapsed = mono - metric.windowStart;
  const duration = direction === "up" ? settings.sustainMs : settings.recoverMs;
  if (elapsed >= duration || duration === 0) {
    metric.level = target;
    metric.windowStart = undefined;
    metric.direction = undefined;
    metric.windowTarget = undefined;
    return {
      recovered:
        direction === "down" && currentRank >= rank(settings.gateLevel) && rank(target) < rank(settings.gateLevel),
    };
  }
  return { recovered: false };
}

function settingsToThresholds(settings: LoadSettings): LoadThresholds {
  return { cpu: settings.cpu, mem: settings.mem, disk: settings.disk };
}

function staleLevel(metric: InternalMetric, now: number, interval: number): LoadLevel {
  return metric.lastValid === undefined || !Number.isFinite(now) || now - metric.lastValid > interval * 3
    ? "unknown"
    : metric.level;
}

export function createLoadTracker(
  settings: LoadSettings,
  mono: () => number = () => performance.now(),
  wall: () => number = () => Date.now(),
): LoadTracker {
  const cpu: InternalMetric = {
    level: "unknown",
    windowStart: undefined,
    lastValid: undefined,
    previousValid: undefined,
    direction: undefined,
    windowTarget: undefined,
    mountIdentity: undefined,
    broken: false,
  };
  const mem: InternalMetric = {
    level: "unknown",
    windowStart: undefined,
    lastValid: undefined,
    previousValid: undefined,
    direction: undefined,
    windowTarget: undefined,
    mountIdentity: undefined,
    broken: false,
  };
  const disks = new Map<string, InternalMetric>();
  let lastGating = false;
  let lastOverall: LoadLevel = "unknown";

  const verdict = (now = mono(), at = wall()): LoadVerdict => {
    const cpuLevel = staleLevel(cpu, now, settings.sampleIntervalMs);
    const memLevel = staleLevel(mem, now, settings.sampleIntervalMs);
    const diskStates = [...disks.entries()].map(([label, metric]) => ({
      label: label as "~" | "/",
      state: { ...knownState(metric), level: staleLevel(metric, now, settings.sampleIntervalMs) },
    }));
    const levels = [cpuLevel, memLevel, ...diskStates.map((d) => d.state.level)].filter((level) => level !== "unknown");
    const overall = levels.length === 0 ? "unknown" : levels.sort((a, b) => rank(b) - rank(a))[0]!;
    return {
      level: overall,
      gating: effectiveGate(settings, overall),
      metrics: {
        cpu: { ...knownState(cpu), level: cpuLevel },
        mem: { ...knownState(mem), level: memLevel },
        disk: diskStates,
      },
      mono: now,
      at,
    };
  };

  return {
    observe(sample: LoadSample): LoadTransition {
      const before = verdict(sample.mono, sample.at);
      const cpuResult =
        sample.cpu.kind === "ok"
          ? advanceMetric(
              cpu,
              cpuRaw(sample, settingsToThresholds(settings)),
              sample.cpu.value,
              sample.mono,
              settings,
              "cpu",
            )
          : advanceMetric(cpu, undefined, undefined, sample.mono, settings, "cpu");
      const memResult =
        sample.mem.kind === "ok"
          ? advanceMetric(
              mem,
              memRaw(sample, settingsToThresholds(settings)),
              sample.mem.value,
              sample.mono,
              settings,
              "mem",
            )
          : advanceMetric(mem, undefined, undefined, sample.mono, settings, "mem");
      let diskRecovered = false;
      const seen = new Set<string>();
      for (const path of sample.disks.slice(0, LOAD_MOUNT_RING_MAX_SLOTS)) {
        seen.add(path.label);
        const metric = disks.get(path.label) ?? {
          level: "unknown" as LoadLevel,
          windowStart: undefined,
          lastValid: undefined,
          previousValid: undefined,
          direction: undefined,
          windowTarget: undefined,
          mountIdentity: undefined,
          broken: false,
        };
        if (path.reading.kind === "ok") {
          const value = path.reading.value;
          diskRecovered =
            advanceMetric(
              metric,
              diskRaw(path.reading, settingsToThresholds(settings)),
              value,
              sample.mono,
              settings,
              "disk",
              `${value.mountId}:${value.dev}`,
            ).recovered || diskRecovered;
        } else {
          diskRecovered =
            advanceMetric(metric, undefined, undefined, sample.mono, settings, "disk").recovered || diskRecovered;
        }
        disks.set(path.label, metric);
      }
      for (const [label, metric] of disks) {
        if (!seen.has(label)) {
          metric.windowStart = undefined;
          metric.direction = undefined;
          metric.windowTarget = undefined;
          metric.broken = true;
        }
      }
      const after = verdict(sample.mono, sample.at);
      const gateCleared = before.gating && !after.gating;
      const provenRecovered =
        (cpuResult.recovered || memResult.recovered || diskRecovered) &&
        rank(after.level) < rank(settings.gateLevel) &&
        after.level !== "unknown";
      const escalatedTo =
        rank(after.level) > rank(before.level) && (after.level === "warn" || after.level === "crit")
          ? after.level
          : undefined;
      lastGating = after.gating;
      lastOverall = after.level;
      void lastGating;
      void lastOverall;
      return { gateCleared, provenRecovered, ...(escalatedTo === undefined ? {} : { escalatedTo }) };
    },
    verdict,
    reset(): void {
      cpu.level = "unknown";
      cpu.windowStart = undefined;
      cpu.lastValid = undefined;
      cpu.previousValid = undefined;
      cpu.direction = undefined;
      cpu.windowTarget = undefined;
      cpu.broken = false;
      mem.level = "unknown";
      mem.windowStart = undefined;
      mem.lastValid = undefined;
      mem.previousValid = undefined;
      mem.direction = undefined;
      mem.windowTarget = undefined;
      mem.broken = false;
      disks.clear();
    },
  };
}

export function levelRank(level: LoadLevel): number {
  return rank(level);
}

/** Short alias used by pi-free callers and tests. */
export const createTracker = createLoadTracker;
