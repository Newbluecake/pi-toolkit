/**
 * jev-reflex · four read-only ports (plan R2a).
 * R2a′ converges the temporary budget race below into `core/budget.ts`.
 *
 * pi-free (value-closure gate in tests/boundary/pi-free.test.ts, plan PD4): dependency types are
 * `import type` only. Port iron rules (arch §4.6): no network, no disk writes, no manager mutation.
 */
import type { Clock, TimerHandle } from "../../core/clock.js";
import { clampSpanMs } from "../../core/deadline.js";
import { createJobsPort } from "./jobs.js";
import { createFleetPort } from "./fleet.js";
import { createQuotaPort } from "./quota.js";
import { createGitPort } from "./git.js";
import type { JobRecord } from "../../bash/types.js";
import type { QueryService } from "../../service/query-service.js";
import type { QuotaService } from "../../quota/service.js";
import type { GitRunner } from "../../git/run.js";
import type { Capability, ExecOutcome, PortEnv, PortId, PortOutcome } from "../core/types.js";

export interface ReflexPort {
  id: PortId;
  version: number;
  run(env: PortEnv): PortOutcome | Promise<PortOutcome>;
}

export interface ReflexPortDeps {
  bashJobs: () => { list(): readonly JobRecord[] } | undefined;
  fleet: () => Pick<QueryService, "list"> | undefined;
  quota: () => Pick<QuotaService, "verdicts"> | undefined;
  git: GitRunner;
  /** R4. */
  sessionDir?: () => string | undefined;
}

export interface PortRegistry {
  get(id: PortId): ReflexPort | undefined;
  capabilities(): ReadonlySet<Capability>;
}

export function createPortRegistry(deps: ReflexPortDeps): PortRegistry {
  const ports = new Map<PortId, ReflexPort>(
    [createJobsPort(deps), createFleetPort(deps), createQuotaPort(deps), createGitPort(deps)].map((p) => [p.id, p]),
  );
  return {
    get: (id) => ports.get(id),
    capabilities: () => {
      const caps = new Set<Capability>(["git"]);
      if (deps.bashJobs() !== undefined) caps.add("bashJobs");
      if (deps.fleet() !== undefined) caps.add("fleet");
      if (deps.quota() !== undefined) caps.add("quota");
      return caps;
    },
  };
}

/**
 * Never throws. Temporary R2a race (only core clock/deadline; R2a′ replaces it).
 * Clock owns unref/segmentation. Late rejection is consumed; abort listeners and
 * timers are removed on every settlement. The original signal reaches the port.
 */
export async function executePort(port: ReflexPort, env: PortEnv, clock: Clock): Promise<ExecOutcome> {
  try {
    if (env.signal.aborted) return { kind: "error", reason: "aborted" };
    const span = clampSpanMs(Math.min(env.budgetMs, 1200));
    if (span === undefined) return { kind: "timeout", reason: "budget" };
    return await new Promise<ExecOutcome>((resolve) => {
      let done = false;
      let timer: TimerHandle | undefined;
      const finish = (outcome: ExecOutcome) => {
        if (done) return;
        done = true;
        // Even a broken injected clock must not turn settlement into an unhandled rejection/hang.
        try {
          if (timer !== undefined) clock.clearTimer(timer);
        } catch {
          outcome = { kind: "error", reason: "exception" };
        }
        env.signal.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      const onAbort = () => finish({ kind: "error", reason: "aborted" });
      env.signal.addEventListener("abort", onAbort, { once: true });
      try {
        timer = clock.setTimer(span, () => finish({ kind: "timeout", reason: "budget" }));
        if (done) {
          clock.clearTimer(timer);
          return;
        }
      } catch {
        finish({ kind: "error", reason: "exception" });
        return;
      }
      if (env.signal.aborted) {
        onAbort();
        return;
      }
      // Run in a microtask: catches synchronous throws/hostile thenables as well as rejections.
      Promise.resolve()
        .then(() => (done ? { kind: "error" as const, reason: "aborted" } : port.run(env)))
        .then(
          (outcome) => finish(outcome),
          () => finish({ kind: "error", reason: "exception" }),
        );
    });
  } catch {
    return { kind: "error", reason: "exception" };
  }
}
