import { promises as fsPromises, openSync, readSync, closeSync } from "node:fs";
import { IoLedger } from "./io-ledger.js";
import { parseAuxv, parsePidStat, parsePidStatm, type PidStat, type PidStatm } from "./procfs.js";
import type { LoadTopPid, LoadTopRow, TopSnapshot } from "./types.js";

/** Local enrichment: the P0 numeric domain remains frozen; the wire drops n/a values. */
export type TopScanSnapshot = TopSnapshot & { readonly unitsAvailable: boolean };
export const topUnitsAvailable = (snapshot: TopSnapshot): boolean =>
  (snapshot as Partial<TopScanSnapshot>).unitsAvailable !== false;

export interface TopSampleProcess {
  readonly pid: number;
  readonly comm: string;
  readonly utime: number;
  readonly stime: number;
  readonly starttime: number;
  readonly rssPages: number;
  readonly lifetimeSeconds?: number;
}

export interface TopPrevious {
  readonly mono: number;
  readonly processes: ReadonlyMap<number, { starttime: number; cpuTicks: number }>;
}

export interface TopUnits {
  readonly userHz: number;
  readonly pageSize: number;
}

export interface TopScanOptions {
  readonly now?: () => number;
  readonly deadlineMs?: number;
  readonly maxPids?: number;
  readonly previous?: TopPrevious;
  readonly units?: TopUnits | null;
  readonly isCurrent?: () => boolean;
  readonly readFile?: (path: string) => Promise<string | Buffer>;
  readonly openProc?: () => Promise<{
    read: () => Promise<{ readonly name: string } | null>;
    close: () => Promise<void>;
  }>;
  /** Receives the current pid table after a scan, including only pids seen in this scan. */
  readonly onPrevious?: (previous: TopPrevious) => void;
}

const cleanComm = (value: string): string => value.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 128) || "?";

