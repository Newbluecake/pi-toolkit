/**
 * hub write-endpoint request deadlines (plan §3.3, D16, C3): a request-scoped absolute deadline
 * created once at arrival (`createReqDeadline`), plus the pure derivation formulas that turn
 * "however much of that budget is left right now" into each downstream step's own bound —
 * `deriveBudget`/`computeAgentBudgets` never read a clock themselves, so the nesting invariant
 * (`agentDeadlineMs <= registryWaitMs <= remaining <= WRITE_TOTAL_MS`) is exercised directly with
 * fake, randomized `remaining` values (`tests/web-hub/hub/deadline-nesting.test.ts`) without ever
 * spinning up a real timer.
 */

/** §3.3: the absolute per-request budget every write endpoint (`/api/cmd`, `/api/dialog`) is
 * bounded by, measured from arrival. */
export const WRITE_TOTAL_MS = 13_000;
/** §3.3 step ④: write-endpoint body-read budget, `min(BODY_CAP_MS, remaining - BODY_RESERVE_MS)`
 * (distinct from `http.ts`'s existing fixed `BODY_DEADLINE_MS` used by read endpoints). */
export const BODY_CAP_MS = 4_000;
export const BODY_RESERVE_MS = 5_000;
/** §3.3 step ⑤: below this much remaining budget, the request is rejected before ever building or
 * sending a `CmdFrame` (`effect: "none"`). */
export const FORWARD_MIN_REMAINING_MS = 3_000;
/** §3.3 step ⑦: `CmdFrame.deadlineMs`, `min(AGENT_TOTAL_CAP_MS, remaining - AGENT_TOTAL_RESERVE_MS)`. */
export const AGENT_TOTAL_CAP_MS = 8_000;
export const AGENT_TOTAL_RESERVE_MS = 1_500;
/** §3.3 step ⑥: `registry.request()`'s own wait, `min(deadlineMs + REGISTRY_WAIT_GRACE_MS,
 * remaining - REGISTRY_WAIT_RESERVE_MS)`. */
export const REGISTRY_WAIT_GRACE_MS = 1_000;
export const REGISTRY_WAIT_RESERVE_MS = 300;

/** §3.3 step ② (C3 P1 fix): LAN `touchSession` races against `min(LAN_AUTH_CAP_MS, remaining -
 * LAN_AUTH_RESERVE_MS)` of the write-endpoint's own `ReqDeadline`, so a hung/slow db can never
 * silently consume the whole 13s budget before body/router/agent even get a chance to run. */
export const LAN_AUTH_CAP_MS = 3_000;
export const LAN_AUTH_RESERVE_MS = 7_000;

export interface ReqDeadline {
  readonly at: number;
  remaining(): number;
  expired(): boolean;
}

export function createReqDeadline(now: () => number, totalMs: number = WRITE_TOTAL_MS): ReqDeadline {
  const at = now() + Math.max(0, totalMs);
  return { at, remaining: () => Math.max(0, at - now()), expired: () => now() >= at };
}

export async function raceDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      const t = setTimeout(() => reject(new Error("E_DEADLINE")), Math.max(0, ms));
      t.unref();
    }),
  ]);
}

/** `max(0, min(cap, remaining - reserve))` — the one formula every §3.3 step budget is built from. */
export function deriveBudget(remaining: number, cap: number, reserve: number): number {
  return Math.max(0, Math.min(cap, remaining - reserve));
}

export interface AgentBudgets {
  /** §3.3 step ⑦: sent to the agent as `CmdFrame.deadlineMs`. */
  agentDeadlineMs: number;
  /** §3.3 step ⑥: `registry.request()`'s own wait timeout. */
  registryWaitMs: number;
}

/** Pure derivation of steps ⑥/⑦ from "remaining budget right now" (captured once, at the instant
 * the frame is about to be sent — §3.3's "发帧瞬间计算"). Algebraically `agentDeadlineMs <=
 * registryWaitMs` always holds because `AGENT_TOTAL_RESERVE_MS (1500) > REGISTRY_WAIT_RESERVE_MS
 * (300)`: the agent budget is squeezed harder than the registry wait, so the wait always has at
 * least as much room. */
export function computeAgentBudgets(remaining: number): AgentBudgets {
  const agentDeadlineMs = deriveBudget(remaining, AGENT_TOTAL_CAP_MS, AGENT_TOTAL_RESERVE_MS);
  const registryWaitMs = deriveBudget(remaining, agentDeadlineMs + REGISTRY_WAIT_GRACE_MS, REGISTRY_WAIT_RESERVE_MS);
  return { agentDeadlineMs, registryWaitMs };
}
