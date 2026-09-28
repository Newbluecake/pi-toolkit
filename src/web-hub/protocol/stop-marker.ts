/**
 * Stop marker (plan §6.7.2, package C8 owns the real implementation).
 *
 * C0 only freezes the shape — `StopMarker` / `StopMarkerRead` — so
 * `agent/admin-cmds.ts` and `hub/*` can be typed against it before C8 lands.
 * The functions below are intentionally inert (no filesystem I/O): C8
 * replaces them with the real three-state read (absent / stopped / unknown,
 * including the owner-uid check) and the atomic write/remove.
 */
export interface StopMarker {
  v: 1;
  at: number;
  pid: number;
  by: string;
}

export type StopMarkerRead =
  { state: "absent" } | { state: "stopped"; at?: number } | { state: "unknown"; code: string };

/** Stub: always reports no marker. C8 implements the real three-state read. */
export async function readStopMarker(_file: string): Promise<StopMarkerRead> {
  return { state: "absent" };
}

/** Stub: no-op. C8 implements the atomic write. */
export async function writeStopMarker(_file: string, _marker?: StopMarker): Promise<void> {}

/** Stub: no-op. C8 implements the atomic removal (ENOENT treated as success). */
export async function removeStopMarker(_file: string): Promise<void> {}
