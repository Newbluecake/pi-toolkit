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

function tempName(file: string): string {
  return `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
}
function syncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, constants.O_RDONLY);
    fsyncSync(fd);
  } catch {
    /* best effort */
  } finally {
    if (fd !== undefined)
      try {
        closeSync(fd);
      } catch {
        /* best effort */
      }
  }
}
function atomicJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = tempName(file);
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, file);
    syncDir(dirname(file));
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
      /* already renamed */
    }
  }
}
function valid(value: unknown): value is RotateIntent {
  if (value === null || typeof value !== "object") return false;
  const x = value as Record<string, unknown>;
  return (
    x.v === 1 &&
    typeof x.id === "string" &&
    /^[0-9a-f]{32}$/i.test(x.id) &&
    typeof x.at === "number" &&
    Number.isFinite(x.at) &&
    (x.by === "agent" || x.by === "hub") &&
    typeof x.pid === "number" &&
    Number.isInteger(x.pid) &&
    (x.phase === "intent" || x.phase === "token-written")
  );
}

export function readRotateIntentSync(file: string): IntentRead {
  try {
    const st = lstatSync(file);
    if (!st.isFile() || st.uid !== (process.getuid?.() ?? st.uid)) return { state: "unreadable", code: "E_OWNER" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return { state: "unreadable", code: "E_PARSE" };
    }
    return valid(parsed) ? { state: "present", intent: parsed } : { state: "unreadable", code: "E_PARSE" };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? { state: "absent" } : { state: "unreadable", code: code ?? "EIO" };
  }
}
export async function readRotateIntent(file: string): Promise<IntentRead> {
  return readRotateIntentSync(file);
}
export function writeRotateIntentSync(file: string, intent: RotateIntent): void {
  atomicJson(file, intent);
}
export async function writeRotateIntent(file: string, intent: RotateIntent): Promise<void> {
  writeRotateIntentSync(file, intent);
}
export function removeRotateIntentSync(file: string): void {
  try {
    unlinkSync(file);
    syncDir(dirname(file));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
export async function removeRotateIntent(file: string): Promise<void> {
  removeRotateIntentSync(file);
}

export function advanceRotateIntentSync(
  file: string,
  intent: RotateIntent,
  phase: RotateIntent["phase"],
): RotateIntent {
  const next = { ...intent, phase };
  writeRotateIntentSync(file, next);
  return next;
}
