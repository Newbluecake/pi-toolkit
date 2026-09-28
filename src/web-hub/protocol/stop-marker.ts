import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

export interface StopMarker {
  v: 1;
  at: number;
  pid: number;
  by: string;
}
export type StopMarkerRead =
  { state: "absent" } | { state: "stopped"; at?: number } | { state: "unknown"; code: string };
function atomic(file: string, marker: StopMarker): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeSync(fd, `${JSON.stringify(marker)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, file);
    let dirFd: number | undefined;
    try {
      dirFd = openSync(dirname(file), constants.O_RDONLY);
      fsyncSync(dirFd);
    } catch {
      /* best effort */
    } finally {
      if (dirFd !== undefined)
        try {
          closeSync(dirFd);
        } catch {
          /* best effort */
        }
    }
  } finally {
    if (fd !== undefined)
      try {
        closeSync(fd);
      } catch {
        /* best effort */
      }
    try {
      unlinkSync(tmp);
    } catch {
      /* renamed */
    }
  }
}
export function readStopMarkerSync(file: string): StopMarkerRead {
  try {
    const st = lstatSync(file);
    if (!st.isFile()) return { state: "unknown", code: "E_NOT_REGULAR" };
    if (st.uid !== (process.getuid?.() ?? st.uid)) return { state: "unknown", code: "E_OWNER" };
    // Presence is the stop intent. Corrupt content remains stopped, per §6.7.2.
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      return { state: "stopped", ...(typeof raw.at === "number" ? { at: raw.at } : {}) };
    } catch {
      return { state: "stopped" };
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? { state: "absent" } : { state: "unknown", code: code ?? "EIO" };
  }
}
export async function readStopMarker(file: string): Promise<StopMarkerRead> {
  return readStopMarkerSync(file);
}
export function writeStopMarkerSync(
  file: string,
  marker: StopMarker = { v: 1, at: Date.now(), pid: process.pid, by: "agent" },
): void {
  atomic(file, marker);
}
export async function writeStopMarker(file: string, marker?: StopMarker): Promise<void> {
  writeStopMarkerSync(file, marker);
}
export function removeStopMarkerSync(file: string): void {
  try {
    unlinkSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
export async function removeStopMarker(file: string): Promise<void> {
  removeStopMarkerSync(file);
}
