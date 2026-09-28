import { lstat, readFile, unlink, writeFile, rename } from "node:fs/promises";
import { randomBytes } from "node:crypto";
export interface StopMarker {
  v: 1;
  at: number;
  pid: number;
  by: string;
}
export type StopMarkerRead =
  { state: "absent" } | { state: "stopped"; at?: number } | { state: "unknown"; code: string };
export async function readStopMarker(file: string): Promise<StopMarkerRead> {
  try {
    const s = await lstat(file);
    if (!s.isFile()) return { state: "unknown", code: "ENOTFILE" };
    let at: number | undefined;
    try {
      const v = JSON.parse(await readFile(file, "utf8")) as Partial<StopMarker>;
      if (typeof v.at === "number") at = v.at;
    } catch {}
    return at === undefined ? { state: "stopped" } : { state: "stopped", at };
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    return code === "ENOENT"
      ? { state: "absent" }
      : { state: "unknown", code: typeof code === "string" ? code : "EIO" };
  }
}
export async function writeStopMarker(
  file: string,
  marker: StopMarker = { v: 1, at: Date.now(), pid: process.pid, by: "agent" },
): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(marker), { mode: 0o600, flag: "wx" });
  await rename(tmp, file);
}
export async function removeStopMarker(file: string): Promise<void> {
  try {
    await unlink(file);
  } catch (e) {
    if ((e as { code?: unknown }).code !== "ENOENT") throw e;
  }
}
