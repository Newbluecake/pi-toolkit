import { readRegular, replaceAtomic, statRegularIfExists, writeTempRegular, fsyncDir } from "../safe-fs.js";
import { MemoryError } from "../paths.js";
export interface BlocksStateV1 {
  v: 1;
  gen: number;
  overBudgetStreak: number;
  lastOutcome?: "committed" | "over-budget" | "aborted" | "drift" | "superseded-by-other";
  lastAt?: string;
}
export interface BlocksHoldV1 {
  v: 1;
  at: string;
  reason: "rollback" | "manual";
  gen: number;
  rollback?: { from: "blocks"; to: string; done: boolean };
}
const integer = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
export function readBlocksState(memDir: string): BlocksStateV1 {
  try {
    const p = JSON.parse(readRegular(memDir, ".blocks-state.json").text) as BlocksStateV1;
    if (
      p.v !== 1 ||
      (p.gen !== undefined && !integer(p.gen)) ||
      (p.overBudgetStreak !== undefined && !integer(p.overBudgetStreak))
    )
      throw new Error("invalid blocks state");
    return {
      v: 1,
      gen: integer(p.gen) ? p.gen : 0,
      overBudgetStreak: integer(p.overBudgetStreak) ? p.overBudgetStreak : 0,
      ...(["committed", "over-budget", "aborted", "drift", "superseded-by-other"].includes(p.lastOutcome ?? "")
        ? { lastOutcome: p.lastOutcome! }
        : {}),
      ...(typeof p.lastAt === "string" ? { lastAt: p.lastAt } : {}),
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { v: 1, gen: 0, overBudgetStreak: 0 };
    // A damaged generation must not silently become an old valid generation.
    throw new MemoryError(`E_STATE: cannot read blocks state: ${String(err)}`);
  }
}
function write(memDir: string, name: string, value: unknown): void {
  const tmp = writeTempRegular(memDir, name, Buffer.from(JSON.stringify(value) + "\n"), 0o600);
  replaceAtomic(memDir, tmp, name);
  fsyncDir(memDir);
}
export function writeBlocksStateLocked(memDir: string, next: BlocksStateV1): void {
  if (!integer(next.gen) || !integer(next.overBudgetStreak) || next.gen < readBlocksState(memDir).gen)
    throw new MemoryError("E_STATE: generation cannot decrease");
  write(memDir, ".blocks-state.json", next);
}
export function readHold(memDir: string): BlocksHoldV1 | undefined {
  try {
    if (!statRegularIfExists(memDir, ".blocks-hold")) return undefined;
    const p = JSON.parse(readRegular(memDir, ".blocks-hold").text) as BlocksHoldV1;
    if (p.v !== 1 || typeof p.at !== "string" || !integer(p.gen) || !["rollback", "manual"].includes(p.reason))
      throw new Error("invalid hold");
    if (
      p.rollback &&
      (p.rollback.from !== "blocks" ||
        !/^\.blocks-rolledback-[A-Za-z0-9._-]+$/.test(p.rollback.to) ||
        typeof p.rollback.done !== "boolean")
    )
      throw new Error("invalid rollback");
    return p;
  } catch {
    // Deliberately return a held sentinel, never absence, for corrupt/symlink holds.
    return { v: 1, at: "", reason: "manual", gen: 0 };
  }
}
export function writeHoldLocked(memDir: string, hold: BlocksHoldV1): void {
  if (!integer(hold.gen)) throw new MemoryError("E_STATE: invalid hold generation");
  write(memDir, ".blocks-hold", hold);
}
