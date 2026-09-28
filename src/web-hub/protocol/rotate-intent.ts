import { lstat, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
export interface RotateIntent {
  v: 1;
  id: string;
  at: number;
  by: "agent" | "hub";
  pid: number;
  phase: "intent" | "token-written";
}
export type IntentRead =
  { state: "absent" } | { state: "present"; intent: RotateIntent } | { state: "unreadable"; code: string };
export async function readRotateIntent(file: string): Promise<IntentRead> {
  try {
    const s = await lstat(file);
    if (!s.isFile()) return { state: "unreadable", code: "ENOTFILE" };
    const value = JSON.parse(await readFile(file, "utf8")) as RotateIntent;
    if (value.v !== 1 || typeof value.id !== "string" || (value.phase !== "intent" && value.phase !== "token-written"))
      return { state: "unreadable", code: "EINVAL" };
    return { state: "present", intent: value };
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    return code === "ENOENT"
      ? { state: "absent" }
      : { state: "unreadable", code: typeof code === "string" ? code : "EINVAL" };
  }
}
export async function writeRotateIntent(file: string, intent: RotateIntent): Promise<void> {
  const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temp, JSON.stringify(intent), { mode: 0o600, flag: "wx" });
  await rename(temp, file);
}
export function newRotateIntent(by: RotateIntent["by"], phase: RotateIntent["phase"] = "intent"): RotateIntent {
  return { v: 1, id: randomBytes(16).toString("hex"), at: Date.now(), by, pid: process.pid, phase };
}
export async function removeRotateIntent(file: string): Promise<void> {
  try {
    await unlink(file);
  } catch (e) {
    if ((e as { code?: unknown }).code !== "ENOENT") throw e;
  }
}
