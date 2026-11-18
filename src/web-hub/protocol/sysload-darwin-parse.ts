/**
 * Darwin sysload parsers — pure text → values, ZERO imports of any form
 * (sysload darwin-plan §2.5 / §3.1-S0; boundary-pinned in tests/web-hub/boundary.test.ts).
 *
 * Everything here is a strictly-validated pure function: garbage in ⇒ `undefined` / dropped
 * line / empty result, never a guess. The macOS sources they decode:
 * - `sysctl -n vm.loadavg kern.memorystatus_level hw.ncpu` (one bounded subprocess, three
 *   non-empty lines; a bad line only drops ITS OWN field, see parseDarwinSysctl);
 * - `mount(8)` output (`<source> on <mountpoint> (<fstype>, opt, …)`);
 * - `ps -A -o pid=,pcpu=,rss=,comm=` (top source; `comm` last so it is not truncated to 16
 *   chars — the first three columns are whitespace-separated, the rest is the whole path).
 *
 * Bounded by design: mount text is capped at 1 MiB / 10 000 lines (over the cap ⇒ empty,
 * matching the sampler's Linux mountinfo cap); ps rows are capped by the caller's maxPids.
 * `mountId`/`majorMinor` are deliberate placeholders ("0:0" / 0) — the real per-mount
 * identity comes from `fs.stat().dev` (deviceOf) AFTER a mount is proven local, because
 * stat-ing remote volumes would touch them (darwin-plan §2.5 discipline).
 *
 * Structural note: DarwinMount/DarwinProc mirror the C0 `SamplerHostMount`/`HostProcess`
 * shapes (darwin-plan §2.2) WITHOUT importing sysload — the boundary closure pins this file
 * to zero imports, type-only included.
 */
export interface DarwinMount {
  // = MountInfoRecord's field set (structural mirror of C0 SamplerHostMount).
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

export interface DarwinProc {
  pid: number;
  comm: string;
  /** macOS `ps pcpu` — kernel-decayed average, single-core percent (may exceed 100). */
  cpuPct: number;
  rssBytes: number;
}

/** Local filesystem types sampled for disk; everything else (nfs/smbfs/afpfs/autofs/devfs/…) is `skipped:"remote"`. */
export const DARWIN_LOCAL_FILESYSTEMS: ReadonlySet<string> = new Set(["apfs", "hfs", "exfat", "msdos", "zfs"]);

const MAX_MOUNT_BYTES = 1024 * 1024;
const MAX_MOUNT_LINES = 10_000;
const MAX_COMM_CHARS = 128;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/g;
const MOUNT_LINE_RE = /^(.+?) on (\/.*) \(([^()]*)\)$/;

/** `{ 2.35 2.36 2.38 }` — braces REQUIRED (the Linux form without them must not parse), exactly three finite non-negative numbers. */
export function parseVmLoadavg(text: string): readonly [number, number, number] | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}") || trimmed.length < 2) return undefined;
  const inner = trimmed.slice(1, -1).trim();
  if (inner === "") return undefined;
  const fields = inner.split(/\s+/);
  if (fields.length !== 3) return undefined;
  const values = fields.map(Number);
  if (values.some((v) => !Number.isFinite(v) || v < 0)) return undefined;
  return values as [number, number, number];
}

/** `kern.memorystatus_level` — decimal integer 0..100 (percent). Hex/floats/garbage ⇒ undefined. */
export function parseMemorystatusLevel(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isInteger(value) && value >= 0 && value <= 100 ? value : undefined;
}

/** `hw.ncpu` — decimal integer 1..4096. */
export function parseHwNcpu(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isInteger(value) && value >= 1 && value <= 4096 ? value : undefined;
}

/**
 * The combined `sysctl -n vm.loadavg kern.memorystatus_level hw.ncpu` output: exactly three
 * non-empty lines (line 1 = loadavg, 2 = memorystatus, 3 = ncpu). A different non-empty-line
 * count ⇒ `{}` (the whole reading is void, matching "non-zero exit ⇒ 整次作废" upstream);
 * with three lines present, a bad line only drops its own field (fields are independent — C0).
 */
export function parseDarwinSysctl(text: string): {
  loadavg?: readonly [number, number, number];
  memAvailPct?: number;
  cores?: number;
} {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length !== 3) return {};
  const loadavg = parseVmLoadavg(lines[0] ?? "");
  const memAvailPct = parseMemorystatusLevel(lines[1] ?? "");
  const cores = parseHwNcpu(lines[2] ?? "");
  return {
    ...(loadavg === undefined ? {} : { loadavg }),
    ...(memAvailPct === undefined ? {} : { memAvailPct }),
    ...(cores === undefined ? {} : { cores }),
  };
}

/**
 * `mount(8)` output, line by line: `<source> on <mountpoint> (<fstype>, opt, …)`.
 * Non-matching lines are dropped; over 1 MiB or 10 000 lines ⇒ empty (bounded input).
 * `mountId`/`majorMinor` stay placeholders — only the host's deviceOf may fill them in, and
 * only for mounts already proven local (never stat remote volumes).
 */
export function parseDarwinMount(text: string): DarwinMount[] {
  if (Buffer.byteLength(text) > MAX_MOUNT_BYTES) return [];
  const lines = text.split(/\r?\n/);
  if (lines.length > MAX_MOUNT_LINES) return [];
  const mounts: DarwinMount[] = [];
  for (const line of lines) {
    if (line.length === 0) continue;
    const match = MOUNT_LINE_RE.exec(line);
    if (match === null) continue;
    const inner = match[3]!.trim();
    if (inner === "") continue;
    const options = inner.split(",").map((token) => token.trim());
    const fstype = options[0]!;
    if (fstype === "") continue;
    mounts.push({
      mountId: 0,
      parentId: 0,
      majorMinor: "0:0",
      root: "/",
      mountPoint: match[2]!,
      mountOptions: options.slice(1),
      optionalFields: [],
      fstype,
      source: match[1]!,
      superOptions: [],
    });
  }
  return mounts;
}

function sanitizeComm(path: string): string {
  const base = path.split("/").pop() ?? path;
  const cleaned = base.replace(CONTROL_CHARS_RE, "?");
  return cleaned.length > MAX_COMM_CHARS ? cleaned.slice(0, MAX_COMM_CHARS) : cleaned;
}

/**
 * `ps -A -o pid=,pcpu=,rss=,comm=` output. First three columns whitespace-separated, the
 * remainder is the full command path (spaces/parens intact). Malformed rows are dropped;
 * once `maxPids` valid rows are collected the scan stops with `truncated: true`.
 * `rssBytes` is already KiB×1024; `cpuPct` is the kernel-decayed single-core percent.
 */
export function parsePsTop(text: string, maxPids: number): { procs: readonly DarwinProc[]; truncated: boolean } {
  const cap = Number.isInteger(maxPids) && maxPids > 0 ? maxPids : 0;
  const procs: DarwinProc[] = [];
  let truncated = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    const fields = line.split(/\s+/);
    if (fields.length < 4) continue;
    const pid = Number(fields[0]);
    const cpuPct = Number(fields[1]);
    const rssKiB = Number(fields[2]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (!Number.isFinite(cpuPct) || cpuPct < 0) continue;
    if (!Number.isInteger(rssKiB) || rssKiB < 0) continue;
    const rssBytes = rssKiB * 1024;
    if (!Number.isFinite(rssBytes)) continue;
    if (procs.length >= cap) {
      truncated = true;
      break;
    }
    procs.push({ pid, comm: sanitizeComm(fields.slice(3).join(" ")), cpuPct, rssBytes });
  }
  return { procs, truncated };
}