export function readAuxvBounded(path = "/proc/self/auxv"): TopUnits | undefined {
  try {
    const fd = openSync(path, "r");
    const buffer = Buffer.alloc(4097);
    let length: number;
    try {
      length = readSync(fd, buffer, 0, buffer.length, 0);
    } finally {
      closeSync(fd);
    }
    if (length > 4096) return undefined;
    const bytes = buffer.subarray(0, length);
    return readTopUnits(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  } catch {
    return undefined;
  }
}

export function readTopUnits(auxv: Uint8Array | string | undefined): TopUnits | undefined {
  if (auxv === undefined) return undefined;
  const values = parseAuxv(auxv);
  const userHz = values.get(17); // AT_CLKTCK
  const pageSize = values.get(6); // AT_PAGESZ
  return userHz !== undefined && pageSize !== undefined && userHz > 0 && pageSize > 0
    ? { userHz, pageSize }
    : undefined;
}

export function aggregateTop(
  processes: readonly TopSampleProcess[],
  previous: TopPrevious | undefined,
  now: number,
  units?: TopUnits,
): TopScanSnapshot {
  const elapsed = previous === undefined ? 0 : Math.max(0, (now - previous.mono) / 1000);
  const byPid = new Map<number, LoadTopPid & { avg?: true }>();
  for (const process of processes) {
    const ticks = process.utime + process.stime;
    const old = previous?.processes.get(process.pid);
    const sameLife = old !== undefined && old.starttime === process.starttime;
    const cpuPct =
      units === undefined
        ? 0
        : sameLife && elapsed > 0
          ? (Math.max(0, ticks - old.cpuTicks) / units.userHz / elapsed) * 100
          : process.lifetimeSeconds !== undefined && process.lifetimeSeconds > 0
            ? (ticks / units.userHz / process.lifetimeSeconds) * 100
            : 0;
    const avg = !sameLife || units === undefined;
    byPid.set(process.pid, {
      pid: process.pid,
      cpuPct,
      rssBytes: units === undefined ? 0 : process.rssPages * units.pageSize,
      ...(avg ? { avg: true } : {}),
    });
  }
  const groups = new Map<string, { pids: (LoadTopPid & { avg?: true })[] }>();
  for (const process of processes) {
    const group = groups.get(cleanComm(process.comm)) ?? { pids: [] };
    const pid = byPid.get(process.pid);
    if (pid !== undefined) group.pids.push(pid);
    groups.set(cleanComm(process.comm), group);
  }
  const rows: LoadTopRow[] = [...groups].map(([comm, group]) => {
    const pids = group.pids;
    const avg = pids.some((pid) => pid.avg === true);
    return {
      comm,
      count: pids.length,
      cpuPct: pids.reduce((sum, pid) => sum + pid.cpuPct, 0),
      rssBytes: pids.reduce((sum, pid) => sum + pid.rssBytes, 0),
      ...(avg ? { avg: true as const } : {}),
      pids: [...pids]
        .sort((a, b) => b.cpuPct - a.cpuPct || a.pid - b.pid)
        .slice(0, 8)
        .map(({ avg: _avg, ...pid }) => pid),
    };
  });
  const byCpu = [...rows]
    .sort((a, b) => b.cpuPct - a.cpuPct || b.rssBytes - a.rssBytes || a.comm.localeCompare(b.comm))
    .slice(0, 5);
  const byRss = [...rows]
    .sort((a, b) => b.rssBytes - a.rssBytes || b.cpuPct - a.cpuPct || a.comm.localeCompare(b.comm))
    .slice(0, 5);
  return { at: Date.now(), unitsAvailable: units !== undefined, byCpu, byRss };
}

export async function scanTop(
  ledger: IoLedger = new IoLedger(),
  options: TopScanOptions = {},
): Promise<TopScanSnapshot> {
  const now = options.now ?? (() => performance.now());
  const started = now();
  const deadline = options.deadlineMs ?? 300;
  const maxPids = Math.min(2048, options.maxPids ?? 2048);
  const readFile =
    options.readFile ??
    (async (path: string) => {
      const file = await fsPromises.open(path, "r");
      try {
        const buffer = Buffer.alloc(4096);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        return buffer.subarray(0, bytesRead).toString("utf8");
      } finally {
        await file.close();
      }
    });
  const openProc = options.openProc ?? (() => fsPromises.opendir("/proc"));
  const processes: TopSampleProcess[] = [];
  const entries: string[] = [];
  const units = options.units === null ? undefined : (options.units ?? readAuxvBounded());
  let uptimeSeconds: number | undefined;
  const scanLease = ledger.tryAcquire("top");
  if (scanLease === undefined)
    return { at: Date.now(), unitsAvailable: units !== undefined, partial: true, byCpu: [], byRss: [] };
  const pending: Promise<unknown>[] = [];
  let partial = false;
  const remaining = (): number => (options.isCurrent?.() === false ? 0 : Math.max(0, deadline - (now() - started)));
  const waitBounded = async <T>(promise: Promise<T>): Promise<T | undefined> => {
    pending.push(promise.catch(() => undefined));
    const left = remaining();
    if (left <= 0) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        promise,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), left);
          timer.unref();
        }),
      ]);
      return remaining() > 0 ? result : undefined;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  const readTracked = (path: string): Promise<string | Buffer> => {
    const operation = readFile(path);
    pending.push(operation.catch(() => undefined));
    return operation;
  };
  try {
    if (units !== undefined && remaining() > 0) {
      try {
        const uptimeText = await waitBounded(readTracked("/proc/uptime"));
        const parsed =
          uptimeText === undefined
            ? undefined
            : Number(
                (typeof uptimeText === "string" ? uptimeText : uptimeText.toString("utf8")).trim().split(/\s+/, 1)[0],
              );
        if (parsed !== undefined && Number.isFinite(parsed) && parsed >= 0) uptimeSeconds = parsed;
      } catch {
        partial = true;
      }
    }
    if (remaining() > 0) {
      // This lifecycle promise owns opendir/read/close, including closes after a late
      // open/read. The outer lease is released only when this lifecycle really settles.
      const enumeration = (async () => {
        const dir = await openProc();
        try {
          while (remaining() > 0 && entries.length < maxPids) {
            const entry = await dir.read();
            if (remaining() <= 0) {
              partial = true;
              break;
            }
            if (entry === null) break;
            if (/^\d+$/.test(entry.name)) entries.push(entry.name);
          }
          if (remaining() <= 0 || entries.length >= maxPids) partial = true;
        } finally {
          await dir.close();
        }
      })();
      try {
        if ((await waitBounded(enumeration.then(() => true))) === undefined) partial = true;
      } catch {
        partial = true;
      }
    }
    for (const pid of entries) {
      if (remaining() <= 0) {
        partial = true;
        break;
      }
      let statText: string | Buffer | undefined;
      try {
        statText = await waitBounded(readTracked(`/proc/${pid}/stat`));
      } catch {
        partial = true;
        continue;
      }
      if (statText === undefined) {
        partial = true;
        continue;
      }
      if (remaining() <= 0) {
        partial = true;
        break;
      }
      let statmText: string | Buffer | undefined;
      try {
        statmText = await waitBounded(readTracked(`/proc/${pid}/statm`));
      } catch {
        partial = true;
        continue;
      }
      if (statmText === undefined) {
        partial = true;
        continue;
      }
      const stat = parsePidStat(typeof statText === "string" ? statText : statText.toString("utf8"));
      const statm = parsePidStatm(typeof statmText === "string" ? statmText : statmText.toString("utf8"));
      if (stat !== undefined && statm !== undefined) processes.push(toProcess(stat, statm, uptimeSeconds, units));
    }
  } catch {
    partial = true;
  } finally {
    const previous = new Map<number, { starttime: number; cpuTicks: number }>();
    for (const process of processes) {
      previous.set(process.pid, { starttime: process.starttime, cpuTicks: process.utime + process.stime });
    }
    if (options.isCurrent?.() !== false) options.onPrevious?.({ mono: now(), processes: previous });
    // Keep the global `top` slot reserved until every operation really settles.
    void Promise.allSettled(pending).then(() => scanLease.release());
  }
  const snapshot = aggregateTop(processes, options.previous, now(), units);
  return partial ? { ...snapshot, partial: true } : snapshot;
}

function toProcess(stat: PidStat, statm: PidStatm, uptimeSeconds?: number, units?: TopUnits): TopSampleProcess {
  return {
    pid: stat.pid,
    comm: stat.comm,
    utime: stat.utime,
    stime: stat.stime,
    starttime: stat.starttime,
    rssPages: statm.residentPages,
    ...(uptimeSeconds === undefined || units === undefined
      ? {}
      : { lifetimeSeconds: uptimeSeconds - stat.starttime / units.userHz }),
  };
}
