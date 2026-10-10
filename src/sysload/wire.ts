import { topUnitsAvailable } from "./top.js";
import type { LoadGateWire, LoadTopWire, LoadWire } from "../web-hub/protocol/messages.js";
import type { LoadSettings } from "../config/settings.js";
import type { LoadSample, LoadVerdict } from "./types.js";
import type { TopSnapshot } from "./types.js";

const finiteElapsed = (value: number): number | undefined =>
  Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;

export function projectLoadWire(
  verdict: LoadVerdict,
  settings: LoadSettings,
  now = verdict.mono,
  at = verdict.at,
  sample?: LoadSample,
): LoadWire {
  const sinceAgoMs = finiteElapsed(now - verdict.mono);
  const disks = verdict.metrics.disk.slice(0, 2).map((disk) => {
    const reading = sample?.disks.find((candidate) => candidate.label === disk.label)?.reading;
    const value = reading?.kind === "ok" ? reading.value : undefined;
    return {
      label: disk.label,
      path: value?.mountPath ?? (disk.label === "~" ? "~" : "/"),
      usedPct: value === undefined ? 0 : Math.max(0, Math.min(100, 100 - value.freePct)),
      freeBytes: value?.freeBytes ?? 0,
      totalBytes: value?.totalBytes ?? 0,
      level: disk.state.level,
      ...(reading?.kind === "skipped"
        ? { skipped: "remote" as const }
        : reading?.kind === "unresolved"
          ? { skipped: "unresolved" as const }
          : {}),
    };
  });
  const ioPsiPct = (sample as (LoadSample & { ioPsiPct?: number }) | undefined)?.ioPsiPct;
  return {
    v: 1,
    at,
    ...(sinceAgoMs === undefined ? {} : { sinceAgoMs }),
    intervalMs: settings.sampleIntervalMs,
    scope: "host",
    ...(ioPsiPct === undefined ? {} : { io: { psiPct: ioPsiPct } }),
    level: verdict.level,
    thresholds: {
      cpu: {
        warnPercent: settings.cpu.warnPercent,
        critPercent: settings.cpu.critPercent,
        psiWarnPercent: settings.cpu.psiWarnPercent,
        psiCritPercent: settings.cpu.psiCritPercent,
      },
      mem: { warnAvailPercent: settings.mem.warnAvailPercent, critAvailPercent: settings.mem.critAvailPercent },
      disk: {
        warnFreePercent: settings.disk.warnFreePercent,
        critFreePercent: settings.disk.critFreePercent,
        critFreeGiB: settings.disk.critFreeGiB,
      },
    },
    ...(disks.length > 0 ? { disks } : {}),
    ...(sample?.cpu.kind === "ok"
      ? {
          cpu: {
            busyPct: sample.cpu.value.busyPct,
            ...(sample.cpu.value.psiPct === undefined ? {} : { psiPct: sample.cpu.value.psiPct }),
            level: verdict.metrics.cpu.level,
            cores: sample.cpu.value.cores,
          },
        }
      : {}),
    ...(sample?.mem.kind === "ok"
      ? {
          mem: {
            availPct: sample.mem.value.availPct,
            usedPct: sample.mem.value.usedPct,
            level: verdict.metrics.mem.level,
          },
        }
      : {}),
    ...(sample?.loadavg === undefined ? {} : { loadavg: [...sample.loadavg] as [number, number, number] }),
  };
}

export function projectLoadGate(verdict: LoadVerdict, sinceAgoMs?: number, at = Date.now()): LoadGateWire {
  const elapsed = sinceAgoMs === undefined ? undefined : finiteElapsed(sinceAgoMs);
  return {
    gating: verdict.gating,
    level: verdict.level,
    ...(elapsed === undefined ? {} : { sinceAgoMs: elapsed }),
    at,
  };
}

export function projectTop(snapshot: TopSnapshot | undefined): LoadTopWire | undefined {
  if (snapshot === undefined) return undefined;
  const projectPid = (pid: TopSnapshot["byCpu"][number]["pids"][number]) => ({
    pid: pid.pid,
    ...(topUnitsAvailable(snapshot) ? { cpuPct: pid.cpuPct, rssBytes: pid.rssBytes } : {}),
  });
  const projectRow = (row: TopSnapshot["byCpu"][number]) => ({
    comm: row.comm,
    count: row.count,
    ...(topUnitsAvailable(snapshot) ? { cpuPct: row.cpuPct, rssBytes: row.rssBytes } : {}),
    ...(row.avg ? { avg: true as const } : {}),
    pids: row.pids.slice(0, 8).map(projectPid),
  });
  return {
    at: snapshot.at,
    ...(snapshot.partial ? { partial: true as const } : {}),
    byCpu: snapshot.byCpu.slice(0, 5).map(projectRow),
    byRss: snapshot.byRss.slice(0, 5).map(projectRow),
  };
}

export function loadFingerprint(wire: LoadWire): string {
  const { at: _at, sinceAgoMs: _since, ...stable } = wire;
  return JSON.stringify(stable);
}

export const toLoadWire = projectLoadWire;
export const toLoadGateWire = projectLoadGate;
export const fingerprintLoad = loadFingerprint;
