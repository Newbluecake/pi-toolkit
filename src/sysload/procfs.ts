/** Pure, bounded parsers for Linux procfs text used by sysload. */

export interface ProcCpuCounters {
  readonly name: string;
  readonly user: number;
  readonly nice: number;
  readonly system: number;
  readonly idle: number;
  readonly iowait: number;
  readonly irq: number;
  readonly softirq: number;
  readonly steal: number;
  readonly total: number;
  readonly idleAll: number;
}

export interface MeminfoValues {
  readonly memTotalKiB: number;
  readonly memAvailableKiB?: number;
}

export interface PidStat {
  readonly pid: number;
  readonly comm: string;
  readonly state: string;
  readonly utime: number;
  readonly stime: number;
  readonly starttime: number;
}

export interface PidStatm {
  readonly sizePages: number;
  readonly residentPages: number;
}

export interface PressureValues {
  readonly someAvg10?: number;
  readonly fullAvg10?: number;
}

export interface LoadAverages {
  readonly values: readonly [number, number, number];
  readonly running: number;
  readonly total: number;
  readonly lastPid: number;
}

export interface MountInfoRecord {
  readonly mountId: number;
  readonly parentId: number;
  readonly majorMinor: string;
  readonly root: string;
  readonly mountPoint: string;
  readonly mountOptions: readonly string[];
  readonly optionalFields: readonly string[];
  readonly fstype: string;
  readonly source: string;
  readonly superOptions: readonly string[];
}

const finiteNonNegative = (value: number): number | undefined =>
  Number.isFinite(value) && value >= 0 ? value : undefined;

export function parseProcStat(text: string): ProcCpuCounters | undefined {
  const line = text.split(/\r?\n/, 1)[0]?.trim();
  if (line === undefined) return undefined;
  const fields = line.split(/\s+/);
  if (fields.length < 9 || !/^cpu(?:\d+)?$/.test(fields[0] ?? "")) return undefined;
  const numbers = fields.slice(1, 9).map(Number);
  if (numbers.some((n) => finiteNonNegative(n) === undefined)) return undefined;
  const [user, nice, system, idle, iowait, irq, softirq, steal] = numbers as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const total = user + nice + system + idle + iowait + irq + softirq + steal;
  if (!Number.isFinite(total) || total < 0) return undefined;
  return { name: fields[0]!, user, nice, system, idle, iowait, irq, softirq, steal, total, idleAll: idle + iowait };
}

/** Parses all aggregate and per-core lines. The aggregate is first; callers can use cpuN entries for core count. */
export function parseProcCpu(text: string): readonly ProcCpuCounters[] {
  const result: ProcCpuCounters[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!/^cpu(?:\d+)?\s/.test(line)) continue;
    const parsed = parseProcStat(line);
    if (parsed !== undefined) result.push(parsed);
  }
  return result;
}

export function parseMeminfo(text: string): MeminfoValues | undefined {
  let total: number | undefined;
  let available: number | undefined;
  for (const line of text.split(/\r?\n/)) {
    const match = /^(MemTotal|MemAvailable):\s*(\d+)\s*(kB|KB|KiB)?\s*$/.exec(line);
    if (!match) continue;
    const value = Number(match[2]);
    if (!Number.isFinite(value) || value < 0) continue;
    if (match[1] === "MemTotal") total = value;
    else available = value;
  }
  if (total === undefined || total <= 0 || available === undefined || available < 0 || available > total)
    return undefined;
  return { memTotalKiB: total, memAvailableKiB: available };
}

export function parseLoadavg(text: string): LoadAverages | undefined {
  const fields = text.trim().split(/\s+/);
  if (fields.length < 3) return undefined;
  const values = fields.slice(0, 3).map(Number);
  if (values.some((n) => !Number.isFinite(n) || n < 0)) return undefined;
  const running = fields[3]?.split("/").map(Number) ?? [];
  const lastPid = Number(fields[4]);
  if (running.length !== 2 || running.some((n) => !Number.isFinite(n) || n < 0) || !Number.isFinite(lastPid))
    return undefined;
  return { values: values as [number, number, number], running: running[0]!, total: running[1]!, lastPid };
}

