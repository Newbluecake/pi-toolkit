import { renderProviderLine } from "../../quota/render.js";
import type { ReflexPort, ReflexPortDeps } from "./index.js";

/** verdicts() already filters untrusted/stale snapshots; never refresh here. */
export function createQuotaPort(deps: ReflexPortDeps): ReflexPort {
  return {
    id: "quota.summary",
    version: 1,
    run(env) {
      const quota = deps.quota();
      if (!quota) return { kind: "unavailable", reason: "quota unavailable" };
      const verdicts = quota.verdicts(env.now);
      if (verdicts.length === 0) return { kind: "uncertain", reason: "no trusted snapshot" };
      return {
        kind: "ok",
        lines: verdicts.map((v) => renderProviderLine(v, env.now)),
        facts: { providers: verdicts.length },
        truncated: false,
      };
    },
  };
}
