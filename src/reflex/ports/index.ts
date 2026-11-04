/**
 * jev-reflex · ports (plan R0 step 7): INTERFACES + an empty registry factory + the `executePort`
 * signature. R2a fills the four read-only ports; R2a′ converges the budget race into `core/budget.ts`.
 *
 * pi-free (value-closure gate in tests/boundary/pi-free.test.ts, plan PD4): dependency types are
 * `import type` only. Port iron rules (arch §4.6): no network, no disk writes, no manager mutation.
 */
import type { Clock } from "../../core/clock.js";
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

/** R0: empty registry — no port is registered, no capability is advertised. */
export function createPortRegistry(_deps: ReflexPortDeps): PortRegistry {
  return {
    get: () => undefined,
    capabilities: () => new Set<Capability>(),
  };
}

/**
 * Never throws: sync throws and rejections become `{kind:"error"}`, budget expiry becomes `{kind:"timeout"}`,
 * `env.signal` follows shutdown. R0 placeholder — R2a implements it.
 */
export function executePort(_port: ReflexPort, _env: PortEnv, _clock: Clock): Promise<ExecOutcome> {
  return Promise.resolve({ kind: "unavailable", reason: "skeleton" });
}