export function parsePressure(text: string): PressureValues | undefined {
  let someAvg10: number | undefined;
  let fullAvg10: number | undefined;
  for (const line of text.split(/\r?\n/)) {
    const kind = /^(some|full)\s+/.exec(line)?.[1];
    if (kind === undefined) continue;
    const value = /\bavg10=([^\s]+)/.exec(line)?.[1];
    const number = value === undefined ? undefined : Number(value);
    if (number === undefined || !Number.isFinite(number) || number < 0) continue;
    if (kind === "some") someAvg10 = number;
    else fullAvg10 = number;
  }
  if (someAvg10 === undefined && fullAvg10 === undefined) return undefined;
  return {
    ...(someAvg10 === undefined ? {} : { someAvg10 }),
    ...(fullAvg10 === undefined ? {} : { fullAvg10 }),
  };
}

export function parsePidStat(text: string): PidStat | undefined {
  const line = text.trim();
  const open = line.indexOf("(");
  const close = line.lastIndexOf(")");
  if (open <= 0 || close <= open) return undefined;
  const pid = Number(line.slice(0, open).trim());
  const rest = line
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  // rest[0] is field 3 (state); field 14/15/22 are offsets 11/12/19.
  if (!Number.isInteger(pid) || pid <= 0 || rest.length <= 19) return undefined;
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  const starttime = Number(rest[19]);
  if ([utime, stime, starttime].some((n) => finiteNonNegative(n) === undefined)) return undefined;
  return { pid, comm: line.slice(open + 1, close), state: rest[0]!, utime, stime, starttime };
}

export function parsePidStatm(text: string): PidStatm | undefined {
  const values = text.trim().split(/\s+/).slice(0, 2).map(Number);
  if (values.length !== 2 || values.some((n) => finiteNonNegative(n) === undefined)) return undefined;
  return { sizePages: values[0]!, residentPages: values[1]! };
}

/** `/proc/self/mountinfo` parser; escaped octal is decoded only after tokenization. */
export function parseMountinfo(text: string): readonly MountInfoRecord[] {
  const records: MountInfoRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0) continue;
    const separator = line.indexOf(" - ");
    if (separator < 0) continue;
    const left = line.slice(0, separator).split(" ");
    const right = line.slice(separator + 3).split(" ");
    if (left.length < 6 || right.length < 3) continue;
    const mountId = Number(left[0]);
    const parentId = Number(left[1]);
    if (!Number.isInteger(mountId) || !Number.isInteger(parentId)) continue;
    records.push({
      mountId,
      parentId,
      majorMinor: left[2]!,
      root: decodeMountEscape(left[3]!),
      mountPoint: decodeMountEscape(left[4]!),
      mountOptions: left[5]!.split(","),
      optionalFields: left.slice(6),
      fstype: right[0]!,
      source: decodeMountEscape(right[1]!),
      superOptions: right[2]!.split(","),
    });
  }
  return records;
}

export function decodeMountEscape(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, digits: string) => String.fromCharCode(parseInt(digits, 8)));
}

export function parseAuxv(text: Uint8Array | string): ReadonlyMap<number, number> {
  const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text;
  const result = new Map<number, number>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const word = bytes.byteLength % 16 === 0 ? 8 : 4;
  for (let offset = 0; offset + word * 2 <= bytes.byteLength; offset += word * 2) {
    const type = Number(word === 8 ? view.getBigUint64(offset, true) : view.getUint32(offset, true));
    const value = Number(word === 8 ? view.getBigUint64(offset + word, true) : view.getUint32(offset + word, true));
    if (type === 0) break;
    if (Number.isSafeInteger(type) && Number.isSafeInteger(value)) result.set(type, value);
  }
  return result;
}
