/**
 * Rotate-intent marker (plan §6.7.1, package C8 owns the real implementation).
 *
 * C0 only freezes the shape — `RotateIntent` / `IntentRead` — so `agent/admin-cmds.ts`
 * and `hub/*` can be typed against it before C8 lands. The functions below are
 * intentionally inert (no filesystem I/O): C8 replaces them with the atomic
 * temp-file + rename + fsync sequence and the three-state read (absent /
 * present / unreadable) described in the plan.
 */
export interface RotateIntent {
  v: 1;
  id: string; // 16B hex
  at: number;
  by: "agent" | "hub";
  pid: number;
  phase: "intent" | "token-written";
}

export type IntentRead =
  { state: "absent" } | { state: "present"; intent: RotateIntent } | { state: "unreadable"; code: string };

/** Stub: always reports no intent in flight. C8 implements the real read. */
export async function readRotateIntent(_file: string): Promise<IntentRead> {
  return { state: "absent" };
}

/** Stub: no-op. C8 implements the atomic write (tmp + fsync + rename). */
export async function writeRotateIntent(_file: string, _intent: RotateIntent): Promise<void> {}

/** Stub: no-op. C8 implements the atomic removal (ENOENT treated as success). */
export async function removeRotateIntent(_file: string): Promise<void> {}
