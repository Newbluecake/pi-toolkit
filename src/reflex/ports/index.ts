/**
 * jev-reflex · four read-only ports (plan R2a).
 * R2a′ delegates all timer/deadline racing to `core/budget.ts`.
 *
 * pi-free (value-closure gate in tests/boundary/pi-free.test.ts, plan PD4): dependency types are
 * `import type` only. Port iron rules (arch §4.6): no network, no disk writes, no manager mutation.
 */
import type { Clock } from "../../core/clock.js";
import { raceBudget } from "../core/budget.js";
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
 * Never throws. The unified race owns deadline clamping, timers and abort listeners.
 * Wrap port failures first: raceBudget intentionally treats raw rejections as timeout,
 * whereas a failed port must remain error/exception. Only this adapter adds reasons.
 */
export async function executePort(port: ReflexPort, env: PortEnv, clock: Clock): Promise<ExecOutcome> {
  try {
    if (env.signal.aborted) return { kind: "error", reason: "aborted" };
    // Avoid starting any read for an invalid budget; deadline arithmetic lives in raceBudget.
    if (!(env.budgetMs > 0)) return { kind: "timeout", reason: "budget" };
    const operation: Promise<PortOutcome> = Promise.resolve()
      .then(() => (env.signal.aborted ? { kind: "error" as const, reason: "aborted" } : port.run(env)))
      .catch(() => ({ kind: "error", reason: "exception" }));
    const outcome = await raceBudget(operation, env.budgetMs, clock, env.signal);
    if (outcome.kind === "timeout") {
      return env.signal.aborted ? { kind: "error", reason: "aborted" } : { kind: "timeout", reason: "budget" };
    }
    return outcome;
  } catch {
    return { kind: "error", reason: "exception" };
  }
}
