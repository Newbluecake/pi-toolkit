import { formatDuration } from "../../core/format.js";
import { isTerminalStatus } from "../../core/status.js";
import { displayAgentType } from "../../core/types.js";
import type { ReflexPort, ReflexPortDeps } from "./index.js";

/** A snapshot only: never wait, steer, stop or access a runner. */
export function createFleetPort(deps: ReflexPortDeps): ReflexPort {
  return {
    id: "fleet.status",
    version: 1,
    run(env) {
      const query = deps.fleet();
      if (!query) return { kind: "unavailable", reason: "fleet unavailable" };
      const runs = query.list();
      const counts: Record<string, number> = {
        queued: 0,
        starting: 0,
        running: 0,
        stopping: 0,
        completed: 0,
        failed: 0,
        timed_out: 0,
        aborted: 0,
      };
      for (const run of runs) counts[run.status] = (counts[run.status] ?? 0) + 1;
      const active = runs.filter((run) => !isTerminalStatus(run.status));
      return {
        kind: "ok",
        lines:
          runs.length === 0
            ? []
            : [
                `fleet (${Object.entries(counts)
                  .map(([status, count]) => `${count} ${status}`)
                  .join(", ")}):`,
                ...active
                  .slice(0, 8)
                  .map(
                    (run) =>
                      `${run.diag.label ?? displayAgentType(run.diag.agentType) ?? run.runId} · ${run.status} · ${formatDuration(env.now - (run.diag.startedAt ?? run.diag.enqueuedAt ?? run.diag.createdAt))}`,
                  ),
              ],
        facts: counts,
        truncated: active.length > 8,
      };
    },
  };
}
